// app/src/app/api/v1/cases/[id]/watch/route.ts
// POST 一键加守望（spec v3 §2.1 M3「每个节点可一键加入守望」的 HTTP 面）。
//
// 【这条端点不扣钱】建盯梢只落一行 company_watches；真正扣费在
// lib/company/watch-billing 的月度巡检里。所以 tier 是"日后按哪档收费"的承诺，
// 不是这一刻的扣款——页面上要照这个说，别说成"已扣 199"。
//
// 【连点去重在 lib/company/watch.addWatch 里】同案同主体只留一条活跃盯梢，
// 命中已有的原样返回、**不改它的 tier**（改档是另一个显式动作）。路由不自己再写一遍去重。
//
// 【归属校验、档位校验、回读生效档位都在 lib/company/watch.setWatch 里】本路由只做 HTTP 皮。
// 用户自己的 agent 走 company_watch_set 调的是同一个函数，两条路径不会各自演化。
//
// 鉴权用 case:write：它会让这个账号在下个月产生一笔月费，与"会花钱的动作"同级。
// 归属校验走 lib/cases 的既有入口——「非本人案件一律当作不存在」是条红线，复制第二份就开始各自演化。
import { recordAgentWriteFromRest } from '@/lib/audit/agent-writes';
import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { badRequest, readJsonBody, stringField } from '@/lib/auth/http';
import { WATCH_TIER_GONGDAO } from '@/lib/billing/pricing';
import { parseWatchTier, setWatch } from '@/lib/company/watch';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

const NOT_FOUND = { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) return apiJson(NOT_FOUND, { status: 404 });

  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const tier = parseWatchTier(body.tier);
  if (!tier) {
    return badRequest(
      'INVALID_WATCH_TIER',
      `tier 只能是 ${Object.keys(WATCH_TIER_GONGDAO).join(' / ')}。` +
        '写了别的值说明前后端对档位的理解不一致，宁可报错也不静默按默认档建——' +
        '默认档是每日档，会让用户以为自己挑的是不收费那档，下个月却收到月费。',
    );
  }

  const profileIdRaw = body.company_profile_id;
  const companyProfileId =
    typeof profileIdRaw === 'number' && Number.isInteger(profileIdRaw) && profileIdRaw > 0
      ? profileIdRaw
      : null;

  const result = setWatch(getDb(), {
    caseId,
    userId: guard.identity.uid,
    name: stringField(body, 'name').trim(),
    uscc: stringField(body, 'uscc').trim() || null,
    companyProfileId,
    tier,
  });
  if (!result.ok) return domainFailure(result);

  // created=false 是连点去重命中：台账照记一行，但标成 deduped——
  // 不记的形态是「用户到底点了几次守望」在事后查不出来，而这条会产生月费。
  recordAgentWriteFromRest(getDb(), guard.identity, {
    endpoint: '/api/v1/cases/{id}/watch',
    method: 'POST',
    caseId,
    targetTable: 'company_watches',
    targetId: result.watch.id,
    deduped: !result.watch.created,
  });

  return apiJson({
    ok: true,
    watch: {
      id: result.watch.id,
      // created=false 是**连点去重命中**，不是失败：页面据此说「已经在盯了」而不是「又加了一条」。
      created: result.watch.created,
      tier: result.watch.tier,
      monthly_gongdao: result.watch.monthly_gongdao,
    },
  });
}
