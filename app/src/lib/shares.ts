// app/src/lib/shares.ts
// 免登录只读分享链接的领域层（设计稿 §2 E share_create / share_revoke）。
// SQL 全在 lib/db/share-links.ts，本文件只管归属校验、时长闸与「打开链接看到什么」。
//
// 【这条链路交出去的是什么】一条不带任何凭据、任何人拿到就能看的地址。所以三件事都在这层写死：
//   ① 只分享**一份东西**（一份文书或一件证据的说明），不是整个案卷——
//      「把档案分享给对方律师」听起来方便，但用户脑子里想给的是那一份，不是全部。
//   ② 证据分享**只给元数据与证明目的，不给文件字节**：一条免登录 URL 直连原始录音/工资流水，
//      转发一次就等于永久公开。要给文件本身走另一条一次性下载地址（lib/files/download-token）。
//   ③ 必有到期时间。表结构本就不设永久链（expires_at NOT NULL），这层再把上限压到 30 天：
//      「永久有效」的分享链接与「把文件发出去」没有区别，而用户以为自己还能收回。
import type { Database } from 'better-sqlite3';

import crypto from 'node:crypto';

import * as cases from '@/lib/cases';
import type { DomainFailure, Result } from '@/lib/cases';
import { findDraftById } from '@/lib/db/agent';
import * as store from '@/lib/db/share-links';
import { findEvidenceDetail } from '@/lib/db/evidence';
import { toSql } from '@/lib/db/time';

/** 默认有效期（小时）：三天。够对方看完、也够用户改主意。 */
export const SHARE_DEFAULT_HOURS = 72;
/** 有效期上限（小时）：30 天。见文件头 ③。 */
export const SHARE_MAX_HOURS = 24 * 30;

function fail(status: number, errorCode: string, message: string): DomainFailure {
  return { ok: false, status, errorCode, message };
}

/** 分享页地址。PUBLIC_BASE_URL 配了就拼成绝对地址，没配就只给路径（同 evidence_upload_url 的口径）。 */
export function shareUrlFor(token: string): string {
  const path = `/s/${token}`;
  const base = process.env.PUBLIC_BASE_URL?.trim();
  return base ? `${base.replace(/\/+$/, '')}${path}` : path;
}

// ───────────────────────────── 创建 ─────────────────────────────

export interface ShareCreated {
  share_id: number;
  url: string;
  token: string;
  expires_at: string;
  target_kind: store.ShareTargetKind;
  target_id: number;
  title: string;
}

export interface ShareTarget {
  caseId: number;
  targetKind: store.ShareTargetKind;
  targetId: number;
  title: string;
}

/**
 * 解析并校验分享标的（**只读，不写任何东西**）。draftId 与 evidenceId 恰好给一个。
 *
 * 【为什么单独露出来】幂等台账要 case_id，而 case_id 长在标的行上。把它当入参问 agent 要，
 * agent 报错一个案号就会把这次写入记到别人的案子名下；先解析、再拿真 case_id 去记账，
 * 这个偏差就不存在。能力壳据此判归属、拿 case_id，随后同一份解析在 createShare 里再走一遍——
 * 两次都是几行索引读，换来的是「校验只有一份实现」。
 *
 * 归属校验借的是既有的读路径（cases.getDraft / evidence 行的 user_id），不另写一套：
 * 另写一套的形态是某天读路径补了一道校验，这条路没补，于是同一份东西读不到却分享得出去。
 */
