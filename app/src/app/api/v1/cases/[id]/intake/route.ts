// app/src/app/api/v1/cases/[id]/intake/route.ts
// POST 首诊提交：把六步问下来的内容一次性写进这个人自己的案件。
//
// 【为什么单开一条而不是拼 PATCH + 若干 POST】首诊是**一次原子交付**：
// 阶段、公司、金额输入、时间线、诉求、三件事要么一起进去，要么一件都别进。
// 拆成五六个请求时，中间任何一条断了都会留下半截档案，而用户在屏幕上看不出断在哪儿——
// 他只会觉得「我明明填了公司名」。事务在领域层（lib/cases/intake），这里只做壳。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';

const NOT_FOUND = { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) return NextResponse.json(NOT_FOUND, { status: 404 });

  const body = await readJsonBody(req);
  if (!body) {
    return NextResponse.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体格式不正确' },
      { status: 400 },
    );
  }

  const result = cases.submitIntake(getDb(), {
    caseId,
    userId: guard.identity.uid,
    stage: body.stage,
    companyName: body.company_name,
    employedFrom: body.employed_from,
    monthlyWageFen: body.monthly_wage_fen,
    position: body.position,
    contractCount: body.contract_count,
    events: body.events,
    freeText: body.free_text,
    companyDocs: (body.company_docs ?? {}) as Record<string, unknown>,
    companyWording: body.company_wording,
    goals: body.goals,
    bottomLine: body.bottom_line,
  });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json({ ok: true, case_id: caseId, saved: result.result }, { status: 201 });
}
