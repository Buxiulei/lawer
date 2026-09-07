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
import { countRecentCrisisHits, recordCrisisHit } from '@/lib/cases/crisis-hits';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN } from '@/lib/domains/registry';
import { route } from '@/lib/llm';

import { overseasModelsAllowed } from '@/lib/auth/consent';
import { consentAt, hasConsent, recordConsent } from '@/lib/db/consents';
import { setModelPreferences } from '@/lib/db/otp';

import {
  REVOCABLE_CONSENTS,
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

const crisisRows = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM crisis_hits WHERE user_id=?').get(uid) as { n: number }).n;

describe('撤回本身：成功 / 拒绝 / 幂等', () => {
  it('从没有过同意行也能撤：补一行 revoked_at 有值的，且它不会被读成一次同意', () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM consents').get()).toEqual({ n: 0 });
    const res = revokeConsent(db, { userId: uid, kind: 'emotion', now: '2026-09-07 00:00:00' });
    expect(res.ok).toBe(true);
    expect(res.ok && res.already_revoked).toBe(false);
    expect(res.ok && res.revoked_at).toBe('2026-09-07 00:00:00');
    const row = db.prepare('SELECT revoked_at FROM consents WHERE user_id=?').get(uid);
    expect(row).toEqual({ revoked_at: '2026-09-07 00:00:00' });
    // 合表之后这一行与「同意过」的行在同一张表里，所以必须验它没被读成同意
    // （变异：把 hasConsent 里那句 revoked_at IS NULL 删掉 → 本条红）。
    expect(hasConsent(db, uid, 'emotion'), '撤回补的那一行被读成了一次同意').toBe(false);
    expect(consentAt(db, uid, 'emotion')).toBeNull();
  });

  it('撤回之后重新同意能真的开回来（撤回可逆，协议五.9 没说撤了就不能再同意）', () => {
    revokeConsent(db, { userId: uid, kind: 'emotion' });
    expect(hasConsent(db, uid, 'emotion')).toBe(false);
    expect(recordConsent(db, { userId: uid, kind: 'emotion' }).created).toBe(true);
    expect(hasConsent(db, uid, 'emotion')).toBe(true);
    expect(consentRevoked(db, uid, 'emotion')).toBe(false);
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
    expect(states.map((s) => s.kind).sort()).toEqual(Object.keys(REVOCABLE_CONSENTS).sort());
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

describe('接线三：撤回 emotion 之后也不再记危机识别', () => {
  /**
   * 【为什么这一段必须存在】那一项同意的 label 是「情绪状态与**危机识别记录**」，
   * 一句话覆盖两样东西，而设置页对用户说的是「撤回之后我们不再做这一项」。
   * 闸只挂在 emotion_log 两条写入路上的形态是：用户点了撤回、页面显示已撤回，
   * 而他每说一次那种话，crisis_hits 里仍然多一行——两边都不报错，外面也看不出来
   *（2026-09-07 复审 major）。
   *
   * 【为什么直接验 recordCrisisHit 就够覆盖两条通路】站内与 MCP 都只许经它落库，
   * 这一条由 lib/capabilities/__tests__/crisis-account「全仓只有 crisis-hits.ts 写
   * crisis_hits」那道结构守卫钉着；那道守卫红了，这里验的东西才会失去意义。
   */
  it('撤回前照记、撤回后一行都不落（变异：把 recordCrisisHit 里那句 consentRevoked 删掉 → 本条红）', () => {
    // 正对照：撤回之前必须记得下来。少了这一半，把闸改成恒拒也全绿，
    // 而那会让所有人的危机识别记录一起消失——事实卡首行从此永远干净。
    const before = recordCrisisHit(db, { userId: uid, caseId, source: 'site', matched: ['不想活'] });
    expect(before, '撤回之前就没记下来').not.toBeNull();
    expect(crisisRows()).toBe(1);

    revokeConsent(db, { userId: uid, kind: 'emotion' });

    const after = recordCrisisHit(db, { userId: uid, caseId, source: 'site', matched: ['不想活'] });
    expect(after, '撤回之后仍然回了一个行 id').toBeNull();
    expect(crisisRows(), '撤回之后还落了一行危机识别记录').toBe(1);
  });

  it('无案（case_id 为空）那条路同样受管——它手上没有 case_id，只有 user_id', () => {
    revokeConsent(db, { userId: uid, kind: 'emotion' });
    expect(recordCrisisHit(db, { userId: uid, caseId: null, source: 'mcp', matched: ['不想活'] })).toBeNull();
    expect(crisisRows()).toBe(0);
  });

  it('撤回不删已经记下的那些（协议五.2：撤回不影响撤回前已进行的处理）', () => {
    recordCrisisHit(db, { userId: uid, caseId, source: 'site', matched: ['不想活'] });
    revokeConsent(db, { userId: uid, kind: 'emotion' });
    expect(crisisRows()).toBe(1);
    expect(countRecentCrisisHits(db, caseId)).toBe(1);
  });

  it('别人撤回不影响这个人（判的是本人那一行同意，不是全局开关）', () => {
    const other = Number(
      db.prepare("INSERT INTO users (email) VALUES ('b@t.com')").run().lastInsertRowid,
    );
    revokeConsent(db, { userId: other, kind: 'emotion' });
    expect(recordCrisisHit(db, { userId: uid, caseId, source: 'site', matched: ['不想活'] })).not.toBeNull();
    expect(crisisRows()).toBe(1);
  });

  it('这一项的「撤回之后会发生什么」把危机识别那一半也说出来了（label 覆盖两样，话只说一半等于没说）', () => {
    const effect = REVOCABLE_CONSENTS.emotion.effect;
    expect(REVOCABLE_CONSENTS.emotion.label).toContain('危机识别记录');
    expect(effect, '只说了情绪档位，没说危机识别记录').toContain('危机识别');
    // 而热线该给照给：撤回停的是留档，不是照应（P5-C1 的口径）
    expect(effect).toContain('热线');
  });
});

describe('接线二：撤回 overseas 之后路由回境内', () => {
  /** 四家全部有凭据的环境：这样「换了一档」只可能是境外闸造成的，不是缺 key。 */
  const allAvailable = () => true;

  /** 同意 + 把设置页那个开关打开——两样齐了才允许出境（见 overseasModelsAllowed 抬头）。 */
  function grantOverseas(): void {
    recordConsent(db, { userId: uid, kind: 'overseas' });
    setModelPreferences(db, uid, { overseasModels: true });
  }

  it('撤回前走境外那一档，撤回后落到境内（变异：把 overseasAllowed 那一支删掉 → 本条红）', () => {
    // 正对照：同意且开关开着时，pro/critical 的首选就是出境的那一档
    grantOverseas();
    expect(overseasModelsAllowed(db, uid)).toBe(true);
    const before = route('critical', 'pro', {
      isAvailable: allAvailable,
      overseasAllowed: overseasModelsAllowed(db, uid),
    });
    expect(before.provider).toBe('relay');
    expect(before.degraded).toBe(false);

    revokeConsent(db, { userId: uid, kind: 'overseas' });
    expect(overseasModelsAllowed(db, uid), '撤回之后仍然判定为允许出境').toBe(false);

    const after = route('critical', 'pro', {
      isAvailable: allAvailable,
      overseasAllowed: overseasModelsAllowed(db, uid),
    });
    expect(after.provider, '撤回之后仍然走了出境的 provider').toBe('deepseek');
    // **不算降级**：换到境内最高档是这个人本来就该走的档，不是"首选缺 key 退而求其次"
    // （口径与 lib/llm/__tests__/router.test.ts ③ 同源，两处不许各说各的）。
    expect(after.degraded).toBe(false);
  });

  it('撤回顺手把设置页那个开关也关掉（否则页面显示「已开启」而实际只走境内）', () => {
    grantOverseas();
    revokeConsent(db, { userId: uid, kind: 'overseas' });
    const row = db.prepare('SELECT overseas_models FROM users WHERE id = ?').get(uid) as {
      overseas_models: number;
    };
    expect(row.overseas_models).toBe(0);
  });

  it('本来就在境内的那些档不受影响（撤回不该顺手把入门档也换掉）', () => {
    revokeConsent(db, { userId: uid, kind: 'overseas' });
    const r = route('standard', 'entry', { isAvailable: allAvailable, overseasAllowed: false });
    expect(r.provider).toBe('deepseek');
    expect(r.degraded).toBe(false);
  });

  it('链上一家境内的都没有时**抛错而不是偷偷出境**，且错误里说清是境外闸', () => {
    const onlyRelay = (p: string) => p === 'relay';
    expect(() => route('critical', 'pro', { isAvailable: onlyRelay, overseasAllowed: false })).toThrow(
      /没有「境外模型处理」的有效同意/,
    );
    // 负对照：允许出境时同样的可用性是能路由出来的
    expect(route('critical', 'pro', { isAvailable: onlyRelay, overseasAllowed: true }).provider).toBe(
      'relay',
    );
  });

  it('overseasRevoked 仍然只回答「他明确撤回过没有」——从没表过态不算撤回', () => {
    expect(overseasRevoked(db, uid)).toBe(false);
    revokeConsent(db, { userId: uid, kind: 'overseas' });
    expect(overseasRevoked(db, uid)).toBe(true);
  });
});
