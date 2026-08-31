// app/src/lib/db/__tests__/migrate-interrupt-recovery.test.ts
// 判据 A8：**迁移中途炸掉之后，复跑必须收敛到与一次跑通完全相同的表结构。**
//
// ── 为什么这条要单独测，而不是「幂等测试已经覆盖了」──
// 幂等测的是「跑完一遍再跑一遍不出事」；本条测的是「跑了一半炸了，再跑一遍能不能补齐」。
// 这两件事在一个**没有事务**的迁移框架里不是同一件事：
// 2026-08-26 实测过人为中断留下 22/38 张表、重跑既不前进也不后退的形态。
// 现在之所以能收敛，是因为每一步都是 CREATE ... IF NOT EXISTS 或 addColumnIfMissing——
// **安全是「改动足够简单」给的，不是框架给的**。本次一口气加了 6 张表 + 12 列，
// 风险面显著变大，所以把这条从口头承诺变成机检。
//
// 判据用的是**表结构全等**（sqlite_master 的 type/name/sql 全表比对），
// 不是「表名单对得上」：只比表名会漏掉「表在但少了一列」和「唯一索引没建起来」，
// 而那两种恰好是本次改动新增的失败面（部分唯一索引 uq_company_litigation_dossier
// 依赖 dossier_id 列先加上）。
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { runMigrations } from '../migrate';

type SchemaRow = { type: string; name: string; sql: string | null };

function schemaOf(db: Database.Database): SchemaRow[] {
  return db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as SchemaRow[];
}

function newDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * 把库包一层：第 n 次 db.exec 抛错，模拟迁移跑到一半进程被杀 / 磁盘满 / 语句报错。
 * 其余方法原样转发——**必须转发 prepare**，addColumnIfMissing 靠它做 PRAGMA table_info。
 */
function dbThatDiesAtExec(db: Database.Database, n: number): Database.Database {
  let count = 0;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'exec') {
        return (sql: string) => {
          count += 1;
          if (count === n) throw new Error(`模拟中断：第 ${n} 次 db.exec`);
          return target.exec(sql);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Database.Database;
}

describe('A8 迁移：幂等 + 中断复跑收敛', () => {
  const reference = (() => {
    const db = newDb();
    runMigrations(db);
    const s = schemaOf(db);
    db.close();
    return s;
  })();

  it('先证明参照系是真的（表与索引都数到了，不是空清单）', () => {
    expect(reference.filter((r) => r.type === 'table').length).toBeGreaterThanOrEqual(45);
    expect(reference.some((r) => r.name === 'company_dossiers')).toBe(true);
    expect(reference.some((r) => r.name === 'uq_company_litigation_dossier')).toBe(true);
    expect(reference.some((r) => r.name === 'pricing_config')).toBe(true);
  });

  it('空库连跑两遍：表结构不变，且没有重复行', () => {
    const db = newDb();
    runMigrations(db);
    const once = schemaOf(db);
    runMigrations(db);
    expect(schemaOf(db)).toEqual(once);
    expect(once).toEqual(reference);
    db.close();
  });

  // 断点铺满整条迁移链：只挑几个点会漏掉「恰好那一步不幂等」。
  // 逐个 exec 断点试一遍，成本也就几十毫秒。原本 45 个建表 exec，
  // §2.3 免费前置探测又加了 2 张表（company_probe_cache / company_probe_events），故 47。
  const BREAKPOINTS = Array.from({ length: 47 }, (_, i) => i + 1);

  it.each(BREAKPOINTS)('第 %i 次 db.exec 处中断，复跑后表结构与一次跑通全等', (n) => {
    const db = newDb();
    expect(() => runMigrations(dbThatDiesAtExec(db, n))).toThrow(/模拟中断/);

    // 复跑（这次不拦），必须补齐到与参照系完全一样
    runMigrations(db);
    expect(schemaOf(db)).toEqual(reference);

    // 再跑一遍仍然不变（中断留下的半截库不该让后续迁移变得不幂等）
    runMigrations(db);
    expect(schemaOf(db)).toEqual(reference);
    db.close();
  });

  // 对照臂：如果中断根本没发生，上面那条 it.each 就只是把幂等测了 45 遍。
  // 这里证明「中断」确实留下了一个残缺的库——判据分辨得出「炸了」与「没炸」。
  it('对照臂：中断确实留下半截库（否则上面那 45 条只是幂等的复读）', () => {
    const db = newDb();
    expect(() => runMigrations(dbThatDiesAtExec(db, 20))).toThrow();
    const partial = schemaOf(db);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(reference.length);
    expect(partial.some((r) => r.name === 'company_dossiers')).toBe(false);
    db.close();
  });
});
