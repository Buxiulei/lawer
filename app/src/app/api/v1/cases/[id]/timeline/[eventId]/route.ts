// app/src/app/api/v1/cases/[id]/timeline/[eventId]/route.ts
// PATCH 补选（或改写）一条时间线事件的**类型**。站内「选类型」那个小操作的后端。
//
// 【为什么这条端点只认网页登录态】时间线的 event_type 是**登记人自己的判断**：
// 这条记录归到哪一格。开给 api key（MCP / 对方 agent）的形态是——模型读完那段自述
// 替用户把类型定了，而要件判定优先读这一格、不再回落到谓词：**模型的归类从此压过服务端的谓词**，
// 且库里看不出这一格是人选的还是模型填的。登记那一条（POST /timeline）开给 agent 是另一回事：
// 那是 agent 把用户说过的事**第一次**记下来，用户还没给过任何判断。改写已有判断不是同一件事。
// 拒法沿用 key 管理那条（WEB_SESSION_REQUIRED / 403），不另立一个码。
//
// 【为什么不记 agent_writes 台账】那张台账记的是**对方 agent 经 API 写了什么**
//（recordAgentWriteFromRest 对 via='jwt' 直接返回，一行都不写）。本端点 via 只可能是 jwt，
// 调它等于每次都走一条恒空的分支——留着会让人以为这条路上的写入是被审计着的。
import { domainFailure, parseId, requireWebSession } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

/**
 * 本端点收的**全部**字段。多一个键一律 400，不静默忽略。
 *
 * 【为什么是 400 而不是"忽略掉照常改类型"】忽略的形态是：调用方按自己的想象发来
 * `{event_type, title}`，回包 200、类型改了、标题没改——他会当成标题也改了，
 * 而时间线正是那份"改不得"的记录（见 lib/cases.setTimelineEventType 抬头）。
 * 一次明确的 400 比一份自以为改过的陈述便宜得多。
 */
const ACCEPTED_FIELDS = ['event_type'] as const;

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  // 【为什么走 requireWebSession 而不是 requireIdentity + 自己判一句 via】
  // 判定只有这一份：路由里各写一遍的形态是口径改了改一处漏一处，而两边都不报错。
  // 网页登录态的 scope 恒为 case:read + case:write（identity.JWT_SCOPES），
  // 所以这道门过了就一定有 case:write，不必再判第二次。
  const guard = requireWebSession(
    getDb(),
    req,
    '改一条已登记事件的类型只认网页登录态，api key 一律拒。' +
      '这一格是登记人自己的判断，而要件判定优先读它、不再回落到谓词——' +
      '让模型改得了它，等于让归类压过服务端的判定。' +
      '把这条记的是什么说给用户听，请他在网页时间线上点「选类型」；' +
      '要补一件新的事，走 POST /api/v1/cases/{id}/timeline。',
  );
  if (!guard.ok) return guard.response;

  const { id, eventId: rawEventId } = await params;
  const caseId = parseId(id);
  const eventId = parseId(rawEventId);
  if (caseId === null) {
    return apiJson(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }
  if (eventId === null) {
    return apiJson(
      { ok: false, error_code: 'EVENT_NOT_FOUND', message: '时间线事件不存在' },
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

  const extra = Object.keys(body).filter(
    (k) => !(ACCEPTED_FIELDS as readonly string[]).includes(k),
  );
  if (extra.length > 0) {
    return apiJson(
      {
        ok: false,
        error_code: 'IMMUTABLE_FIELD',
        message:
          `这条端点只收 ${ACCEPTED_FIELDS.join(' / ')}，而本次请求还带了：${extra.join('、')}。` +
          '时间线只追加不改删——发生在哪天、谁做的、写了什么，落库之后一格都改不了' +
          '（可改即等于可篡改，庭上无法自证）。' +
          '记错了补一条新的：POST /api/v1/cases/{id}/timeline。',
      },
      { status: 400 },
    );
  }

  const result = cases.setTimelineEventType(getDb(), {
    caseId,
    userId: guard.identity.uid,
    eventId,
    eventType: body.event_type,
  });
  if (!result.ok) return domainFailure(result);

  return apiJson({ ok: true, event: result.event });
}
