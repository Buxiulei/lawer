// app/src/lib/capabilities/families/claims.ts
// D 族：诉求金额（设计稿 §2 D）。算一笔、登记一笔、列清单。
//
// 【算钱不在这里实现】claim_calc 的全部逻辑在 lib/cases/claims，站内 agent 那条句柄
// 调的是**同一个符号** runClaimCalc。这里只做：归属校验 → 建检索器 → 幂等包一层。
// 照着抄第二份的形态是：某次公式修订只改了一处，两条入口都返回 200，
// 用户在网页里看到的金额和自己 agent 算出来的不一样，而没有任何一处报错。
import * as agent from '@/lib/agent';
import * as cases from '@/lib/cases';
import { CALC_KINDS, listClaimsWithTotal, runClaimCalc } from '@/lib/cases/claims';
import * as store from '@/lib/db/agent';
import { DOMAINS } from '@/lib/domains/registry';

import { withClientRef } from '../idempotent';
import { caseIdProp, num } from '../shared';
import type { Capability } from '../registry';

/** 诉求种类的对外枚举：各领域包 calculatorKinds 的并集（tools/list 拿不到案件上下文，
 *  只能给并集；真正落库前按该案件所属领域的词表再校验一次）。 */
const ALL_CLAIM_KINDS = [
  ...new Set(Object.values(DOMAINS).flatMap((p) => p.calculatorKinds)),
];

const CLAIM_STATUSES = ['draft', 'confirmed'] as const;

const clientRefProp = {
  client_ref: {
    type: 'string',
    description: '幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库',
  },
} as const;

export const claimCalc: Capability = {
  name: 'claim_calc',
  family: 'claims',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { clientRef: true, naturalKey: '同案 + 同 kind 一条（改金额是修正，不再记一笔）' },
  title: '计算一笔诉求金额',
  description:
    '按案情算一笔金额并直接落库（同案同 kind 只留一条，再算一次是修正）。' +
    '返回金额、算式 formula、逐步骤 steps、依据 basis（条号 + 逐字原文 + 来源卡 id）与封顶提示。' +
    '**任何要写进文书、说给用户听或拿去谈的金额都必须经它算**，不要自己心算、也不要转述记忆里的数。' +
    '入参缺什么会逐条回一句人话告诉你缺什么（七种算法的必填项互不相同），照着补齐再调一次即可。' +
    '金额单位一律是**分**，且是「应得」不是「到手」。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      kind: { type: 'string', enum: [...CALC_KINDS], description: '算哪一项' },
      inputs: {
        type: 'object',
        description:
          '这一项算法要的输入，键名照服务端回的错误提示填（如 avg_monthly_wage_fen / ' +
          'employed_from / terminated_at / months / anchor_date …）。也可以把它们平铺在顶层。',
        additionalProperties: true,
      },
      evidence_backed: {
        type: 'array',
        items: { type: 'string' },
        description: '哪些输入字段是有证据支撑的（不列的一律标「用户自述」，展示时要说明待核实）',
      },
      ...clientRefProp,
    },
    required: ['case_id', 'kind'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    // 归属校验借 lib/cases 的门（与 case_facts 同一手法）：直接算钱是能跑通的，
    // 但那样这个工具会把金额写进**别人的**案子，而且返回 200、格式完全正常。
    const owned = cases.getCase(db, { caseId, userId: identity.uid, timelineLimit: 1 });
    if (!owned.ok) return owned;

    // inputs 里的键平铺上来，与顶层合并（顶层优先）——两种填法都认，
    // 因为不同客户端对「参数要不要包一层」的习惯不一样，为此回一条错只让对方白跑一轮。
    const inputs =
      typeof args.inputs === 'object' && args.inputs !== null && !Array.isArray(args.inputs)
        ? (args.inputs as Record<string, unknown>)
        : {};
    const merged: Record<string, unknown> = { ...inputs, ...args };

    const env = { db, caseId, searcher: agent.createKnowledgeSearcher() };

    // 【为什么把计算也裹进事务】失败时不能留下台账行：留了的话同一个 client_ref
    // 第二次进来会被当成「已经算过了」，回一个根本不存在的 target。
    // 抛出去让 withClientRef 的事务整段回滚，在外面接住转成 isError。
    class CalcRejected extends Error {}
    let payload: Record<string, unknown> = {};
    let created = false;
    try {
      const done = withClientRef(
        db,
        { caseId, tool: 'claim_calc', clientRef: args.client_ref, keyId: identity.keyId ?? null },
        () => {
          const res = runClaimCalc(merged, env);
          if (!res.ok) throw new CalcRejected(res.error);
          payload = res.payload;
          created = res.created;
          return { table: 'claims', id: res.claimId };
        },
      );
      return done.deduped
        ? {
            ok: true as const,
            claim_id: done.target.id,
            deduped: true,
            note:
              '这个 client_ref 之前已经算过一次，本次没有重复落库。' +
              '要看当时算出来的金额与算式，调 claims_list（calc_json 里是完整快照）。',
          }
        : { ok: true as const, claim_id: done.target.id, created, deduped: false, ...payload };
    } catch (err) {
      if (err instanceof CalcRejected) {
        return {
          ok: false as const,
          status: 400,
          errorCode: 'INVALID_CALC_INPUT',
          message: err.message,
        };
      }
      throw err;
    }
  },
};

