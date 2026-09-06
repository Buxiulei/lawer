// app/src/lib/capabilities/__tests__/case-update-track.test.ts
// case_update 这层壳里，**并行轨的 null 有没有被折进"这次不传"**（设计稿 §16）。
//
// 【为什么单开一条盯这一个字段】壳里那一行是 `'track' in args ? args.track : undefined`。
// 写成 `args.track !== undefined` 看起来完全等价，实际把两件不同的事折成了一件：
//   · 不传 track   = 这一轮不动它；
//   · 传 track:null = **出轨，回主线**，这是一个动作。
// 折起来之后，「处置完了，回主线」这条指令**静默什么都没做**——
// 回包 200、字段齐全、没有一处报错，而库里那一行还挂在危机处置轨上。
// 下一轮事实卡照旧印着「当前轨：危机事件处置」，用户以为自己已经出来了。
//
// 【本条是在变异实测里发现没人看的】P4-W3 把壳里那一行改成 !== undefined，
// lib/capabilities 全套 284 条一条都没红。注释写了理由、没有判据盯着——
// 而"写过"与"验过"输出一模一样。
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Identity } from '@/lib/auth/identity';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS, DOMAINS_ENABLED_ENV } from '@/lib/domains/registry';

import { getCapability } from '..';

const COUNSELING = DOMAINS.counseling;
const TRACK = COUNSELING.tracks[0];

let db: Database.Database;
let caseId: number;
let me: Identity;
const ORIGINAL = process.env[DOMAINS_ENABLED_ENV];

beforeEach(() => {
  process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN},counseling`;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('t').lastInsertRowid);
  caseId = Number(
    db
      .prepare('INSERT INTO cases (user_id, title, stage, domain) VALUES (?, ?, ?, ?)')
      .run(uid, '一件退费争议', COUNSELING.stages[1], 'counseling').lastInsertRowid,
  );
  me = { uid, via: 'api_key', scopes: ['case:read', 'case:write'], keyId: undefined };
});

afterEach(() => {
  db.close();
  if (ORIGINAL === undefined) delete process.env[DOMAINS_ENABLED_ENV];
  else process.env[DOMAINS_ENABLED_ENV] = ORIGINAL;
});

function update(args: Record<string, unknown>): { ok?: boolean; errorCode?: string } {
  const cap = getCapability('case_update');
  expect(cap, '注册表里没有 case_update').toBeDefined();
  return cap!.run(db, me, { case_id: caseId, ...args }) as { ok?: boolean; errorCode?: string };
}

const trackOf = (): string | null =>
  (db.prepare('SELECT track FROM cases WHERE id = ?').get(caseId) as { track: string | null }).track;
const stageOf = (): string =>
  (db.prepare('SELECT stage FROM cases WHERE id = ?').get(caseId) as { stage: string }).stage;

describe('case_update 的并行轨：null 是动作，不是"没传"', () => {
  it('传轨名 ⇒ 进轨，且主线阶段一个字没动', () => {
    const before = stageOf();
    const got = update({ track: TRACK });
    expect('ok' in got && got.ok === false, JSON.stringify(got)).toBe(false);
    expect(trackOf()).toBe(TRACK);
    expect(stageOf(), '进轨把主线阶段覆盖掉了').toBe(before);
  });

  /**
   * 【这一条就是变异实测里没人看的那条】把壳里 `'track' in args` 改成
   * `args.track !== undefined`，本条必红：null 被折进"不传"，出轨这条指令什么都不做，
   * 而回包仍是 200。
   */
  it('传 track:null ⇒ **真的出轨**（变异：壳里改成 args.track !== undefined → 红）', () => {
    update({ track: TRACK });
    expect(trackOf()).toBe(TRACK);
    const got = update({ track: null });
    expect('ok' in got && got.ok === false, JSON.stringify(got)).toBe(false);
    expect(trackOf(), '「处置完了，回主线」静默没做，而回包 200').toBeNull();
  });

  it('不传 track ⇒ 这一轮不动它（自证上一条不是"改什么都清空"）', () => {
    update({ track: TRACK });
    const got = update({ goal: '把这件事了结' });
    expect('ok' in got && got.ok === false, JSON.stringify(got)).toBe(false);
    expect(trackOf(), '改别的字段把轨顺手清掉了').toBe(TRACK);
  });

  it('只传 track:null、别的什么都不传 ⇒ 不算「一个字段都没改」', () => {
    // 【为什么单钉这一条】NO_FIELDS 那道闸数的是"有几个字段要改"。
    // 把 null 折进"没传"的第二个后果是：只想出轨的那一次会被判成"你什么都没改"，
    // 而用户明明给了一条指令。
    const got = update({ track: null });
    expect('ok' in got && got.ok === false).toBe(false);
    expect(got.errorCode).not.toBe('NO_FIELDS');
  });

  it('本领域没有的轨名 ⇒ INVALID_TRACK，且库里那一行一个字没变', () => {
    update({ track: TRACK });
    const got = update({ track: '不存在的轨' });
    expect('ok' in got && got.ok === false).toBe(true);
    expect(got.errorCode).toBe('INVALID_TRACK');
    expect(trackOf()).toBe(TRACK);
  });
});
