// app/src/lib/db/__tests__/time.test.ts
// canonical 时间格式锁死（ADR-002）：格式、与 SQLite datetime('now') 可比、与 DDL 默认值同序，
// 以及把「ISO 串混进来就排序错乱」这条事故成因钉成回归测试。
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate';
import { nowSql, toSql } from '../time';
import { nowSql as nowSqlFromIndex, toSql as toSqlFromIndex } from '../index';

/** canonical：UTC、空格分隔、秒精度、无毫秒无时区后缀。 */
const CANONICAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const sqlNow = (db: Database.Database) =>
  (db.prepare("SELECT datetime('now') AS t").get() as { t: string }).t;

describe('格式', () => {
  test('nowSql / toSql 均产出 canonical 串', () => {
    expect(nowSql()).toMatch(CANONICAL);
    expect(toSql(new Date())).toMatch(CANONICAL);
  });

  test('toSql 锚点：已知 Date → 已知串（UTC，不受本机时区影响）', () => {
    expect(toSql(new Date(Date.UTC(2026, 7, 19, 3, 38, 45)))).toBe('2026-08-19 03:38:45');
    expect(toSql(new Date('2026-01-02T00:00:00.000Z'))).toBe('2026-01-02 00:00:00');
    expect(toSql(new Date(0))).toBe('1970-01-01 00:00:00');
  });

  test('毫秒截断而非进位（与 SQLite datetime() 一致）', () => {
    expect(toSql(new Date(Date.UTC(2026, 7, 19, 3, 38, 45, 999)))).toBe('2026-08-19 03:38:45');
  });

  test('非法 Date 抛错，绝不往库里写 Invalid Date', () => {
    expect(() => toSql(new Date('不是时间'))).toThrow(RangeError);
  });

  test('经 lib/db 桶文件导出（跨模块只走 lib/db 接口）', () => {
    expect(nowSqlFromIndex).toBe(nowSql);
    expect(toSqlFromIndex).toBe(toSql);
  });
});

describe('与 SQLite datetime(\'now\') 同格式同秒', () => {
  test('SQL 的 now 落在助手前后两次取值之间（纯字符串比较即可判定）', () => {
    const db = makeDb();
    const before = nowSql();
    const fromSql = sqlNow(db);
    const after = nowSql();
    expect(fromSql).toMatch(CANONICAL);
    // 同为 canonical 串 → 直接字典序比较就是时间序，无需 parse
    expect(fromSql >= before).toBe(true);
    expect(fromSql <= after).toBe(true);
  });

  test('datetime(?) 对 canonical 串是恒等变换（归一后仍是自己）', () => {
    const db = makeDb();
    const t = toSql(new Date(Date.UTC(2026, 7, 19, 3, 38, 45)));
    const normalized = (db.prepare('SELECT datetime(?) AS t').get(t) as { t: string }).t;
    expect(normalized).toBe(t);
  });
});

describe('与 DDL 默认值产出的串直接字符串比较有序', () => {
  test('DDL 默认 created_at 与助手串可直接比较，且排序正确', () => {
    const db = makeDb();
    const before = nowSql();
    const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('t@t.com').lastInsertRowid);
    const created = (db.prepare('SELECT created_at FROM users WHERE id=?').get(uid) as { created_at: string }).created_at;
    const after = nowSql();

    expect(created).toMatch(CANONICAL);
    expect(created >= before && created <= after, `${before} <= ${created} <= ${after}`).toBe(true);
  });

  test('应用层写入的时间列与 DDL 默认值同序：ORDER BY 时间串结果正确', () => {
    const db = makeDb();
    const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('t@t.com').lastInsertRowid);
    const caseId = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '测试案件').lastInsertRowid,
    );
    // 三条期限：过去 / 现在（DDL 默认时刻附近）/ 未来，due_at 全部经 toSql 写入
    const ins = db.prepare('INSERT INTO deadlines (case_id, kind, due_at) VALUES (?,?,?)');
    const day = 86_400_000;
    ins.run(caseId, '未来', toSql(new Date(Date.now() + day)));
    ins.run(caseId, '过去', toSql(new Date(Date.now() - day)));
    ins.run(caseId, '现在', nowSql());

    const order = (db.prepare('SELECT kind FROM deadlines WHERE case_id=? ORDER BY due_at').all(caseId) as
      { kind: string }[]).map((r) => r.kind);
    expect(order).toEqual(['过去', '现在', '未来']);

    // 与 SQL 侧的 datetime('now') 混用比较也正确：「过去」已到期、「未来」没到
    // （「现在」那条落在边界上，同秒即算到期，不做断言）
    const due = (db.prepare("SELECT kind FROM deadlines WHERE case_id=? AND due_at <= datetime('now')").all(caseId) as
      { kind: string }[]).map((r) => r.kind);
    expect(due).toContain('过去');
    expect(due).not.toContain('未来');
  });
});

describe('回归钉子：ISO 串混入即排序错乱（ADR-002 事故成因）', () => {
  test("裸 toISOString() 串恒排在同日 canonical 串之后（'T' > ' '）", () => {
    const iso = new Date(Date.UTC(2026, 7, 19, 0, 0, 0)).toISOString(); // 2026-08-19T00:00:00.000Z
    const canonicalSameDayLater = '2026-08-19 23:59:59';               // 同日更晚的 canonical 串
    // 时间上 iso 更早，字典序却更大——这就是当年 OTP 冷却被绕过的成因
    expect(iso > canonicalSameDayLater).toBe(true);
    // 助手产出的串没有这个问题
    expect(toSql(new Date(Date.UTC(2026, 7, 19, 0, 0, 0))) < canonicalSameDayLater).toBe(true);
  });

  test('ISO 串写进时间列会污染 ORDER BY，canonical 串不会', () => {
    const db = makeDb();
    const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('t@t.com').lastInsertRowid);
    const caseId = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '测试案件').lastInsertRowid,
    );
    const ins = db.prepare('INSERT INTO deadlines (case_id, kind, due_at) VALUES (?,?,?)');
    const early = new Date(Date.UTC(2026, 7, 19, 0, 0, 0));
    const late = new Date(Date.UTC(2026, 7, 19, 23, 59, 59));

    ins.run(caseId, '早-ISO', early.toISOString()); // 违规写法
    ins.run(caseId, '晚-canonical', toSql(late));
    const bad = (db.prepare('SELECT kind FROM deadlines WHERE case_id=? ORDER BY due_at').all(caseId) as
      { kind: string }[]).map((r) => r.kind);
    expect(bad).toEqual(['晚-canonical', '早-ISO']); // 早的排到了后面

    // 同一批数据经 datetime() 归一后排序恢复正确（存量脏串的补救口径）
    const fixed = (db.prepare('SELECT kind FROM deadlines WHERE case_id=? ORDER BY datetime(due_at)').all(caseId) as
      { kind: string }[]).map((r) => r.kind);
    expect(fixed).toEqual(['早-ISO', '晚-canonical']);
  });
});