export const claimsUpsert: Capability = {
  name: 'claims_upsert',
  family: 'claims',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { clientRef: true, naturalKey: '同案 + 同 kind 一条' },
  title: '登记一条诉求',
  description:
    '登记或修正案件下的一条诉求项（同案同 kind 只有一条，再调是覆盖不是追加）。' +
    '**算得出来的项不要在这里填金额**——它们必须走 claim_calc（那条会带算式、输入快照与依据一起落库）；' +
    '这里只用于登记「用户陈述的数额」一类的项，以及给已有的项补依据 basis。金额单位是分。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      kind: { type: 'string', enum: ALL_CLAIM_KINDS, description: '诉求种类' },
      amount_fen: { type: 'integer', description: '金额，单位分，非负；还没算出来就给 0' },
      basis: { type: 'string', description: '依据（条号、来源卡 id 等），可省略' },
      calc_json: { type: 'string', description: '这个数从哪来、待证状态，JSON 串，可省略' },
      status: { type: 'string', enum: [...CLAIM_STATUSES], description: '默认 draft' },
      ...clientRefProp,
    },
    required: ['case_id', 'kind'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    const owned = cases.getCase(db, { caseId, userId: identity.uid, timelineLimit: 1 });
    if (!owned.ok) return owned;

    // 词表按**这个案件所属领域**取，不按并集：并集是给 tools/list 看的，
    // 拿并集校验等于让一个领域的案子收下另一个领域的诉求种类。
    const pack = DOMAINS[owned.case.domain];
    if (!pack) {
      return {
        ok: false as const,
        status: 500,
        errorCode: 'UNKNOWN_DOMAIN',
        message: `这个案件的领域是「${owned.case.domain}」，但没有对应的领域包，取不到诉求种类词表。`,
      };
    }
    const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
    if (!pack.calculatorKinds.includes(kind)) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'INVALID_KIND',
        message: `kind 只能是 ${pack.calculatorKinds.join(' / ')}`,
      };
    }
    const amountFen = Number(args.amount_fen ?? 0);
    if (!Number.isInteger(amountFen) || amountFen < 0) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'INVALID_AMOUNT',
        message: 'amount_fen 必须是非负整数（单位：分）',
      };
    }
    // 【资金数据不经调用方转述】算得出来的项在这里填数，等于给「要被对方复算的金额」
    // 开一条无算式、无输入快照、无法复算的旁路——填错一位没有任何东西拦得住。
    if ((CALC_KINDS as readonly string[]).includes(kind) && amountFen > 0) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'AMOUNT_REQUIRES_CALC',
        message:
          `${kind} 的金额必须走 claim_calc 计算（它会带算式、输入快照与依据直接落库），不要在这里自己填数。` +
          '本工具只用于登记诉求项与补充依据；要改金额请调 claim_calc。',
      };
    }

    let created = false;
    const done = withClientRef(
      db,
      { caseId, tool: 'claims_upsert', clientRef: args.client_ref, keyId: identity.keyId ?? null },
      () => {
        const row = store.upsertClaim(db, {
          caseId,
          kind,
          amountFen,
          calcJson: typeof args.calc_json === 'string' ? args.calc_json : null,
          basis: typeof args.basis === 'string' ? args.basis : null,
          status: typeof args.status === 'string' && (CLAIM_STATUSES as readonly string[]).includes(args.status)
            ? args.status
            : 'draft',
        });
        created = row.created;
        return { table: 'claims', id: row.id };
      },
    );
    return { ok: true as const, claim_id: done.target.id, created, deduped: done.deduped };
  },
};

export const claimsList: Capability = {
  name: 'claims_list',
  family: 'claims',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  title: '列出诉求清单',
  description:
    '列出案件下的全部诉求项与**合计金额**（合计由服务端算，不要自己把各项加起来——' +
    '这个总数正是拿去跟对方谈的那个数）。每项带 calc_json：那是算这笔钱时的完整快照，可复算。',
  inputSchema: {
    type: 'object',
    properties: { ...caseIdProp },
    required: ['case_id'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    const owned = cases.getCase(db, { caseId, userId: identity.uid, timelineLimit: 1 });
    if (!owned.ok) return owned;
    return { ok: true as const, ...listClaimsWithTotal(db, caseId) };
  },
};
