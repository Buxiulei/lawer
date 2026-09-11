// app/src/lib/db/__tests__/event-type-set-at-migration.test.ts
// timeline_events.event_type_set_at 的**迁移判据**：可空、无默认值、不回填。
//
// 【为什么单独钉一条】这一列要区分的正是「登记时就选定的」与「事后回来补选的」。
// 给它一个 DDL 默认值（或顺手回填成 created_at）的形态是：**每一行看起来都被补选过**，
// 而那恰恰是它要分辨的那件事；库照常开、应用照常起、一处报错都没有。
// 反过来写成 NOT NULL 会让存量库上的 ADD COLUMN 直接失败 —— 应用起不来。
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../migrate';

const COLUMN = 'event_type_set_at';

function columns(db: Database) {
  return db.prepare('PRAGMA table_info(timeline_events)').all() as {
    name: string;
    dflt_value: string | null;
    notnull: number;
  }[];
}

/** 一个**跑过迁移之后再把这一列删掉**的库：等价于上线前那份存量库的形状 */
function legacyDb(): Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.exec(`ALTER TABLE timeline_events DROP COLUMN ${COLUMN}`);
  return db;
}

function seedLegacyEvent(db: Database): number {
  const userId = Number(
    db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('h', '已实名')").run()
      .lastInsertRowid,
  );
  const caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(userId, '老案子')
      .lastInsertRowid,
  );
  return Number(
    db
      .prepare(
        "INSERT INTO timeline_events (case_id, happened_at, kind, title, event_type)" +
          " VALUES (?, '2026-01-01', '公司动作', '老事件', 'x_type')",
      )
      .run(caseId).lastInsertRowid,
  );
}

describe(`timeline_events.${COLUMN}`, () => {
  it('对照臂：删掉之后那一列确实不在了（否则下面几条在验一个恒真的命题）', () => {
    const db = legacyDb();
    expect(columns(db).map((c) => c.name)).not.toContain(COLUMN);
    db.close();
  });

  it('🔴 存量库补得上这一列，而**老行不回填**（变异：给它 DDL 默认值或回填 → 红）', () => {
    const db = legacyDb();
    const id = seedLegacyEvent(db);

    runMigrations(db);

    const col = columns(db).find((c) => c.name === COLUMN);
    expect(col, '第二次迁移没有把这一列补上').toBeDefined();
    expect(col!.notnull, 'NOT NULL 会让存量库上的 ADD COLUMN 直接失败，应用起不来').toBe(0);
    expect(col!.dflt_value, '有默认值等于给每一行都盖上"被补选过"的戳').toBeNull();

    const row = db
      .prepare(`SELECT event_type, ${COLUMN} AS setAt FROM timeline_events WHERE id = ?`)
      .get(id) as { event_type: string | null; setAt: string | null };
    expect(row.event_type, '迁移不许动既有的 event_type').toBe('x_type');
    expect(row.setAt, '老行这一格必须是 NULL：没人改过它').toBeNull();
    db.close();
  });

  it('重跑迁移不炸（ADD COLUMN 没有 IF NOT EXISTS，第二次必须被 addColumnIfMissing 挡住）', () => {
    const db = legacyDb();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(columns(db).filter((c) => c.name === COLUMN)).toHaveLength(1);
    db.close();
  });

  it('新库直接就有这一列，且新写入的行默认为 NULL（登记时选的类型不算"改过"）', () => {
    const db = new BetterSqlite3(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const id = seedLegacyEvent(db);
    const row = db
      .prepare(`SELECT ${COLUMN} AS setAt FROM timeline_events WHERE id = ?`)
      .get(id) as { setAt: string | null };
    expect(row.setAt).toBeNull();
    db.close();
  });
});
