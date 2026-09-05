// app/src/lib/capabilities/families/docs.ts
// J 族：来文与录音（设计稿 §2 J）。公司发来的文件逐条解读，以及录音转写稿的要点归纳。
//
// 【两步报价在工具面上的样子】doc_submit 不带 quote_id 调用 = 只报价（免费，一分不扣），
// 带上 quote_id 再调一次 = 确认扣费并真的开始解读。**同一个工具名两步**而不是两个工具：
// 拆成 doc_quote / doc_confirm 的形态是，agent 学会了直接调后者——而它照样要一个报价号，
// 于是两个工具的说明书都得再讲一遍那件事。
//
// ⚠️ 本目录是共用层：不得出现具体领域的字面量（由 __tests__/registry-guard.test.ts 机检）。
// 带领域措辞的对外文案放 lib/domains/<key>.ts。
import * as docs from '@/lib/docs';

import { caseIdProp, num } from '../shared';
import type { Capability } from '../registry';

/** 依赖缺失（没配可用的模型）不是「这次没做成」，是这台服务器还没配好，回 503 说清楚。 */
function configFailure(err: unknown) {
  return {
    ok: false as const,
    status: 503,
    errorCode: 'LLM_UNAVAILABLE',
    message: `${(err as Error).message}`,
  };
}

export const docSubmit: Capability = {
  name: 'doc_submit',
  family: 'docs',
  scope: 'case:write',
  kind: 'spend',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: ['balance'],
  idempotency: {
    clientRef: true,
    naturalKey: '同一张报价只解读一份来文（不传 client_ref 时按 quote_id 去重）',
  },
  title: '解读对方发来的文件',
  description:
    '把对方发来的文件逐条读一遍：命中的审查规则、有风险的条款（原文引用 + 轻重 + 一句话说明）、' +
    '该怎么改，以及一个总结论（签 / 不签 / 改签 / 待定）。' +
    '**两步**：先不带 quote_id 调一次拿报价（免费，不扣任何费用），确认价钱后带上 quote_id 再调一次才开始解读并扣费。' +
    '来源二选一：evidence_id（已登记的材料，没有文字的会先做一次文字识别，费用已含在同一张报价里）或 text（直接粘原文）。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      evidence_id: { type: 'integer', description: '已登记材料的 id；与 text 二选一' },
      text: { type: 'string', description: '直接粘贴的文件原文；与 evidence_id 二选一' },
      doc_kind: {
        type: 'string',
        enum: [...docs.DOC_KINDS],
        description: '这份文件是什么：按它挑要比对的审查规则集',
      },
      quote_id: {
        type: 'integer',
        description: '上一步拿到的报价号。不给 = 只报价不扣费；给了 = 确认扣费并开始解读',
      },
      client_ref: {
        type: 'string',
        description: '幂等键，重试用同一个值；不给时按 quote_id 去重，同一张报价不会解读两次',
      },
    },
    required: ['case_id', 'doc_kind'],
  },
  run: async (db, identity, args) => {
    let deps;
    try {
      deps = docs.defaultDocReviewDeps();
    } catch (err) {
      return configFailure(err);
    }
    return docs.submitDoc(
      db,
      {
        userId: identity.uid,
        caseId: num(args.case_id),
        keyId: identity.keyId ?? null,
        evidenceId: args.evidence_id === undefined ? undefined : num(args.evidence_id),
        text: typeof args.text === 'string' ? args.text : undefined,
        docKind: typeof args.doc_kind === 'string' ? args.doc_kind : '',
        quoteId: args.quote_id === undefined ? undefined : num(args.quote_id),
        clientRef: typeof args.client_ref === 'string' ? args.client_ref : undefined,
      },
      deps,
    );
  },
};

export const docList: Capability = {
  name: 'doc_list',
  family: 'docs',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/docs' },
  title: '列出已解读的来文',
  description:
    '列出这个案件下已经解读过的对方来文（种类、总结论、有几处风险、时间），**不含原文与逐条发现**——' +
    '那两样用 doc_get 按 doc_id 单取。',
  inputSchema: {
    type: 'object',
    properties: { ...caseIdProp },
    required: ['case_id'],
  },
  run: (db, identity, args) => ({
    ok: true,
    docs: docs.listDocs(db, num(args.case_id), identity.uid),
  }),
};

export const docGet: Capability = {
  name: 'doc_get',
  family: 'docs',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/docs/{id}' },
  title: '取一份来文的解读全文',
  description:
    '按 doc_id 取一份解读：识别出的原文、总结论与理由、逐条发现（引用原文、轻重、依据、怎么改、谈判怎么说）。' +
    '别人的 doc_id 与不存在的 doc_id 同样回「不存在」。',
  inputSchema: {
    type: 'object',
    properties: { doc_id: { type: 'integer', description: '解读结果的 id（doc_list 里的 id）' } },
    required: ['doc_id'],
  },
  run: (db, identity, args) => {
    const doc = docs.getDoc(db, num(args.doc_id), identity.uid);
    return doc
      ? { ok: true, doc }
      : {
          ok: false,
          status: 404,
          errorCode: 'DOC_NOT_FOUND',
          message: `解读 ${args.doc_id} 不存在。先用 doc_list 取本案真实的 doc_id。`,
        };
  },
};

export const transcriptSubmit: Capability = {
  name: 'transcript_submit',
  family: 'docs',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  title: '归纳录音要点并建议事件',
  description:
    '读一件**已经转写好**的录音的文字稿，给出要点，并挑出稿子里说到的事整理成候选事件' +
    '（发生时间 / 类别 / 一句话 / 细节）。' +
    '**这些候选事件不会自动写进档案**：逐条与用户核对（尤其是日期）之后，' +
    '再对确认过的那几条调 timeline_add。还没有转写稿的会明说没有，本工具自己不做转写。',
  inputSchema: {
    type: 'object',
    properties: { evidence_id: { type: 'integer', description: '录音材料的 id' } },
    required: ['evidence_id'],
  },
  run: async (db, identity, args) => {
    let deps;
    try {
      deps = docs.defaultTranscriptDeps();
    } catch (err) {
      return configFailure(err);
    }
    return docs.submitTranscript(db, { userId: identity.uid, evidenceId: num(args.evidence_id) }, deps);
  },
};
