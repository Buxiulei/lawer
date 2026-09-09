// app/src/app/api/v1/cases/[id]/timeline/route.ts
// GET  分页读时间线，入参与 MCP 工具 timeline_list 一致（since / kind / limit / offset）。
// POST 追加一条时间线事件（对应 MCP 工具 timeline_add）。只追加，无改无删。
import { recordAgentWriteFromRest } from '@/lib/audit/agent-writes';
import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { assertedByOf } from '@/lib/capabilities/shared';
import * as cases from '@/lib/cases';
import { pageParams, pageResponse } from '@/lib/cases/paging';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) {
    return apiJson(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const { limit, offset } = pageParams(url);
  // 分页与过滤全在 cases.listTimeline（与 timeline_list 同一函数），这里只解析 query
  const result = cases.listTimeline(getDb(), {
    caseId,
    userId: guard.identity.uid,
    since: url.searchParams.get('since') ?? undefined,
    kind: url.searchParams.get('kind') ?? undefined,
    limit,
    offset,
  });
  if (!result.ok) return domainFailure(result);

  return pageResponse('events', { items: result.events, ...result });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) {
    return apiJson(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }

  const body = await readJsonBody(req);
  if (!body) {
    return apiJson(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体格式不正确' },
      { status: 400 },
    );
  }

  const result = cases.addTimelineEvent(getDb(), {
    caseId,
    userId: guard.identity.uid,
    happenedAt: body.happened_at,
    kind: body.kind,
    title: body.title,
    detail: body.detail,
    clientRef: body.client_ref,
    // 【这两格是 S4 加的，专用端点当时没跟上】说明书里 timeline_add 的 REST 列写的就是本端点，
    // 而它此前既不读 source_tier、也不填断言人：
    //  · source_tier 一路消失 —— 调用方照说明书传「书证」，回包 201，库里那行是「自述」；
    //  · asserted_by 走 DDL 默认 user —— api key 写的事件标成用户本人说的，展示层不再标黄。
    // 两种都没有一处会报错。档位收调用方声明（认不出由领域层回 INVALID_SOURCE_TIER），
    // 断言人由外壳按身份判，与 MCP 那条共用 assertedByOf——两条路各判一次必然分叉。
    sourceTier: body.source_tier,
    assertedBy: assertedByOf(guard.identity),
  });
  if (!result.ok) return domainFailure(result);

  // 【client_ref 不进台账】timeline_add 的幂等走的是 timeline_events 自己那一列
  //（早于 agent_writes 落地，见 lib/capabilities/idempotent.ts 抬头），台账这一行只是审计。
  // 把同一个 client_ref 抄进台账会撞上 uq_agent_writes_client_ref——那把索引是能力壳的去重键，
  // 于是**按说明书重放**这条设计内的路径会变成一条 error 日志（唯一入口里第 3 条讲的就是它）。
  // 重放读 deduped 这一列：第二次仍留一行，deduped=1，读得出「这次什么都没新增」。
  recordAgentWriteFromRest(getDb(), guard.identity, {
    endpoint: '/api/v1/cases/{id}/timeline',
    method: 'POST',
    caseId,
    targetTable: 'timeline_events',
    targetId: result.event.id,
    deduped: result.deduped,
  });

  // deduped=true 时这条是既有行（同 client_ref 重放或近重复），没有新插入——回 200；
  // 真新增回 201。调用方据此知道「这条已经记过了」，不必再向用户复述一遍。
  return apiJson(
    { ok: true, event: result.event, deduped: result.deduped },
    { status: result.deduped ? 200 : 201 },
  );
}
