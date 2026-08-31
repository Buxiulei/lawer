// app/src/lib/billing/__tests__/pricing-config.test.ts
// pricing_config 唯一读入口的判据：表里有行取表、缺行回落常量、改表立刻生效、脏值当场炸。
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { runMigrations } from '../../db/migrate';
import { readConfigInt } from '../pricing-config';

function newDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('readConfigInt', () => {
  it('缺行回落调用方给的兜底值', () => {
    const db = newDb();
    expect(readConfigInt(db, 'dossier.graph', 480)).toBe(480);
    db.close();
  });

  it('有行以表为准，且改表**不重启进程**即刻生效', () => {
    const db = newDb();
    db.prepare('INSERT INTO pricing_config (key, value_int) VALUES (?,?)').run('dossier.graph', 999);
    expect(readConfigInt(db, 'dossier.graph', 480)).toBe(999);

    db.prepare('UPDATE pricing_config SET value_int = ? WHERE key = ?').run(123, 'dossier.graph');
    expect(readConfigInt(db, 'dossier.graph', 480)).toBe(123); // 同一个进程里立刻变

    db.prepare('DELETE FROM pricing_config WHERE key = ?').run('dossier.graph');
    expect(readConfigInt(db, 'dossier.graph', 480)).toBe(480); // 删行即回落常量
    db.close();
  });

  it('非整数当场抛错（静默取整会让门槛在边界上安静失效）', () => {
    const db = newDb();
    db.prepare('INSERT INTO pricing_config (key, value_int) VALUES (?,?)').run(
      'dossier.min_sample_outcome',
      4.7,
    );
    expect(() => readConfigInt(db, 'dossier.min_sample_outcome', 5)).toThrow(/不是整数/);
    db.close();
  });
});