export function resolveShareTarget(
  db: Database,
  input: { userId: number; draftId?: number; evidenceId?: number },
): Result<ShareTarget> {
  const hasDraft = input.draftId !== undefined && input.draftId !== null;
  const hasEvidence = input.evidenceId !== undefined && input.evidenceId !== null;
  if (hasDraft === hasEvidence) {
    return fail(
      400,
      'INVALID_SHARE_TARGET',
      'draft_id 与 evidence_id 恰好给一个：一条链接只分享一份东西。' +
        '两个都给的话，服务端替你选一个就等于替用户决定了他要给对方看什么；' +
        '两个都不给则没有标的。要分享两份就建两条链接，可以分别撤销。',
    );
  }

  if (hasDraft) {
    const found = cases.getDraft(db, { userId: input.userId, draftId: input.draftId as number });
    if (!found.ok) return found;
    return {
      ok: true,
      caseId: found.draft.case_id,
      targetKind: 'draft',
      targetId: found.draft.id,
      title: found.draft.title,
    };
  }

  const row = findEvidenceDetail(db, input.evidenceId as number);
  // 不存在与不属于本人回同一个错误（同 DRAFT_NOT_FOUND 的口径）：能分辨就成了枚举探针
  if (!row || row.user_id !== input.userId) {
    return fail(404, 'EVIDENCE_NOT_FOUND', '材料不存在');
  }
  return { ok: true, caseId: row.case_id, targetKind: 'evidence', targetId: row.id, title: row.name };
}

/** 建一条分享链接。标的解析与归属校验全在 resolveShareTarget。 */
export function createShare(
  db: Database,
  input: {
    userId: number;
    draftId?: number;
    evidenceId?: number;
    expiresInHours?: number;
    now?: Date;
  },
): Result<ShareCreated> {
  const target = resolveShareTarget(db, input);
  if (!target.ok) return target;

  const hours = normalizeHours(input.expiresInHours);
  if (typeof hours !== 'number') return hours;

  const now = input.now ?? new Date();
  const expiresAt = toSql(new Date(now.getTime() + hours * 3600_000));
  const token = crypto.randomBytes(16).toString('hex');
  const shareId = store.create(db, {
    caseId: target.caseId,
    token,
    scope: '档案只读',
    expiresAt,
    targetKind: target.targetKind,
    targetId: target.targetId,
  });

  return {
    ok: true,
    share_id: shareId,
    url: shareUrlFor(token),
    token,
    expires_at: expiresAt,
    target_kind: target.targetKind,
    target_id: target.targetId,
    title: target.title,
  };
}

/** 时长闸。回数字表示通过，回 DomainFailure 表示拒。 */
function normalizeHours(raw: number | undefined): number | DomainFailure {
  if (raw === undefined || raw === null) return SHARE_DEFAULT_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || !Number.isInteger(hours) || hours < 1 || hours > SHARE_MAX_HOURS) {
    return fail(
      400,
      'INVALID_EXPIRES_IN',
      `expires_in 是小时数，必须是 1 到 ${SHARE_MAX_HOURS} 之间的整数（收到 ${JSON.stringify(raw)}）。` +
        `不给就按默认 ${SHARE_DEFAULT_HOURS} 小时。` +
        '为什么有上限：这条地址不带任何凭据，谁拿到谁能看；有效期长到以年计，与直接把文件发出去没有区别，' +
        '而用户会以为自己随时还能收回。要长期给对方看，到期后再建一条。',
    );
  }
  return hours;
}

// ───────────────────────────── 撤销 ─────────────────────────────

/**
 * 撤销一条链接。**幂等**：已撤销的再撤一次照回 ok，不改原时间戳、不报错。
 *
 * 【为什么重复撤销不算错】撤销是用户改主意时按的那个按钮，多半还伴着慌张。
 * 让它在第二次点击时报错，等于在这个时刻告诉他"出问题了"——而他要的结果早已达成。
 */
