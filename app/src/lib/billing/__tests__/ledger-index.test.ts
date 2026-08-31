// app/src/lib/billing/__tests__/ledger-index.test.ts
//
// 「我的」页热路径必须走索引，不许全表扫。
//
// ── 为什么单给这条路径加测试 ──
// gongdao_ledger 只追加不删，是全库增长最快的一张表。listGongdaoLedger 每次访问打两条
// WHERE user_id=?（流水分页 + 账本合计 SUM）。没有 (user_id, ...) 索引时二者都是全表 SCAN：
// 代价随**全站**流水总量线性涨，而不是随这个用户自己的行数涨——单人体验会被别人的用量拖垮，
// 且功能全程正确、只是越来越慢，没有任何报错会提醒谁。这是本仓唯一一条「不改也会自己走到崩」
// 的路径，所以它的索引不能只靠 migrate.ts 里一行 DDL 立在那儿没人看着。
//
// ── 这条测试为什么能真的看住 ──
// 它**不抄** SQL：用一层 prepare 代理跑真的 listGongdaoLedger，抓它实际下发的语句去 EXPLAIN。
// 抄一份 SQL 到测试里的话，改了 lib 侧的查询、测试照样绿——验的就成了测试自己那份副本。
// 同一节里还有对照臂（DROP 掉索引 → 必须退回 SCAN），否则「计划里没有 SCAN」与
// 「计划文本没读到 / 断言写错了」两种情形输出一模一样。
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate';
import { listGongdaoLedger } from '../index';

/** 被看住的索引名。与 migrate.ts 的 DDL 同名，改名必须两处一起改（否则本测试当场红）。 */
const INDEX_NAME = 'idx_gongdao_ledger_user';

/**
 * 页面实际取多少条流水。取 50 是 listGongdaoLedger 的默认 limit——
 * 这里刻意不传，让默认值也进被测范围。
 */
const PAGE_LIMIT_DEFAULT = 50;

/** 造够多行，免得 SQLite 在小表上「反正也没几行」地绕开索引，把测试变成一句空话。 */
const ROWS_PER_USER = 200;

function makeDb(): { db: Database.Database; uid: number } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const mkUser = (email: string) =>
    Number(db.prepare('INSERT INTO users (email) VALUES (?)').run(email).lastInsertRowid);
  const uid = mkUser('me@t.com');
  const other = mkUser('other@t.com');
  const ins = db.prepare(
    'INSERT INTO gongdao_ledger (user_id, delta, type, ref_id, feature) VALUES (?,?,?,?,?)',
  );
  // 两个人的流水交错落，让「按 user_id 命中」与「按 id 倒序取前 N」都不是碰巧成立
  for (let i = 0; i < ROWS_PER_USER; i++) {
    ins.run(uid, -1, '消耗', `me-${i}`, '问诊');
    ins.run(other, -1, '消耗', `other-${i}`, '问诊');
  }
  db.prepare('INSERT INTO gongdao (user_id, balance) VALUES (?,?)').run(uid, -ROWS_PER_USER);
  db.exec('ANALYZE');
  return { db, uid };
}

/**
 * 跑一次真的 listGongdaoLedger，返回它实际下发的、打在 gongdao_ledger 上的 SQL 原文。
 *
 * 代理只截 prepare、别的成员原样转发（函数要绑回真 db，better-sqlite3 的方法认 this）。
 * 过滤 gongdao_ledger 是因为同一次调用还会读 gongdao 表的物化余额——那条走主键，不在本测题内。
 */
function ledgerSqlIssued(db: Database.Database): string[] {
  const seen: string[] = [];
  const spy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          seen.push(sql);
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Database.Database;
  listGongdaoLedger(1, PAGE_LIMIT_DEFAULT, spy);
  return seen.filter((s) => /\bFROM\s+gongdao_ledger\b/i.test(s));
}

/** EXPLAIN QUERY PLAN 的全部 detail 拼成一行。占位符按数量补 1（计划与参数取值无关）。 */
function planOf(db: Database.Database, sql: string, uid: number): string {
  const holes = (sql.match(/\?/g) ?? []).length;
  const args = Array.from({ length: holes }, (_, i) => (i === 0 ? uid : PAGE_LIMIT_DEFAULT));
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[];
  return rows.map((r) => r.detail).join(' | ');
}

describe('「我的」页账本查询走索引', () => {
  test('listGongdaoLedger 恰好打两条 gongdao_ledger 查询（分页 + 合计）', () => {
    const { db } = makeDb();
    const sqls = ledgerSqlIssued(db);
    expect(
      sqls,
      '抓到的语句数不是 2：查询被改写/合并/新增了，下面两条计划断言可能已经不在测原来那条路径上',
    ).toHaveLength(2);
    // 合计必须仍然从账本算——「余额 vs 账本合计」不一致告警靠它才有意义，
    // 改成读 gongdao.balance 的话两个数永远相等，那条完整性告警就成了摆设。
    expect(sqls.some((s) => /SUM\s*\(\s*delta\s*\)/i.test(s)), '账本合计不再从流水 SUM 求得').toBe(true);
    expect(sqls.some((s) => /ORDER\s+BY\s+id\s+DESC/i.test(s)), '分页查询不再按 id 倒序取').toBe(true);
  });

  test(`两条查询都走 ${INDEX_NAME}，都不是全表 SCAN`, () => {
    const { db, uid } = makeDb();
    for (const sql of ledgerSqlIssued(db)) {
      const plan = planOf(db, sql, uid);
      expect(plan, `没走索引：\n  SQL: ${sql}\n  计划: ${plan}`).toContain(INDEX_NAME);
      expect(plan, `退化成全表扫：\n  SQL: ${sql}\n  计划: ${plan}`).not.toMatch(
        /SCAN\s+gongdao_ledger/i,
      );
    }
  });

  test('分页查询不需要临时 B 树排序（排序键 id DESC 已在索引里）', () => {
    const { db, uid } = makeDb();
    const page = ledgerSqlIssued(db).find((s) => /ORDER\s+BY/i.test(s));
    expect(page, '没抓到带 ORDER BY 的那条分页查询').toBeDefined();
    const plan = planOf(db, page!, uid);
    expect(plan, `分页仍要排全部候选行：\n  计划: ${plan}`).not.toMatch(/TEMP B-TREE/i);
  });

  // 对照臂：把索引摘掉必须退回 SCAN。没有这一节，上面两条与「EXPLAIN 读空了 / 正则写错了」同形。
  test('对照臂：DROP 掉该索引后两条查询都退回 SCAN（证明上面断言不是空话）', () => {
    const { db, uid } = makeDb();
    const sqls = ledgerSqlIssued(db);
    db.exec(`DROP INDEX ${INDEX_NAME}`);
    for (const sql of sqls) {
      const plan = planOf(db, sql, uid);
      expect(plan, `摘掉索引后仍未退回 SCAN，说明它命中的是别的索引：\n  计划: ${plan}`).toMatch(
        /SCAN\s+gongdao_ledger/i,
      );
      expect(plan).not.toContain(INDEX_NAME);
    }
  });

  test('索引由 runMigrations 建出，且重跑幂等（只此一条，不重复不报错）', () => {
    const { db } = makeDb();
    const count = () =>
      (
        db
          .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name=?")
          .get(INDEX_NAME) as { c: number }
      ).c;
    expect(count()).toBe(1);
    expect(() => runMigrations(db)).not.toThrow();
    expect(count()).toBe(1);
  });
});
