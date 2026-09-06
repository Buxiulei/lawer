// app/src/app/api/v1/cases/[id]/route.ts
// GET   案件档案 + 最近时间线（对应 MCP 工具 case_get）
// PATCH 更新档案（走 case_update 这一条能力本身，见下方）——
// 与 MCP 工具调的是同一条能力，两条入口行为逐字一致。
import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { invokeCapability } from '@/lib/capabilities/invoke';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

const NOT_FOUND = { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) return apiJson(NOT_FOUND, { status: 404 });

  const url = new URL(req.url);
  const rawLimit = url.searchParams.get('timeline_limit');
  const result = cases.getCase(getDb(), {
    caseId,
    userId: guard.identity.uid,
    timelineLimit: rawLimit === null ? undefined : Number(rawLimit),
  });
  if (!result.ok) return domainFailure(result);

  return apiJson({ ok: true, case: result.case, timeline: result.timeline });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) return apiJson(NOT_FOUND, { status: 404 });

  const body = await readJsonBody(req);
  if (!body) {
    return apiJson(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体格式不正确' },
      { status: 400 },
    );
  }

  // 【为什么不直接调 cases.updateCase】直接调就得在这里把「哪些字段可改」再列一遍。
  // 那份手抄清单此前只列了 stage / goal / bottom_line，而能力那侧早已收下用工基本盘四项——
  // 于是走 REST 的客户端传 monthly_wage_yuan 会拿到 200 且 case 原样返回，没有任何一处报错，
  // 只是那个值从来没落库。现在改成把入参原样交给 case_update 这条能力本身：
  // 字段清单只有 inputSchema 那一份，能力加字段这条端点自动跟上。
  const outcome = await invokeCapability(getDb(), guard.identity, 'case_update', {
    ...body,
    case_id: caseId,
  });
  if (!outcome.ok) return domainFailure(outcome);

  return apiJson({ ok: true, ...outcome.value });
}
