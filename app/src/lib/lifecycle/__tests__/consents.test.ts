// app/src/lib/lifecycle/__tests__/consents.test.ts
// 撤回同意的三臂，加上**两条接线各自的正负对照**。
//
// 【为什么每条接线都要正对照】「撤回之后不再写情绪记录」这句话有两种做法都能让判据变绿：
// 真的按同意状态判，或者干脆谁都不写。所以每条接线都验两次——撤回之前必须照常写得进去、
// 照常走境外那一档，撤回之后才停。少了前一半，把闸改成恒拒也全绿，
// 而那会让所有人的情绪记录一起消失。
import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CitationGuard } from '@/lib/agent/citation-guard';
import { executeTool, newTurnState, type AgentToolContext } from '@/lib/agent/tools';
import * as cases from '@/lib/cases';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN } from '@/lib/domains/registry';
import { route } from '@/lib/llm';

import {
  CONSENT_KINDS,
  consentRevoked,
  emotionRecordingRevoked,
  listConsentStates,
  overseasRevoked,
  revokeConsent,
} from '../consents';

let db: Database.Database;
let uid: number;
let caseId: number;

beforeAll(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
});

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(db.prepare("INSERT INTO users (email) VALUES ('a@t.com')").run().lastInsertRowid);
  caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '甲的档案').lastInsertRowid,
  );
});

function agentCtx(): AgentToolContext {
  return {
    db,
    caseId,
    userId: uid,
    domain: DEFAULT_DOMAIN,
    threadId: 1,
    sourceMessageId: null,
    citations: new CitationGuard(),
    crisisCardAlreadyGiven: false,
    state: newTurnState(),
    emit: () => {},
  };
}

const emotionRows = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM emotion_log WHERE case_id=?').get(caseId) as { n: number }).n;

describe('撤回本身：成功 / 拒绝 / 幂等', () => {
  it('从没有过同意行也能撤：插一条 granted_at 为空、revoked_at 有值的行', () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM consents').get()).toEqual({ n: 0 });
    const res = revokeConsent(db, { userId: uid, kind: 'emotion', now: '2026-09-07 00:00:00' });
    expect(res.ok).toBe(true);
    expect(res.ok && res.already_revoked).toBe(false);
    expect(res.ok && res.revoked_at).toBe('2026-09-07 00:00:00');
    const row = db.prepare('SELECT granted_at, revoked_at FROM consents WHERE user_id=?').get(uid);
    expect(row).toEqual({ granted_at: null, revoked_at: '2026-09-07 00:00:00' });
  });

  it('kind 不认识 ⇒ INVALID_CONSENT_KIND 且零写入', () => {
    for (const bad of ['', 'EMOTION', '情绪', null, 42]) {
      const res = revokeConsent(db, { userId: uid, kind: bad });
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      expect(!res.ok && res.errorCode).toBe('INVALID_CONSENT_KIND');
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM consents').get()).toEqual({ n: 0 });
  });

  it('撤两次都成功，第二次 already_revoked=true 且首次撤回时刻不变（变异：把 ON CONFLICT 的 WHERE 去掉 → 本条红）', () => {
    const first = revokeConsent(db, { userId: uid, kind: 'overseas', now: '2026-09-07 00:00:00' });
    const second = revokeConsent(db, { userId: uid, kind: 'overseas', now: '2026-09-30 00:00:00' });
    expect(first.ok && first.already_revoked).toBe(false);
    expect(second.ok && second.already_revoked).toBe(true);
    expect(second.ok && second.revoked_at).toBe('2026-09-07 00:00:00');
  });

  it('撤一项不影响另一项', () => {
    revokeConsent(db, { userId: uid, kind: 'emotion' });
    expect(consentRevoked(db, uid, 'emotion')).toBe(true);
    expect(consentRevoked(db, uid, 'overseas')).toBe(false);
  });

  it('清单每一项都说得出「撤回之后会发生什么」', () => {
    const states = listConsentStates(db, uid);
    expect(states.map((s) => s.kind).sort()).toEqual(Object.keys(CONSENT_KINDS).sort());
    for (const s of states) {
      expect(s.revoked, s.kind).toBe(false);
      expect(s.effect.length, s.kind).toBeGreaterThan(10);
    }
  });
});