export function revokeShare(
  db: Database,
  input: { userId: number; shareId: number },
): Result<{ share_id: number; revoked_at: string; already_revoked: boolean }> {
  const row = store.findById(db, input.shareId);
  if (!row) return fail(404, 'SHARE_NOT_FOUND', '分享链接不存在');
  // 归属经案件走（share_links 不存 user_id）：不是自己的案件与不存在同码
  const owned = cases.getCase(db, { caseId: row.case_id, userId: input.userId, timelineLimit: 1 });
  if (!owned.ok) return fail(404, 'SHARE_NOT_FOUND', '分享链接不存在');

  const already = row.revoked_at !== null;
  if (!already) store.revoke(db, row.id);
  const after = store.findById(db, row.id);
  return {
    ok: true,
    share_id: row.id,
    revoked_at: after?.revoked_at ?? row.revoked_at ?? '',
    already_revoked: already,
  };
}

// ───────────────────────────── 免登录读取 ─────────────────────────────

export interface ShareView {
  kind: store.ShareTargetKind;
  title: string;
  expires_at: string;
  /**
   * 文书：正文原文。**不带那段「发出前必读」尾注**——尾注是写给起草人自己的提醒
   * （发出后果、可不可撤回、由你决定发不发），把它随文书一起给对方看，等于把自己的顾虑
   * 连同文书一起交出去。同理见 lib/drafts/export.ts 的导出口径，两处必须一致。
   * 证据：null（免登录页不给文件字节，见文件头 ②）。
   */
  body: string | null;
  /** 证据：分类 / 证明目的 / 原件形态 / 哈希；文书：null */
  meta: Record<string, string> | null;
}

export type ShareReadResult =
  | { state: 'ok'; view: ShareView }
  | { state: 'not_found' }
  | { state: 'expired'; expires_at: string }
  | { state: 'revoked' };

/**
 * 按 token 读一条分享。**无需登录**——这是这条链路存在的意义。
 *
 * 三种不可用状态分开回（见 lib/db/share-links.inspect 的说明），由调用方决定对外说到哪一层：
 * 免登录页与 REST 都要把「到期」与「不存在」说清楚，否则拿到链接的人只会反复刷新。
 */
export function readShare(db: Database, token: string): ShareReadResult {
  const seen = store.inspect(db, token);
  if (seen.state === 'not_found' || !seen.row) return { state: 'not_found' };
  if (seen.state === 'revoked') return { state: 'revoked' };
  if (seen.state === 'expired') return { state: 'expired', expires_at: seen.row.expires_at };

  const row = seen.row;
  if (row.target_kind === 'draft' && row.target_id !== null) {
    const draft = findDraftById(db, row.target_id);
    // 标的行没了（案件被删、草稿被清）或被挪去了别的案子，链接本身还在：按「没有这条链接」处理，
    // 不回一个空壳页——空壳页会让拿到链接的人以为内容还没写完，其实是已经没有了。
    if (!draft || draft.case_id !== row.case_id) return { state: 'not_found' };
    return {
      state: 'ok',
      view: {
        kind: 'draft',
        title: draft.title,
        expires_at: row.expires_at,
        // 免登录页交给对方看的是正文原文：剥掉「发出前必读」尾注（同 lib/drafts/export 的口径）
        body: cases.stripConfirmationFooter(draft.content ?? ''),
        meta: null,
      },
    };
  }

  if (row.target_kind === 'evidence' && row.target_id !== null) {
    const ev = findEvidenceDetail(db, row.target_id);
    if (!ev || ev.case_id !== row.case_id) return { state: 'not_found' };
    return {
      state: 'ok',
      view: {
        kind: 'evidence',
        title: ev.name,
        expires_at: row.expires_at,
        body: null,
        meta: {
          分类: ev.category,
          证明目的: ev.prove_purpose ?? '（未填）',
          原件形态: ev.original_medium ?? '（未填）',
          状态: ev.status,
          文件哈希: ev.sha256,
        },
      },
    };
  }

  // target_kind 为空的存量行 = 整案档案只读，本次没有实现这种分享的展示面。
  // 当成「没有这条链接」而不是抛错：这条路上站着的是一个拿到链接的普通人，
  // 给他一个 500 页面既没用、也暴露了我们内部有几种分享。
  return { state: 'not_found' };
}
