// withClientRef 的幂等判据。
//
// 这里验的是**重放不会双写**：同一个 client_ref 第二次进来，业务表不多一行、
// agent_writes 也不多一行，且回的是第一次那个 target。
// 反过来的形态是 agent 网络抖动重试一次，用户档案里多一条——返回 200、格式完全正常。
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '@/lib/db/migrate';

import { withClientRef } from '../idempotent';

let db: Database.Database;
let caseId: number;

function countTimeline(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM timeline_events').get() as { n: number }).n;
}
function agentWrites(): { tool: string; client_ref: string | null; target_id: number }[] {
  return db
    .prepare('SELECT tool, client_ref, target_id FROM agent_writes ORDER BY id')
    .all() as { tool: string; client_ref: string | null; target_id: number }[];
}

/** 一次"业务写入"：往时间线插一条，返回它落在哪 */
function insertEvent(title: string) {
  return () => {
    const id = Number(
      db
        .prepare(
          "INSERT INTO timeline_events (case_id, happened_at, kind, title) VALUES (?, datetime('now'), '系统动作', ?)",
        )
        .run(caseId, title).lastInsertRowid,
    );
    return { table: 'timeline_events', id };
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('h').lastInsertRowid);
  caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uid, '测试案件').lastInsertRowid,
  );
});

describe('withClientRef', () => {
  it('同一个 client_ref 重放：回同一个 target、deduped:true，业务表与台账都只有一行', () => {
    const first = withClientRef(db, { caseId, tool: 't', clientRef: 'ref-1' }, insertEvent('第一次'));
    expect(first).toEqual({ target: { table: 'timeline_events', id: expect.any(Number) }, deduped: false });

    const replay = withClientRef(db, { caseId, tool: 't', clientRef: 'ref-1' }, insertEvent('重放'));
    expect(replay.deduped).toBe(true);
    expect(replay.target).toEqual(first.target);

    expect(countTimeline(), '重放不许再插一条业务行').toBe(1);
    expect(agentWrites(), '重放不许再记一条台账').toHaveLength(1);
  });

  it('不同 client_ref 是两次不同的写入', () => {
    const a = withClientRef(db, { caseId, tool: 't', clientRef: 'ref-1' }, insertEvent('甲'));
    const b = withClientRef(db, { caseId, tool: 't', clientRef: 'ref-2' }, insertEvent('乙'));
    expect(b.deduped).toBe(false);
    expect(b.target.id).not.toBe(a.target.id);
    expect(countTimeline()).toBe(2);
    expect(agentWrites()).toHaveLength(2);
  });

  it('同 ref 不同工具互不串台（唯一键是 案件 + 工具 + ref 三元组）', () => {
    withClientRef(db, { caseId, tool: 't1', clientRef: 'same' }, insertEvent('甲'));
    const other = withClientRef(db, { caseId, tool: 't2', clientRef: 'same' }, insertEvent('乙'));
    expect(other.deduped).toBe(false);
    expect(countTimeline()).toBe(2);
  });

  /**
   * 不带 client_ref 的调用**照常执行、照常记账**：去重交给各自的自然键。
   * 若这里把 NULL 也当成"同一个 ref"，第二次无 ref 写入会被误判成重复而静默丢掉。
   */
  it('不带 client_ref：每次都真的写，台账 client_ref 为 NULL', () => {
    withClientRef(db, { caseId, tool: 't' }, insertEvent('甲'));
    withClientRef(db, { caseId, tool: 't', clientRef: '   ' }, insertEvent('乙'));
    expect(countTimeline()).toBe(2);
    expect(agentWrites().map((r) => r.client_ref)).toEqual([null, null]);
  });

  it('业务写入自己抛错时，台账不留半行（同一事务）', () => {
    expect(() =>
      withClientRef(db, { caseId, tool: 't', clientRef: 'boom' }, () => {
        throw new Error('业务层炸了');
      }),
    ).toThrow('业务层炸了');
    expect(agentWrites()).toHaveLength(0);
  });

  /**
   * 唯一索引是**跨进程的兜底**，不是助手里那次 SELECT 的重复品：两个进程同时抢一个
   * client_ref 时，先查后写之间没有锁，靠的就是它把后到那笔顶回去（整笔事务回滚，
   * 助手再重查一次回先到那笔的 target）。所以这里直接绕开助手验索引本身——
   * 索引没了的话，助手的快路径看起来照样对，只有并发时才双写。
   */
  it('唯一索引把同 (案件, 工具, ref) 的第二条台账挡在库外（变异：删掉该索引 → 红）', () => {
    withClientRef(db, { caseId, tool: 't', clientRef: 'ref-1' }, insertEvent('甲'));
    expect(() =>
      db
        .prepare(
          'INSERT INTO agent_writes (case_id, tool, client_ref, target_table, target_id) VALUES (?,?,?,?,?)',
        )
        .run(caseId, 't', 'ref-1', 'timeline_events', 999),
    ).toThrow(/UNIQUE/);

    // client_ref 为 NULL 的行不受这把键约束（部分索引），同案同工具可以有很多条
    const insertNull = () =>
      db
        .prepare(
          'INSERT INTO agent_writes (case_id, tool, client_ref, target_table, target_id) VALUES (?,?,NULL,?,?)',
        )
        .run(caseId, 't', 'timeline_events', 999);
    expect(() => {
      insertNull();
      insertNull();
    }).not.toThrow();
  });

  it('key_id 记得住（走 api key 的写入可追到是哪把钥匙干的）', () => {
    const uid = (db.prepare('SELECT user_id AS u FROM cases WHERE id = ?').get(caseId) as { u: number }).u;
    const keyId = Number(
      db
        .prepare('INSERT INTO api_keys (user_id, name, key_hash, scopes) VALUES (?,?,?,?)')
        .run(uid, 'k', 'hash', 'case:read case:write').lastInsertRowid,
    );
    withClientRef(db, { caseId, tool: 't', clientRef: 'r', keyId }, insertEvent('甲'));
    const row = db.prepare('SELECT key_id AS k FROM agent_writes').get() as { k: number };
    expect(row.k).toBe(keyId);
  });
});
