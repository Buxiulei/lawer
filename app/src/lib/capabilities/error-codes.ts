// app/src/lib/capabilities/error-codes.ts
// 对外错误码表：`/api/manifest` 的 errors 段与接入说明的错误码表都由它生成。
//
// 【为什么只列这些】这里收的是**对方 agent 会拿到并需要分支处理**的码。服务端内部的
// 判据码、评测码、上游故障码不在其列——把它们一并抛给对方，只会让「该重试还是该问用户」
// 这个判断更难做。少一条会让对方碰上没登记的码，多一条会让对方给用户读一句它永远碰不到的话；
// 两种都不好，取的是「对方真会碰上」这条线。
//
// 【回包形状】统一 { ok:false, error_code, message }。**按 error_code 分支，不要按 HTTP
// 状态码分支**：同一个状态码底下挂着好几个语义完全不同的码。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现具体领域的字面量（见 registry.ts 抬头，由 __tests__/registry-guard.test.ts 机检）。
// ─────────────────────────────────────────────────────

/** 错误码的分组，决定接入说明里的排布顺序 */
export type ErrorGroup = 'auth' | 'gate' | 'notfound' | 'input' | 'billing';

export interface ErrorCodeEntry {
  code: string;
  group: ErrorGroup;
  /** HTTP 状态码，只作参考——分支请按 code */
  status: number;
  /** 什么时候会拿到它 */
  when: string;
  /** 拿到之后该怎么办；没有可操作动作的省略 */
  recovery?: string;
}

export const ERROR_GROUPS: Record<ErrorGroup, string> = {
  auth: '凭据与权限',
  gate: '服务端闸门',
  notfound: '找不到对象',
  input: '入参不合法',
  billing: '余额与并发',
};

export const ERROR_CODES: readonly ErrorCodeEntry[] = [
  { code: 'UNAUTHORIZED', group: 'auth', status: 401, when: '没带凭据，或凭据无效／已吊销（两种不区分）', recovery: '让用户回网页设置页取一把新 key' },
  { code: 'FORBIDDEN_SCOPE', group: 'auth', status: 403, when: '凭据有效，但这把 key 没被授予该端点要的权限', recovery: '换一把带该 scope 的 key，或让用户在设置页给它补权限' },
  { code: 'WEB_SESSION_REQUIRED', group: 'auth', status: 403, when: '这条端点只认网页登录态；api key 一律拒（key 不能自我增殖）', recovery: '请用户在网页上做，不要试图用 key 绕' },

  { code: 'REALNAME_REQUIRED', group: 'gate', status: 403, when: '该动作要求用户已完成实名（证据上传、固化出证）；「待审」不算已实名', recovery: '把这一步是干什么的说清楚，请用户在网页上完成实名后再来' },

  { code: 'CASE_NOT_FOUND', group: 'notfound', status: 404, when: '案件不存在，**或不属于本人**——两者刻意不区分', recovery: '先调 case_list 拿本人名下真实的 case_id，不要据此推断编号有效性' },
  { code: 'ACTION_NOT_FOUND', group: 'notfound', status: 404, when: '行动卡 id 不在本案下' },
  { code: 'EVENT_NOT_FOUND', group: 'notfound', status: 404, when: '时间线事件 id 不在本案下' },
  { code: 'EVIDENCE_NOT_FOUND', group: 'notfound', status: 404, when: '证据 id 不存在或不属于本人' },
  { code: 'ORDER_NOT_FOUND', group: 'notfound', status: 404, when: '存证订单号查不到' },
  { code: 'DOSSIER_NOT_FOUND', group: 'notfound', status: 404, when: '公司档案 id 查不到' },
  { code: 'KEY_NOT_FOUND', group: 'notfound', status: 404, when: 'api key id 不在本人名下' },

  { code: 'INVALID_BODY', group: 'input', status: 400, when: '请求体不是合法 JSON，或缺必填字段', recovery: '照 manifest 里该端点的入参重发；不要重试同一份体' },
  { code: 'INVALID_CASE_ID', group: 'input', status: 400, when: 'case_id 不是正整数' },
  { code: 'INVALID_STAGE', group: 'input', status: 400, when: 'stage 不在法定枚举里', recovery: '取值见 case_get 回包里的当前 stage 与工具入参说明' },
  { code: 'INVALID_HAPPENED_AT', group: 'input', status: 400, when: '时间不是 ISO8601，或落在合理区间之外' },
  { code: 'INVALID_KIND', group: 'input', status: 400, when: 'kind 不在该表的法定枚举里' },
  { code: 'INVALID_MONTHLY_WAGE', group: 'input', status: 400, when: '月薪不是正数（单位是**元**，不是分）' },
  { code: 'NO_FIELDS', group: 'input', status: 400, when: '更新类调用一个字段都没传' },
  { code: 'FILE_TOO_LARGE', group: 'input', status: 413, when: '上传文件超过单文件上限' },

  { code: 'GONGDAO_EXHAUSTED', group: 'billing', status: 402, when: '余额不足以完成这次扣费动作', recovery: '把差额如实告诉用户，不要改小参数重试' },
  { code: 'UPLOAD_BUSY', group: 'billing', status: 429, when: '同时进行的上传过多（内存闸门）', recovery: '退避后重试' },
  { code: 'TURN_IN_FLIGHT', group: 'billing', status: 409, when: '本案已有一轮站内对话在跑', recovery: '等上一轮结束，不要并发发起' },
];
