// app/src/lib/cases/__tests__/fixtures.ts
// 测试夹具：真实 migrate 建 :memory: 库 + 造两个用户各自的案件，
// 好让「跨用户访问必须拒绝」这条红线有东西可撞。
import BetterSqlite3, { type Database } from 'better-sqlite3';

import { runMigrations } from '@/lib/db/migrate';

export interface Fixture {
  db: Database;
  /** 甲：拥有 caseId */
  userA: number;
  /** 乙：什么都不该看到甲的 */
  userB: number;
  caseA: number;
  caseB: number;
  actionA: number;
}

export function makeFixture(): Fixture {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-08-19T00:00:00.000Z')",
  );
  const userA = Number(insertUser.run('hash-a').lastInsertRowid);
  const userB = Number(insertUser.run('hash-b').lastInsertRowid);

  const insertCase = db.prepare(
    "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, ?, '风声', '2026-08-19T00:00:00.000Z')",
  );
  const caseA = Number(insertCase.run(userA, '甲的案子').lastInsertRowid);
  const caseB = Number(insertCase.run(userB, '乙的案子').lastInsertRowid);

  const actionA = Number(
    db
      .prepare(
        "INSERT INTO action_items (case_id, title, status, priority, created_at) VALUES (?, '去打社保记录', '待办', 1, '2026-08-19T00:00:00.000Z')",
      )
      .run(caseA).lastInsertRowid,
  );

  db.prepare(
    "INSERT INTO deadlines (case_id, kind, due_at, created_at) VALUES (?, '仲裁时效', '2027-08-01T00:00:00.000Z', '2026-08-19T00:00:00.000Z')",
  ).run(caseA);

  // evidence 需要一条 files 行（外键）
  const fileId = Number(
    db
      .prepare(
        "INSERT INTO files (sha256, size, mime, enc_path, created_at) VALUES ('abc123', 10, 'image/png', '/x', '2026-08-19T00:00:00.000Z')",
      )
      .run().lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO evidence (case_id, user_id, file_id, name, category, status, created_at) VALUES (?, ?, ?, '劳动合同', '合同', '已上传', '2026-08-19T00:00:00.000Z')",
  ).run(caseA, userA, fileId);

  return { db, userA, userB, caseA, caseB, actionA };
}
