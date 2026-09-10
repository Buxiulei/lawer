// app/src/lib/capabilities/families/referral.ts
// 转介族（设计稿 §14）：把用户转介到 NBDpsy 心理咨询，以及看这个案子转介过没有。
//
// 【同意在服务端判，不靠 agent 自觉】consent 不为 true 一律拒（CONSENT_REQUIRED），
// 且零写入。让 agent 自己保证"我问过用户了"的形态是：它会在自己认为合适的时候
// 替用户点头——而那次点头没有任何痕迹，事后谁也说不清用户到底有没有同意过。
//
// 【工具说明里带着同意文案的正本】说明不是文档，是 agent 唯一读得到的东西。
// 「会传什么」这张清单只写在网页上的形态是：agent 念的是它自己编的一版。
import { findReferralById } from '@/lib/db/referrals';
import { requestReferralDelete } from '@/lib/lifecycle/referral-delete';
import * as referral from '@/lib/referral';
import { defaultSummaryLlm } from '@/lib/referral/summary-llm';

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
      // 【模型在这里注入，不在领域层里挑】领域层不 import lib/llm：packet.ts 的纯函数
      // 会被判据与别处引用，让它自己去挑模型的形态是，任何一处引用都把整个模型层拖进来。
      // 反过来，壳不传的形态更糟：buildPacket 恒走兜底摘要，「模型总结」这件事在生产上
      // 从未发生过，而看起来一切正常（兜底那段话也是通顺的）。
      llm: defaultSummaryLlm(),
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

/**
 * 转介删除请求（协议九.3）。
 *
 * 【为什么它必须是一条能力，而不只是网页上的一个按钮】转介是用户自己的 agent 就能发起的
 * 动作（referral_create）。发得出去、撤不回来的形态是：同一个助手把资料交出去之后，
 * 用户回头说「帮我要求他们删掉」，而它手上没有任何工具，只能告诉用户自己去网页找。
 */
export const referralDeleteRequest: Capability = {
  name: 'referral_delete_request',
  family: 'referral',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  // 不设前置闸：这是撤回一次已经发生的对外披露，任何账号状态下都该做得成。
  precondition: [],
  idempotency: { naturalKey: 'referral_id（同一条转介再提一次原样返回，首次提出时刻不变）' },
  // 入参里没有案件号（转介按自己的 id 定位），而 agent_writes.case_id 是 NOT NULL 外键——
  // 回读那条转介取案件号。**读不到就回空数组**（那条转介在这一瞬被清了），
  // 不拿一个猜出来的案件号占位：占位的那一行会指向别人的案子。
  ledger: {
    targetTable: 'referrals',
    rowsOf: (db, args, result) => {
      const referralId = num(args.referral_id);
      const caseId = findReferralById(db, referralId)?.case_id;
      return caseId === undefined
        ? []
        : [{ caseId, targetId: referralId, deduped: result.already_requested === true }];
    },
  },
  rest: { method: 'POST', path: '/api/v1/referrals/{id}/delete-request' },
  title: '要求删除一条已发出的转介',
  description:
    '替用户提出「请把这条转介的信息删掉」。referral_id 从 referral_list 取。\n' +
    '**回包里的 delivered 今天恒为 false**：我们与对方之间的内部接口目前没有删除通道，' +
    '这条请求先记在我们这边、由人工转达，通道开出来之后会自动补发。' +
    '把 note 原样念给用户听，**不要说成「已经删掉了」**——那是一句我们此刻还证明不了的话。\n' +
    '**幂等**：同一条转介再提一次照样成功，already_requested=true，首次提出的时刻不变。',
  inputSchema: {
    type: 'object',
    properties: {
      referral_id: { type: 'integer', description: '要删除的那条转介 id，从 referral_list 取' },
      reason: { type: 'string', description: '用户为什么要求删除，一句话（可不填）' },
    },
    required: ['referral_id'],
  },
  run: (db, identity, args) =>
    requestReferralDelete({
      db,
      userId: identity.uid,
      referralId: num(args.referral_id),
      reason: args.reason,
    }),
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
