// app/src/lib/time/__tests__/outbound-time.test.ts
// 对外时间一律带 +08:00，且 **REST / MCP / 事实卡三处同源**（都走 lib/time）。
//
// 判据的正心是**跨日**那一格：UTC 16:30 在北京是次日 00:30。没有偏移标记时，收到这串的
// 一方按自己的本地时区解析，日期会整整差一天——而"这件事发生在哪天"正是本产品里
// 期限、时效、时间线全都建在上面的那个东西。
//
// 变异臂：把 toDisplayTime 改回输出 UTC 裸串 ⇒ 三处判据同时红。
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildCaseFacts } from '@/lib/agent/case-facts';
import { loadCaseSnapshot } from '@/lib/agent/snapshot';
import type { Identity } from '@/lib/auth/identity';
import { getCapability } from '@/lib/capabilities';
import { runMigrations } from '@/lib/db/migrate';
import { toolTextResult } from '@/lib/mcp/jsonrpc';
import { apiJson } from '@/lib/http/json';
import {
  isCanonical,
  isTimeKey,
  OUTBOUND_OFFSET,
  toDisplayDay,
  toDisplayTime,
  withDisplayTimes,
} from '@/lib/time';

/** 跨日样本：UTC 当天 16:30 = 北京次日 00:30。 */
const UTC_1630 = '2026-09-06 16:30:00';
const CST_NEXT_DAY = '2026-09-07T00:30:00+08:00';

let db: Database;
let uid: number;
let caseId: number;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(
    db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('h', '未认证')").run().lastInsertRowid,
  );
  caseId = Number(
    db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, '案子', '风声')").run(uid).lastInsertRowid,
  );
});

afterEach(() => db.close());

describe('格式化函数本身', () => {
  test('UTC 16:30 ⇒ +08 次日 00:30（跨日）', () => {
    expect(toDisplayTime(UTC_1630)).toBe(CST_NEXT_DAY);
    expect(toDisplayDay(UTC_1630)).toBe('2026-09-07');
  });

  test('不是 canonical 的串原样返回：已带偏移的、只有日期的、null 都不动', () => {
    expect(toDisplayTime('2026-09-05T03:42:58+00:00')).toBe('2026-09-05T03:42:58+00:00');
    expect(toDisplayTime('2026-09-05')).toBe('2026-09-05');
    expect(toDisplayTime(null)).toBeNull();
    expect(isCanonical('2026-09-05T03:42:58Z')).toBe(false);
  });

  test('只改「键名像时间 且 值是 canonical」的那一格，别的一个字节不碰', () => {
    const out = withDisplayTimes({
      created_at: UTC_1630,
      tsa_gen_time: UTC_1630,
      // 键名不像时间：正文里恰好有个日期串，不许改写
      detail: UTC_1630,
      // 键名像时间但值不是 canonical：它已经带了时区
      updated_at: '2026-09-06T16:30:00Z',
      nested: [{ due_at: UTC_1630 }],
    });
    expect(out.created_at).toBe(CST_NEXT_DAY);
    expect(out.tsa_gen_time).toBe(CST_NEXT_DAY);
    expect(out.detail).toBe(UTC_1630);
    expect(out.updated_at).toBe('2026-09-06T16:30:00Z');
    expect(out.nested[0].due_at).toBe(CST_NEXT_DAY);
    expect(isTimeKey('detail')).toBe(false);
  });
});

describe('REST / MCP / 事实卡三处同源', () => {
  function addEvent() {
    db.prepare(
      "INSERT INTO timeline_events (case_id, happened_at, kind, title) VALUES (?, ?, '公司动作', 'HR 约谈')",
    ).run(caseId, UTC_1630);
  }

  test('REST：apiJson 出来的时间带 +08:00 且是次日', async () => {
    addEvent();
    const res = apiJson({
      ok: true,
      events: db.prepare('SELECT happened_at FROM timeline_events WHERE case_id = ?').all(caseId),
    });
    const body = (await res.json()) as { events: { happened_at: string }[] };
    expect(body.events[0].happened_at).toBe(CST_NEXT_DAY);
  });

  test('MCP：toolTextResult 出来的时间与 REST 逐字一致', async () => {
    addEvent();
    const identity: Identity = { uid, via: 'jwt', scopes: ['case:read', 'case:write'] };
    const listed = await getCapability('timeline_list')!.run(db, identity, { case_id: caseId });
    const text = toolTextResult(listed).content[0].text;
    expect(text).toContain(CST_NEXT_DAY);
    expect(text).not.toContain(UTC_1630);
  });

  test('事实卡：日期按 +08 取日，跨日那条落在次日', () => {
    addEvent();
    const card = buildCaseFacts(loadCaseSnapshot(db, caseId));
    const timeline = card.sections.find((s) => s.key === 'timeline')!;
    expect(timeline.detail.join('\n')).toContain(CST_NEXT_DAY);
    expect(timeline.detail.join('\n')).not.toContain(UTC_1630);
  });

  test('事实卡的期限日期用北京日历日，不是 UTC 那一天', () => {
    db.prepare(
      "INSERT INTO deadlines (case_id, kind, due_at) VALUES (?, '仲裁时效', ?)",
    ).run(caseId, UTC_1630);
    const card = buildCaseFacts(loadCaseSnapshot(db, caseId));
    const dl = card.sections.find((s) => s.key === 'deadlines')!;
    expect(dl.detail.join('\n')).toContain('2026-09-07');
    expect(dl.detail.join('\n')).not.toContain('2026-09-06');
  });

  test('偏移常量只有一处，三方共用', () => {
    expect(OUTBOUND_OFFSET).toBe('+08:00');
    expect(toDisplayTime(UTC_1630).endsWith(OUTBOUND_OFFSET)).toBe(true);
  });
});
