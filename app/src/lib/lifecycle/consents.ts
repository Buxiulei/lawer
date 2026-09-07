// app/src/lib/lifecycle/consents.ts
// 单独同意的**撤回**（协议 v0.2 五.2(4)、五.9，附一第 7 项）：哪几项可撤、撤了会发生什么、
// 以及撤完之后两条写入路径各自回给用户的那句话。
//
// 【授予不在这里】授予（注册页勾选、实名页那一次、设置页开关、站内对话 consent_grant）
// 在 lib/auth/consent.ts 与 lib/db/consents.ts。表只有一张、写入口只有 lib/db/consents.ts
// 一个（合入 P5-C1/C2 时按裁决合表），本文件不碰 SQL。
//
// 【撤回与"从没表过态"是两件事】读侧的闸门问的是 hasConsent（撤回过的行不算数），
// 而本文件的 consentRevoked 问的是"他是不是明确说过不要"。区别只在**要对他说哪句话**：
// 撤回过的人该被告知去设置页可以重新打开，从没被问过的人该被问一次。
// 两者混成一个判据的形态是：一个刚撤回完的人，下一轮又被问一遍"要不要记录你的情绪"。
import type { Database } from 'better-sqlite3';

import type { DomainFailure, Result } from '@/lib/cases';
import * as store from '@/lib/db/consents';
import { setModelPreferences } from '@/lib/db/otp';
import { nowSql } from '@/lib/db/time';

/**
 * 可撤回的同意项。**每一项都要写清「撤回之后会发生什么」**：撤回是一个用户看不到内部
 * 状态的动作，只说「已撤回」等于让他自己猜哪些功能会变。
 */
export const REVOCABLE_CONSENTS = {
  emotion: {
    kind: 'emotion',
    label: '情绪状态与危机识别记录',
    // 【这段话覆盖 label 里的两样，一样都不能少】只写「情绪档位」的形态是：
    // 用户点撤回时读到的是半句话，而危机识别记录照记不误——他没有机会发现这件事。
    // 两条写入路各自的闸：情绪走 emotionRecordingRevoked，危机走 lib/cases/crisis-hits。
    effect:
      '撤回后不再记录新的情绪档位，也不再记录新的危机识别命中。' +
      '危机来临时该给的热线号码与提示照给——撤回停的是留档，不是照应。' +
      '已经记下的不会被这一步删掉——撤回不影响撤回前已进行的处理；' +
      '要连同已记录的一起删，请删除对应案件或注销账号。',
  },
  overseas: {
    kind: 'overseas',
    label: '境外模型处理',
    effect:
      '撤回后你的对话一律只走境内模型；本来会走境外的那几档自动落到境内可用的下一档。' +
      '已经发送过的内容不会因此收回。',
  },
} as const;

export type RevocableKind = keyof typeof REVOCABLE_CONSENTS;

export function isRevocableKind(value: unknown): value is RevocableKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REVOCABLE_CONSENTS, value);
}

function fail(status: number, errorCode: string, message: string): DomainFailure {
  return { ok: false, status, errorCode, message };
}

/** 一项同意此刻的对外形态。 */
export interface ConsentState {
  kind: RevocableKind;
  label: string;
  effect: string;
  /** 最早那一次仍然有效的同意时刻；从没同意过、或撤回之后都为 null */
  granted_at: string | null;
  /** 最早那一次撤回的时刻 */
  revoked_at: string | null;
  /** true = 这个人明确撤回过 */
  revoked: boolean;
}

/** 全部可撤回项此刻的状态（设置页那张卡与撤回入口都读它）。 */
export function listConsentStates(db: Database, userId: number): ConsentState[] {
  return (Object.keys(REVOCABLE_CONSENTS) as RevocableKind[]).map((kind) => {
    const meta = REVOCABLE_CONSENTS[kind];
    return {
      kind,
      label: meta.label,
      effect: meta.effect,
      granted_at: store.consentAt(db, userId, kind),
      revoked_at: store.revokedAt(db, userId, kind),
      revoked: store.consentRevoked(db, userId, kind),
    };
  });
}

