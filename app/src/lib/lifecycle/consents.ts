// app/src/lib/lifecycle/consents.ts
// 单独同意的**撤回**（协议 v0.2 五.2(4)、五.9，附一第 7 项）。
//
// 【本票只做撤回，不做授予】授予（首次记录前问一次、境外模型开关的说明页）是 P5-C1 的事。
// 两票合并时 consents 表要按 C1 那份口径统一，本文件建的是**同名最小表结构**：
// 一个用户一种同意一行，granted_at 留给 C1 写，revoked_at 由这里写。
//
// 【为什么「没有同意行」不等于「没同意」】本表落地之前，情绪记录与模型路由已经在跑了，
// 那些用户名下一行同意记录都没有。若把「查不到行」读成「没同意」，本票一合入就会
// 静默关掉所有人的情绪记录与全部境外路由——那是 C1 要连同告知与授予界面一起做的事，
// 不该由一次表结构变更顺手完成。所以判据只有一条：**明确撤回过的才停**。
// 反过来的默认（无行即拒）要等 C1 的授予入口上线后同时切换，见本票 notDone。
import type { Database } from 'better-sqlite3';

import type { DomainFailure, Result } from '@/lib/cases';
import * as store from '@/lib/db/lifecycle';
import { nowSql } from '@/lib/db/time';

/**
 * 可撤回的同意项。**每一项都要写清「撤回之后会发生什么」**：撤回是一个用户看不到内部
 * 状态的动作，只说「已撤回」等于让他自己猜哪些功能会变。
 */
export const CONSENT_KINDS = {
  emotion: {
    kind: 'emotion',
    label: '情绪状态与危机识别记录',
    effect:
      '撤回后不再记录新的情绪档位。已经记下的不会被这一步删掉——撤回不影响撤回前已进行的处理；' +
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

export type ConsentKind = keyof typeof CONSENT_KINDS;

export function isConsentKind(value: unknown): value is ConsentKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONSENT_KINDS, value);
}

function fail(status: number, errorCode: string, message: string): DomainFailure {
  return { ok: false, status, errorCode, message };
}

/** 一项同意此刻的对外形态。 */
export interface ConsentState {
  kind: ConsentKind;
  label: string;
  effect: string;
  granted_at: string | null;
  revoked_at: string | null;
  /** true = 这个人明确撤回过（读侧的判据只看这一位，见文件头） */
  revoked: boolean;
}

function stateOf(kind: ConsentKind, row?: { granted_at: string | null; revoked_at: string | null }): ConsentState {
  const meta = CONSENT_KINDS[kind];
  return {
    kind,
    label: meta.label,
    effect: meta.effect,
    granted_at: row?.granted_at ?? null,
    revoked_at: row?.revoked_at ?? null,
    revoked: Boolean(row?.revoked_at),
  };
}

/** 全部同意项此刻的状态（设置页那张卡与撤回入口都读它）。 */
export function listConsentStates(db: Database, userId: number): ConsentState[] {
  const rows = new Map(store.listConsents(db, userId).map((r) => [r.kind, r]));
  return (Object.keys(CONSENT_KINDS) as ConsentKind[]).map((k) => stateOf(k, rows.get(k)));
}

/**
 * 这个人是不是明确撤回过这一项。**全站判「要不要停」只认这一个函数**——
 * 各处自己去查表的形态是：某一处把「查不到行」读成了「撤回了」（或反过来），
 * 而两种读法在没有同意行的账号上给出相反的结论，且都不报错。
 */
export function consentRevoked(db: Database, userId: number, kind: ConsentKind): boolean {
  return Boolean(store.findConsent(db, userId, kind)?.revoked_at);
}

export interface RevokeConsentOutput {
  kind: ConsentKind;
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
  if (!isConsentKind(input.kind)) {
    return fail(
      400,
      'INVALID_CONSENT_KIND',
      `kind 只能是 ${Object.keys(CONSENT_KINDS).join(' / ')}，收到的是 ${JSON.stringify(input.kind)}。` +
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
  const row = store.findConsent(db, input.userId, input.kind);
  return {
    ok: true,
    kind: input.kind,
    revoked_at: row?.revoked_at ?? now,
    already_revoked: !changed,
    effect: CONSENT_KINDS[input.kind].effect,
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
