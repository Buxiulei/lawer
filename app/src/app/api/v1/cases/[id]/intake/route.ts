// app/src/app/api/v1/cases/[id]/intake/route.ts
// POST 首诊提交：把六步问下来的内容一次性写进这个人自己的案件。
//
// 【为什么单开一条而不是拼 PATCH + 若干 POST】首诊是**一次原子交付**：
// 阶段、公司、金额输入、时间线、诉求、三件事要么一起进去，要么一件都别进。
// 拆成五六个请求时，中间任何一条断了都会留下半截档案，而用户在屏幕上看不出断在哪儿——
// 他只会觉得「我明明填了公司名」。事务在领域层（lib/cases/intake），这里只做壳。
import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { assertedByOf } from '@/lib/capabilities/shared';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

const NOT_FOUND = { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

  // body 上「哪个键对哪个字段」只写在 lib/cases/intake-params.ts 那一份表里。
  // 在这里再手抄一遍的形态是：领域包的 intakeSchema 多一个字段，页面老实填进请求体，
  // 这里不读它也不报错——那一格一路消失，回包还是 201。
  const result = cases.submitIntake(getDb(), {
    caseId,
    userId: guard.identity.uid,
    ...cases.intakeInputFromBody(body),
    // 【展开之后填，与归属同一条理由】这条路 api key 也走得通（bearer + case:write），
    // 所以断言人同样由外壳按身份判，与 MCP 那条共用 assertedByOf——两条路各判一次的形态是，
    // 其中一条把 agent 写的东西标成用户本人说的，而两条的回包都是 201。
    assertedBy: assertedByOf(guard.identity),
  });
  if (!result.ok) return domainFailure(result);

  return apiJson({ ok: true, case_id: caseId, saved: result.result }, { status: 201 });
}
