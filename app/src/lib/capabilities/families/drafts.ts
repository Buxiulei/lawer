// app/src/lib/capabilities/families/drafts.ts
// E 族：文书（设计稿 §2 E）。读两条（列表不含正文、按 id 取正文）+ 写一条。
//
// 每条都是薄壳：校验入参形状 → 调 lib/cases → 把结果原样 JSON 化。
// 对外文书缺发出后果的那道闸门在 lib/cases.writeDraft 里（服务端拒收、零写入），
// **不在这里判**：站内对话与这条入口必须是同一道闸，两处各判一次就会有一处先松。
import * as cases from '@/lib/cases';
import { DRAFT_KINDS, OUTBOUND_DRAFT_KINDS } from '@/lib/cases/drafts';
import { LABOR_CAPABILITY_COPY } from '@/lib/domains/labor';

import { caseIdProp, num, writeOnce } from '../shared';
import type { Capability } from '../registry';

/** 对外那几类的名字从清单现取，不在这里抄第二份（抄了就会与闸门用的那份分叉） */
const outboundList = [...OUTBOUND_DRAFT_KINDS].join('/');

export const draftList: Capability = {
  name: 'draft_list',
  family: 'drafts',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/drafts' },
  title: '列出文书',
  description: LABOR_CAPABILITY_COPY.draftListDescription,
  inputSchema: {
    type: 'object',
    properties: { ...caseIdProp },
    required: ['case_id'],
  },
  run: (db, identity, args) => {
    const found = cases.listDrafts(db, { caseId: num(args.case_id), userId: identity.uid });
    if (!found.ok) return found;
    // 正文在这里剥掉：一个案子的几份文书全文加起来能有几万字，塞进工具返回值
    // 会把 agent 的上下文一次占满，而它多半只是想知道"有哪些、哪份是最新的"。
    return {
      ok: true,
      drafts: found.drafts.map((d) => ({
        id: d.id,
        kind: d.kind,
        title: d.title,
        version: d.version,
        status: d.status,
        has_send_consequences: d.send_consequences !== null,
        based_on: d.based_on,
        created_at: d.created_at,
        updated_at: d.updated_at,
      })),
    };
  },
};

export const draftGet: Capability = {
  name: 'draft_get',
  family: 'drafts',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  title: '读文书全文',
  description:
    '按 draft_id 取一份文书的正文、版本号与发出后果说明。' +
    '**改稿前先读它**：拿到的正文就是用户手上那一份，凭记忆重写会把上一稿里用户自己改过的措辞抹掉。',
  inputSchema: {
    type: 'object',
    properties: {
      draft_id: { type: 'integer', description: '文书 id，从 draft_list 取' },
    },
    required: ['draft_id'],
  },
  run: (db, identity, args) => {
    const found = cases.getDraft(db, { userId: identity.uid, draftId: num(args.draft_id) });
    if (!found.ok) return found;
    const d = found.draft;
    return {
      ok: true,
      draft: {
        id: d.id,
        case_id: d.case_id,
        kind: d.kind,
        title: d.title,
        version: d.version,
        status: d.status,
        body: d.content,
        send_consequences: d.send_consequences,
        based_on: d.based_on,
        created_at: d.created_at,
        updated_at: d.updated_at,
      },
    };
  },
};

export const draftWrite: Capability = {
  name: 'draft_write',
  family: 'drafts',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { clientRef: true, naturalKey: '同案 + 同 kind + 同 title ⇒ 落成新版本，不另起一份' },
  title: '起草文书',
  description:
    '把一份文书存进案件档案。同一个案子里 kind 与 title 都相同的再写一次是**新版本**，旧稿留着可回看。' +
    `发给公司的文书（${outboundList}）**必须**同时给 send_consequences 说清发出后果，` +
    '缺了服务端直接拒收、一个字都不写库。改稿时把上一稿的 id 填进 based_on_draft_id。' +
    '存下来的永远是草稿：发不发、什么时候发、怎么送达都由用户决定，系统不会代发。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      kind: { type: 'string', enum: [...DRAFT_KINDS], description: '文书类型' },
      title: { type: 'string', description: '文书标题。同案同 kind 同 title 即视为同一份的新一稿' },
      body: { type: 'string', description: '文书全文。填空位保留【】并附填写说明' },
      send_consequences: {
        type: 'string',
        description:
          '发出后果说明：发出后法律关系会怎么变、对方可能怎么应对、哪些是不可逆的。' +
          `发给公司的文书（${outboundList}）必填，缺了会被拒收。`,
      },
      based_on_draft_id: {
        type: 'integer',
        description: '这一稿是在哪一稿基础上改的（本案内的 draft_id），从零起草则不传',
      },
      client_ref: {
        type: 'string',
        description: '幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库',
      },
    },
    required: ['case_id', 'kind', 'title', 'body'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    return writeOnce(
      db,
      { caseId, tool: 'draft_write', clientRef: args.client_ref, keyId: identity.keyId ?? null },
      () =>
        cases.writeDraft(db, {
          caseId,
          userId: identity.uid,
          kind: args.kind,
          title: args.title,
          body: args.body,
          sendConsequences: args.send_consequences,
          basedOnDraftId: args.based_on_draft_id,
        }),
      (res) => ({ table: 'drafts', id: res.draft.id }),
    );
  },
};