describe('接线一：撤回 emotion 之后停止写入', () => {
  it('MCP 那条路（lib/cases.logEmotion）：撤回前照常落库、撤回后 CONSENT_REVOKED 且零写入', () => {
    // 正对照：撤回之前必须写得进去。少了这一半，把闸改成恒拒也全绿
    const before = cases.logEmotion(db, { caseId, userId: uid, level: '焦虑', note: '睡不着' });
    expect(before.ok).toBe(true);
    expect(emotionRows()).toBe(1);

    revokeConsent(db, { userId: uid, kind: 'emotion' });

    const after = cases.logEmotion(db, { caseId, userId: uid, level: '焦虑', note: '还是睡不着' });
    expect(after.ok).toBe(false);
    expect(!after.ok && after.errorCode).toBe('CONSENT_REVOKED');
    expect(emotionRows(), '撤回之后还落了一行').toBe(1);
  });

  it('站内对话那条路（lib/agent/tools）：同一句话、同一个判定（变异：只在 lib/cases 里挂闸、不动 tools → 本条红）', () => {
    const before = executeTool('emotion_log', JSON.stringify({ level: '焦虑' }), agentCtx());
    expect(before.ok, JSON.stringify(before)).toBe(true);
    expect(emotionRows()).toBe(1);

    revokeConsent(db, { userId: uid, kind: 'emotion' });

    const after = executeTool('emotion_log', JSON.stringify({ level: '焦虑' }), agentCtx());
    expect(after.ok).toBe(false);
    // 模型读到的那句话与 MCP 那条路逐字同源（两处各写一份就会慢慢分叉）
    expect(after.content).toContain('已经撤回了');
    expect(emotionRows(), '站内那条路绕过了同意闸').toBe(1);
  });

  it('emotionRecordingRevoked 按案件问：案件不存在时不拦（不替调用方判归属）', () => {
    revokeConsent(db, { userId: uid, kind: 'emotion' });
    expect(emotionRecordingRevoked(db, caseId)).toBe(true);
    expect(emotionRecordingRevoked(db, 999_999)).toBe(false);
  });
});

describe('接线二：撤回 overseas 之后路由回境内', () => {
  /** 四家全部有凭据的环境：这样「换了一档」只可能是境内约束造成的，不是缺 key。 */
  const allAvailable = () => true;

  it('撤回前走境外那一档，撤回后落到境内（变异：把 domesticOnly 那一支删掉 → 本条红）', () => {
    // 正对照：pro/critical 的首选本来就是出境的那一档
    const before = route('critical', 'pro', { isAvailable: allAvailable });
    expect(before.provider).toBe('relay');
    expect(before.degraded).toBe(false);

    revokeConsent(db, { userId: uid, kind: 'overseas' });

    const after = route('critical', 'pro', {
      isAvailable: allAvailable,
      domesticOnly: overseasRevoked(db, uid),
    });
    expect(after.provider, '撤回之后仍然走了出境的 provider').toBe('deepseek');
    expect(after.degraded).toBe(true);
    expect(after.degradedFrom?.provider).toBe('relay');
  });

  it('本来就在境内的那些档不受影响（撤回不该顺手把入门档也换掉）', () => {
    revokeConsent(db, { userId: uid, kind: 'overseas' });
    const r = route('standard', 'entry', { isAvailable: allAvailable, domesticOnly: true });
    expect(r.provider).toBe('deepseek');
    expect(r.degraded).toBe(false);
  });

  it('链上一家境内的都没有时**抛错而不是偷偷出境**，且错误里说清是境内约束', () => {
    const onlyRelay = (p: string) => p === 'relay';
    expect(() => route('critical', 'pro', { isAvailable: onlyRelay, domesticOnly: true })).toThrow(
      /只许境内/,
    );
    // 负对照：不加境内约束时同样的可用性是能路由出来的
    expect(route('critical', 'pro', { isAvailable: onlyRelay }).provider).toBe('relay');
  });
});
