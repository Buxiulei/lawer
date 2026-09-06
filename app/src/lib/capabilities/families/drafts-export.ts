// app/src/lib/capabilities/families/drafts-export.ts
// E 族的分享与导出（设计稿 §2 E）。读写两条在 families/drafts.ts。
// 另起文件的理由同 actions-write.ts / evidence-write.ts：并行窗口不动别人在跑的族文件。
//
// 三条都是薄壳：校验入参形状 → 调领域层 → 把结果原样 JSON 化。
// 实名闸**一个字都不在这里判**：它是条目上的 precondition，由 MCP 路由统一拦
// （lib/capabilities/registry.ts 的说明）。各工具在 run 里各写一句的形态是
// 新加一条能力时忘了抄那一句，而它照常返回 200。
import { exportDraft, DRAFT_EXPORT_FORMATS } from '@/lib/drafts/export';
import {
  createShare,
  resolveShareTarget,
  revokeShare,
  SHARE_DEFAULT_HOURS,
  SHARE_MAX_HOURS,
} from '@/lib/shares';

import { num, writeOnce } from '../shared';
import type { Capability } from '../registry';

export const shareCreate: Capability = {
  name: 'share_create',
  family: 'drafts',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: ['realname'],
  idempotency: { clientRef: true, naturalKey: '无自然键：同一份东西可以有多条链接，各自独立到期与撤销' },
  title: '生成免登录分享链接',
  description:
    '为一份文书或一件材料签发一条**免登录只读**链接，谁拿到谁能打开（不需要账号）。' +
    'draft_id 与 evidence_id 恰好给一个：一条链接只分享一份东西，要分享两份就建两条、可分别撤销。' +
    `expires_in 是小时数，不给按 ${SHARE_DEFAULT_HOURS} 小时，上限 ${SHARE_MAX_HOURS} 小时。` +
    '材料类链接只展示名称、分类、证明目的与文件哈希，**不给文件本身**——' +
    '一条免登录地址直连原始文件，被转发一次就等于永久公开。' +
    '改主意了用 share_revoke 立刻收回。需已完成实名认证。',
  inputSchema: {
    type: 'object',
    properties: {
      draft_id: { type: 'integer', description: '要分享的文书 id，从 draft_list 取；与 evidence_id 二选一' },
      evidence_id: { type: 'integer', description: '要分享的材料 id，从 evidence_list 取；与 draft_id 二选一' },
      expires_in: {
        type: 'integer',
        description:
          `有效期小时数（1 到 ${SHARE_MAX_HOURS}）。不给按 ${SHARE_DEFAULT_HOURS} 小时。` +
          '别默认往上限报：链接不带任何凭据，有效期越长，收回的机会越小',
      },
      client_ref: {
        type: 'string',
        description: '幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复签发第二条链接',
      },
    },
    required: [],
  },
  run: (db, identity, args) => {
    const draftId = args.draft_id === undefined || args.draft_id === null ? undefined : num(args.draft_id);
    const evidenceId =
      args.evidence_id === undefined || args.evidence_id === null ? undefined : num(args.evidence_id);
    const expiresIn =
      args.expires_in === undefined || args.expires_in === null ? undefined : num(args.expires_in);

    // 台账要 case_id，而它长在标的行上（草稿/材料各在自己的案子里）。**先解析、再记账**：
    // 把 case_id 当入参问 agent 要的话，它报错一个案号，台账就会把这次写入记到别人的案子名下。
    const target = resolveShareTarget(db, { userId: identity.uid, draftId, evidenceId });
    if (!target.ok) return target;

    // 签发本身在 writeOnce 里面跑：放外面的话，带同一个 client_ref 重试会先真签出第二条链接、
    // 再由台账告诉调用方"这次去重了"——多出来的那条链接谁都不知道，也没人会去撤它。
    return writeOnce(
      db,
      {
        caseId: target.caseId,
        tool: 'share_create',
        clientRef: args.client_ref,
        keyId: identity.keyId ?? null,
      },
      () => createShare(db, { userId: identity.uid, draftId, evidenceId, expiresInHours: expiresIn }),
      (res) => ({ table: 'share_links', id: res.share_id }),
    );
  },
};

export const shareRevoke: Capability = {
  name: 'share_revoke',
  family: 'drafts',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  // 【撤销不设实名闸】签发那一步已经拦过一次（share_create 需实名）。收回是把已经交出去的
  // 东西拿回来，任何时候都不该被一道前置挡住——用户的实名状态哪天变成待审，
  // 他手上那些链接就再也撤不掉了，而那正是他最想撤的时候。
  precondition: [],
  idempotency: { naturalKey: 'share_id（已撤销的再撤一次原样返回，不改首次撤销时点）' },
  title: '撤销分享链接',
  description:
    '立刻作废一条分享链接：此后任何人打开它都只会看到「链接已失效」。' +
    '**幂等**——已经撤销过的再撤一次照样成功，返回 already_revoked=true，首次撤销的时点不变。' +
    '撤销不删记录：谁在什么时候撤了哪一条留得下来。',
  inputSchema: {
    type: 'object',
    properties: {
      share_id: { type: 'integer', description: '分享链接 id，从 share_create 的回包里取' },
    },
    required: ['share_id'],
  },
  run: (db, identity, args) =>
    revokeShare(db, { userId: identity.uid, shareId: num(args.share_id) }),
};

export const draftExport: Capability = {
  name: 'draft_export',
  family: 'drafts',
  scope: 'case:write',
  kind: 'spend',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: ['realname'],
  title: '导出文书 PDF',
  description:
    '把一份文书渲染成 PDF，回一条**一次性、限时**的下载地址（浏览器直接打开即可，不必带凭据）。' +
    `format 目前只支持 ${DRAFT_EXPORT_FORMATS.join(' / ')}。` +
    '导出的是正文原文，不含站内那段「发出前必读」提醒——那段是给起草人自己看的，' +
    '印在要递出去的件上等于把自己的顾虑一起交出去。' +
    '这一步的服务定额目前是 **0 公道值**（回包里仍有报价与金额，便于对账）。需已完成实名认证。',
  inputSchema: {
    type: 'object',
    properties: {
      draft_id: { type: 'integer', description: '要导出的文书 id，从 draft_list 取' },
      format: {
        type: 'string',
        enum: [...DRAFT_EXPORT_FORMATS],
        description: '导出格式，不给按 pdf',
      },
    },
    required: ['draft_id'],
  },
  run: (db, identity, args) =>
    exportDraft(db, { userId: identity.uid, draftId: num(args.draft_id), format: args.format }),
};
