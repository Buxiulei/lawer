// app/src/lib/db/__tests__/action-item-dedup.test.ts
// insertActionItem 同题待办去重：写接口无幂等，agent 重试即重放——
// 生产 case2 实测三张卡各写两遍（action_items 6 行 3 个标题）。这里把去重的两头钉死：
// 同题待办不双建、**已完成后同题再建仍允许**（后者是变异臂：去掉状态条件就会红）。
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { insertActionItem } from '@/lib/db/agent';
import { runMigrations } from '@/lib/db/migrate';

let db: Database;
let caseId: number;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const userId = Number(
    db
      .prepare("INSERT INTO users (phone_hash, auth_status, created_at) VALUES ('h', '未认证', '2026-08-19T00:00:00.000Z')")
      .run().lastInsertRowid,
  );
  caseId = Number(
    db
      .prepare("INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, '案子', '风声', '2026-08-19T00:00:00.000Z')")
      .run(userId).lastInsertRowid,
  );
});

const add = (title: string) =>
  insertActionItem(db, { caseId, title, detail: null, dueAt: null, priority: 0, sourceMessageId: null });

const pendingCount = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM action_items WHERE case_id = ?').get(caseId) as { n: number }).n;

describe('行动卡同题待办去重', () => {
  it('同题重放不双建：回既有卡 id、created:false，库里仍是一行', () => {
    const first = add('今天 18 点前导出考勤记录');
    expect(first.created).toBe(true);

    const again = add('今天 18 点前导出考勤记录');
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id);
    expect(pendingCount()).toBe(1);
  });

  it('标题只差空白与标点也算同一张：不双建', () => {
    const first = add('今天 18 点前导出考勤记录');
    const dup = add('今天18点前导出考勤记录。');
    expect(dup.created).toBe(false);
    expect(dup.id).toBe(first.id);
    expect(pendingCount()).toBe(1);
  });

  it('已完成后同题再建允许（变异臂：去掉「状态为待办」条件这条会红）', () => {
    const first = add('今天 18 点前导出考勤记录');
    // 办完了——待办态被清掉
    db.prepare("UPDATE action_items SET status = '完成' WHERE id = ?").run(first.id);

    const reAdd = add('今天 18 点前导出考勤记录');
    expect(reAdd.created).toBe(true);
    expect(reAdd.id).not.toBe(first.id);
    // 一张已完成 + 一张新待办 = 两行
    expect(pendingCount()).toBe(2);
  });
});
