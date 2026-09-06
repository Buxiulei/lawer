// app/src/lib/capabilities/families/account.ts
// K 族：身份与账户（设计稿 §2 K）。用户自己的 agent 靠这两条回答两个问题：
// 「这个人现在能做什么」（me_get）与「他有哪些没付/已付的单」（quote_list）。
//
// 【为什么要有 me_get】没有它，对方 agent 只能靠**撞闸门**来发现前置条件：
// 让用户填完一整份出证申请，才在最后一步收到 REALNAME_REQUIRED；或者陪用户
// 整理完一段录音，确认时才发现余额不够。这两种失败都发生在用户已经花了力气之后。
// 有了它，「先看一眼再决定要不要引导实名/提示余额」变成一次调用。
//
// 【为什么这里不能写第二份口径】auth_status、余额、会员、存储四个数各自都有既有真源
// （users 表 / lib/billing / memberships / storageAudit）。本文件一个数都不自己算——
// 它只是把四处读出来的数摆在一起。自己算的那一刻，网页上显示的余额和 agent 看到的
// 余额就会在某个边界上不一样，而两处都不会报错。
import { getGongdao } from '@/lib/billing';
import { getMembership } from '@/lib/billing/fulfillment';
import { listServiceQuotes, QUOTE_LIST_LIMIT } from '@/lib/billing/service-quotes';
import { listApiKeys } from '@/lib/db/api-keys';
import * as agentStore from '@/lib/db/agent';
import { getUserStorage } from '@/lib/db/storageAudit';

import { num } from '../shared';
import type { Capability } from '../registry';

export const meGet: Capability = {
  name: 'me_get',
  family: 'account',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  title: '读本人账户状态',
  description:
    '一次读齐：实名状态、会员档与到期时间、余额、存储用量、有没有别的 agent 也连着这个账号。' +
    '**在引导用户做需要实名的动作之前先调它**（auth_status 不是「已实名」就先说清要先实名，' +
    '别让用户白填一整份材料到最后一步才被拒）；在发起要花钱的动作之前也先看一眼 balance。' +
    '不接受任何入参——它读的永远是拿着这把凭据的那个人自己。',
  inputSchema: { type: 'object', properties: {}, required: [] },
  run: (db, identity) => {
    const uid = identity.uid;
    const user = agentStore.findUserIdentity(db, uid);
    const membership = getMembership(db, uid);
    const storage = getUserStorage(db, uid);
    // 「有没有别的 agent 连着」= 名下有没有还启用着的 key。**不看最近用没用过**：
    // 一把三个月没用但仍然启用的 key，对"这个账号还能被别的助手读写吗"这个问题
    // 的答案是"能"。用 last_used_at 判会把它说成"没有连接"。
    const keys = listApiKeys(db, uid).filter((k) => k.enabled === 1);
    return {
      auth_status: user?.auth_status ?? '未认证',
      plan: {
        active: membership.active,
        name: membership.plan,
        expires_at: membership.expiresAt,
      },
      balance: getGongdao(uid, db),
      storage: {
        file_count: storage.file_count,
        file_bytes: storage.file_bytes,
        evidence_count: storage.evidence_count,
        message_count: storage.message_count,
        total_bytes: storage.total_bytes,
      },
      connected_agent: keys.length > 0,
      // 【占位，恒 false】NBDpsy 账号打通与实名互认是设计稿 §14 的事，今天一行都还没接。
      // 之所以现在就把字段放出来而不是等接完再加：对方 agent 的判断分支
      //「要不要引导他去做心理咨询那边的登记」现在就得有个地方可读，
      // 而**缺字段与 false 在对方那里长得不一样**——缺字段会被读成"这个版本不支持"，
      // 于是接通那天对方仍然什么都不做。
      nbdpsy_linked: false,
      note:
        'auth_status 不是「已实名」时，证据固化出证、文书导出、分享这几类动作会被服务端拒；' +
        '余额不足时耗算力的动作会回 GONGDAO_EXHAUSTED，如实把差额告诉用户，不要改小参数重试。',
    };
  },
};

export const quoteList: Capability = {
  name: 'quote_list',
  family: 'account',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  title: '列报价与订单',
  description:
    '列本人**还能确认的报价**与**已确认的订单**：报好价还没确认的（status=open，' +
    '过了 expires_at 就要重新报价）、以及已经确认扣过费的（status=confirmed，' +
    'paid_by 说明是扣的余额还是用的会员额度）。已过期又没确认的不会出现在这里——' +
    '它已经确认不了了，不要拿它的 quote_id 去试。传 case_id 只看某个案子的。',
  inputSchema: {
    type: 'object',
    properties: {
      case_id: { type: 'integer', description: '只看某个案子的报价；不传就看本人全部' },
    },
    required: [],
  },
  run: (db, identity, args) => {
    const asked = num(args.case_id);
    const quotes = listServiceQuotes(db, identity.uid, {
      caseId: Number.isInteger(asked) && asked > 0 ? asked : null,
    });
    return {
      quotes: quotes.map((q) => ({
        quote_id: q.quoteId,
        case_id: q.caseId,
        service: q.service,
        amount: q.amount,
        units: q.units,
        status: q.status,
        expires_at: q.expiresAt,
        confirmed_at: q.confirmedAt,
        paid_by: q.paidBy,
        order_ref: q.orderRef,
      })),
      // 满额时如实说"可能还有"：回一个刚好等于上限的数组而不说明，
      // 对方会把它当成全部，然后据此告诉用户"你只有这些单"。
      truncated: quotes.length >= QUOTE_LIST_LIMIT,
    };
  },
};
