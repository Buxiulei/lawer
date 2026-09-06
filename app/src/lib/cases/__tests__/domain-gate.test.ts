// app/src/lib/cases/__tests__/domain-gate.test.ts
// 建案那一刻的领域闸（设计稿 §13-5 + §16 分期的灰度开关）。
//
// 【为什么闸要在建案这一刻】cases.domain 一旦落下去，这个案子此后的阶段枚举、首诊表、
// 期限种类、文书种类、危机词表全按它取。落错了不会有任何一处报错——那个案子只是
// 一直按一份没人验收过的配置在跑，而它看起来和别的案件没有区别。
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as cases from '@/lib/cases';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS, DOMAINS_ENABLED_ENV } from '@/lib/domains/registry';

let db: Database.Database;
let uid: number;

const ORIGINAL_ENV = process.env[DOMAINS_ENABLED_ENV];

/** 站内文案的正本（从缺省领域包取；测试里也不抄第二份字面量） */
const SITE = DOMAINS[DEFAULT_DOMAIN].copy.site;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('h').lastInsertRowid);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[DOMAINS_ENABLED_ENV];
  else process.env[DOMAINS_ENABLED_ENV] = ORIGINAL_ENV;
});

describe('ensureDefaultCase 的领域参数', () => {
  it('不给 domain ⇒ 落缺省领域', () => {
    const made = cases.ensureDefaultCase(db, uid);
    expect('ok' in made).toBe(false);
    if ('ok' in made) return;
    const row = db.prepare('SELECT domain FROM cases WHERE id = ?').get(made.caseId) as {
      domain: string;
    };
    expect(row.domain).toBe(DEFAULT_DOMAIN);
  });

  it('给一个没开的领域 ⇒ 自述错误，且**一行都不写**（变异：把闸删掉 → 红）', () => {
    const before = db.prepare('SELECT COUNT(*) n FROM cases').get() as { n: number };
    const made = cases.ensureDefaultCase(db, uid, 'counseling');
    expect('ok' in made && made.ok).toBe(false);
    const fail = made as { errorCode: string; message: string };
    // 这个领域包还没写，所以是 UNKNOWN_DOMAIN；写了但没开时是 DOMAIN_NOT_ENABLED
    expect(['UNKNOWN_DOMAIN', 'DOMAIN_NOT_ENABLED']).toContain(fail.errorCode);
    expect(fail.message).toContain('counseling');
    expect(db.prepare('SELECT COUNT(*) n FROM cases').get()).toEqual(before);
  });

  it('显式给缺省领域 ⇒ 照常建，落的就是它', () => {
    process.env[DOMAINS_ENABLED_ENV] = DEFAULT_DOMAIN;
    const made = cases.ensureDefaultCase(db, uid, DEFAULT_DOMAIN);
    expect('ok' in made).toBe(false);
    if ('ok' in made) return;
    expect(made.isNew).toBe(true);
    const row = db.prepare('SELECT domain, title FROM cases WHERE id = ?').get(made.caseId) as {
      domain: string;
      title: string;
    };
    expect(row.domain).toBe(DEFAULT_DOMAIN);
    // 抬头与欢迎事件都来自领域包的 copy.site，不是本层写死的字面量
    expect(row.title).toBe(SITE.defaultCaseTitle);
    const ev = db
      .prepare('SELECT title, detail FROM timeline_events WHERE case_id = ?')
      .get(made.caseId) as { title: string; detail: string };
    expect(ev.title).toBe(SITE.welcomeEventTitle);
    expect(ev.detail).toBe(SITE.welcomeEventDetail);
  });

  it('名下已有案件 ⇒ 幂等回既有那个，不因 domain 参数再建一个', () => {
    const first = cases.ensureDefaultCase(db, uid);
    expect('ok' in first).toBe(false);
    const again = cases.ensureDefaultCase(db, uid, DEFAULT_DOMAIN);
    expect('ok' in again).toBe(false);
    if ('ok' in first || 'ok' in again) return;
    expect(again.caseId).toBe(first.caseId);
    expect(again.isNew).toBe(false);
  });
});

describe('首诊按案件领域取包', () => {
  it('domain 认不出来 ⇒ UNKNOWN_DOMAIN，不静默换一个包用（变异：让 packForCase 回落缺省包 → 红）', () => {
    const made = cases.ensureDefaultCase(db, uid);
    if ('ok' in made) throw new Error('建案失败');
    db.prepare('UPDATE cases SET domain = ? WHERE id = ?').run('没有这个领域', made.caseId);
    const res = cases.submitIntake(db, {
      caseId: made.caseId,
      userId: uid,
      stage: '风声',
      companyName: '某某公司',
      employedFrom: '2020-01-01',
      monthlyWageFen: 3000000,
      goals: ['要个说法'],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('UNKNOWN_DOMAIN');
    expect(res.message).toContain('没有这个领域');
  });
});
