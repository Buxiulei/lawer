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
// 鉴权用 case:write：它会让这个账号在下个月产生一笔月费，与"会花钱的动作"同级。
// 归属校验走 lib/cases 的既有入口——「非本人案件一律当作不存在」是条红线，复制第二份就开始各自演化。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { badRequest, readJsonBody, stringField } from '@/lib/auth/http';
import { WATCH_TIER_GONGDAO, type WatchTier } from '@/lib/billing/pricing';
import * as cases from '@/lib/cases';
import { addWatch } from '@/lib/company/watch';
import { getDb } from '@/lib/db/client';

const NOT_FOUND = { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' };

/** 未知档一律 400，不静默回落 daily：回落会让用户以为自己挑了圈3（0 公道值），下月却按 199 收。 */
function parseTier(raw: unknown): WatchTier | null {
  if (raw === undefined || raw === null) return 'daily';
  return typeof raw === 'string' && raw in WATCH_TIER_GONGDAO ? (raw as WatchTier) : null;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) return NextResponse.json(NOT_FOUND, { status: 404 });

  const owned = cases.getCase(getDb(), { caseId, userId: guard.identity.uid, timelineLimit: 1 });
  if (!owned.ok) return domainFailure(owned);

  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const name = stringField(body, 'name').trim();
  if (!name) {
    return badRequest(
      'WATCH_NAME_EMPTY',
      '要盯的主体名字是空的：盯梢按「案件 + 主体」去重，没有名字就去不了重，' +
        '同一家公司会被重复建、下个月重复收费。请带上这家的全称。',
    );
  }

  const tier = parseTier(body.tier);
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

  const db = getDb();
  const result = addWatch(db, {
    caseId,
    name,
    uscc: stringField(body, 'uscc').trim() || null,
    companyProfileId,
    tier,
  });

  // 去重命中时 addWatch **不改已有那条的 tier**，所以回给页面的档位必须读库里那一行，
  // 不能回显请求里的 tier：那会让页面显示「已按每周档盯着」而库里其实是每日档，
  // 用户下个月收到的是另一个数字，而且页面与账单都各自看着都对。
  const row = db.prepare('SELECT tier FROM company_watches WHERE id=?').get(result.id) as
    | { tier: string }
    | undefined;
  const effectiveTier = (row?.tier ?? tier) as WatchTier;

  return NextResponse.json({
    ok: true,
    watch: {
      id: result.id,
      // created=false 是**连点去重命中**，不是失败：页面据此说「已经在盯了」而不是「又加了一条」。
      created: result.created,
      tier: effectiveTier,
      monthly_gongdao: WATCH_TIER_GONGDAO[effectiveTier] ?? 0,
    },
  });
}
