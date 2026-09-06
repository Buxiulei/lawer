// app/src/lib/capabilities/families/referral.ts
// 转介族（设计稿 §14）：把用户转介到 NBDpsy 心理咨询，以及看这个案子转介过没有。
//
// 【同意在服务端判，不靠 agent 自觉】consent 不为 true 一律拒（CONSENT_REQUIRED），
// 且零写入。让 agent 自己保证"我问过用户了"的形态是：它会在自己认为合适的时候
// 替用户点头——而那次点头没有任何痕迹，事后谁也说不清用户到底有没有同意过。
//
// 【工具说明里带着同意文案的正本】说明不是文档，是 agent 唯一读得到的东西。
// 「会传什么」这张清单只写在网页上的形态是：agent 念的是它自己编的一版。
import * as referral from '@/lib/referral';

import { caseIdProp, num, writeOnce } from '../shared';
import type { Capability } from '../registry';

/** 把同意项拼进工具说明。改数据包字段 ⇒ 改 consent.ts ⇒ 这段说明自动跟着变。 */
const CONSENT_LINES = referral.REFERRAL_CONSENT_ITEMS.map((i) => `${i.field}：${i.label}`).join('；');
const NOT_SHARED_LINES = referral.REFERRAL_NOT_SHARED.join('；');

export const referralCreate: Capability = {
  name: 'referral_create',
  family: 'referral',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { clientRef: true },
  title: '转介到 NBDpsy 心理咨询',
  description:
    '把用户转介给 NBDpsy 的心理咨询。**调之前必须先把下面这段逐项念给用户听，' +
    '得到明确同意再带 consent:true 调**——服务端只认 consent，不认「我觉得他同意了」。\n' +
    `会发过去的：${CONSENT_LINES}。\n` +
    `不会发过去的：${NOT_SHARED_LINES}。\n` +
    '情绪状态摘要由服务端生成并过一道过滤（公司名与事件细节会被替换成「（略）」），' +
    'reason 与 needs 也走同一道过滤，所以不必替用户自我审查，如实写即可。' +
    '返回 status 恒为 pending：发送是异步的，稍后用 referral_list 看它有没有送达。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      reason: { type: 'string', description: '用户为什么想找人聊聊，一句话（会过滤后原样带走）' },
      needs: {
        type: 'array',
        items: { type: 'string' },
        description: '用户的需求，如「情绪疏导」「睡眠」「焦虑」「决策支持」；最多 8 条',
      },
      consent: {
        type: 'boolean',
        description: '用户是否已明确同意本次转介。**必须为 true**，且必须是用户真的说过',
      },
      client_ref: {
        type: 'string',
        description: '幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库',
      },
    },
    required: ['case_id', 'consent'],
  },
  run: async (db, identity, args) => {
    const caseId = num(args.case_id);
    // 同意闸判在**幂等外壳之前**：没同意就不该在写入台账里留下任何一次调用痕迹。
    if (args.consent !== true) return referral.consentFailure();

    // 建包是只读的异步步骤（要问模型），落库是同步的一步——**分开是为了让落库整个装进
    // writeOnce 的事务**。把整段异步塞进事务做不到（better-sqlite3 的事务必须同步），
    // 而在事务外先落库再记台账，正是 shared.writeOnce 头注释里说的那种双写形态。
    const prepared = await referral.prepareReferral(db, {
      caseId,
      userId: identity.uid,
      reason: args.reason,
      needs: args.needs,
      consent: true,
    });
    if (prepared.ok !== true) return prepared;

    return writeOnce(
      db,
      { caseId, tool: 'referral_create', clientRef: args.client_ref, keyId: identity.keyId ?? null },
      () => referral.commitReferral(db, prepared),
      (res) => ({ table: 'referrals', id: res.referral_id }),
    );
  },
};

export const referralList: Capability = {
  name: 'referral_list',
  family: 'referral',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  title: '看这个案子的转介记录',
  description:
    '列出本案发起过的转介与它们的状态：pending 还在等着发出去（last_error 说的是上次为什么没发成）、' +
    'sent 对方已收下（external_ref 是对方那条线索的号）、accepted / declined 是对方后来的回执、' +
    'failed 是重试用尽。**没有记录就是从没转介过**，不要据此推断用户不需要。',
  inputSchema: {
    type: 'object',
    properties: { ...caseIdProp },
    required: ['case_id'],
  },
  run: (db, identity, args) =>
    referral.listReferrals(db, { caseId: num(args.case_id), userId: identity.uid }),
};