/**
 * 这个人是不是明确撤回过这一项。**判「要不要停」只认这一个函数**——
 * 各处自己去查表的形态是：某一处把「查不到行」读成了「撤回了」（或反过来），
 * 而两种读法在没有同意行的账号上给出相反的结论，且都不报错。
 */
export function consentRevoked(db: Database, userId: number, kind: RevocableKind): boolean {
  return store.consentRevoked(db, userId, kind);
}

export interface RevokeConsentOutput {
  kind: RevocableKind;
  revoked_at: string;
  /** true = 之前就撤过，这一次没有改写首次撤回时刻（幂等重放） */
  already_revoked: boolean;
  effect: string;
}

/**
 * 撤回一项同意。**幂等**：再撤一次照样成功，already_revoked=true，首次撤回时点不变。
 *
 * 【为什么撤回不设任何前置闸】撤回是把已经给出去的东西收回来。实名状态、余额、案件是否
 * 还在，都不该挡住它——一个人最想撤回的时候，往往正是他账号状态最不齐整的时候。
 */
export function revokeConsent(
  db: Database,
  input: { userId: number; kind: unknown; note?: unknown; now?: string },
): Result<RevokeConsentOutput> {
  if (!isRevocableKind(input.kind)) {
    return fail(
      400,
      'INVALID_CONSENT_KIND',
      `kind 只能是 ${Object.keys(REVOCABLE_CONSENTS).join(' / ')}，收到的是 ${JSON.stringify(input.kind)}。` +
        '为什么：撤回要落到一项具体的同意上，服务端不猜你指的是哪一项。' +
        '怎么办：先读一次同意清单（GET /api/v1/me/consents）拿到 kind，再照原样传回来。',
    );
  }
  const now = input.now ?? nowSql();
  const changed = store.revokeConsent(db, {
    userId: input.userId,
    kind: input.kind,
    now,
    note: typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 200) : null,
  });
  // 境外那一项还带一个**用户看得见的开关**（users.overseas_models，设置页「隐私与同意」）。
  // 只写台账不关开关的形态是：撤回成功了、路由也确实只走境内了，而设置页上那个开关
  // 仍然显示「已开启」——用户读到的状态与实际行为相反，两边都不报错。
  if (input.kind === 'overseas') setModelPreferences(db, input.userId, { overseasModels: false });
  return {
    ok: true,
    kind: input.kind,
    revoked_at: store.revokedAt(db, input.userId, input.kind) ?? now,
    already_revoked: !changed,
    effect: REVOCABLE_CONSENTS[input.kind].effect,
  };
}

// ───────────────────────────── 两条接线 ─────────────────────────────

/**
 * 这个案子还能不能写情绪记录。**按案件问而不是按用户问**：两条写入路径（站内对话的
 * emotion_log 工具、MCP 那条能力）手上都有 case_id，而只有一条手上有 user_id；
 * 统一成按案件问，两处调的就是同一个函数、同一个签名，不会一处判了一处没判。
 *
 * 案件不存在时回 true（照常写）：归属与存在性由各自的调用方判，这里不替它们决定，
 * 也不因为查不到案件就把一次合法写入拦下来。
 */
export function emotionRecordingRevoked(db: Database, caseId: number): boolean {
  const row = db.prepare('SELECT user_id FROM cases WHERE id = ?').get(caseId) as
    | { user_id: number }
    | undefined;
  return row ? consentRevoked(db, row.user_id, 'emotion') : false;
}

/** 撤回情绪同意后，两条写入路径都回这一句（措辞只有一份，免得两处各说各的）。 */
export const EMOTION_REVOKED_NOTE =
  '这一条没有记录：这个账号已经撤回了「情绪状态与危机识别记录」的同意，服务端不再写入新的情绪记录。' +
  '为什么：撤回同意后我们就不该再收集这一类信息（协议第五条第 2 款）。' +
  '怎么办：照常陪着说话就行，不要再调这个工具；用户想重新开启的话，去网页「设置 → 我的同意」。';

/**
 * 这个人是不是把境外模型的同意撤回了。撤回即只走境内——接线在 lib/agent/orchestrator
 * 取模型那一处（唯一一处按用户选模型的地方）。
 */
export function overseasRevoked(db: Database, userId: number): boolean {
  return consentRevoked(db, userId, 'overseas');
}
