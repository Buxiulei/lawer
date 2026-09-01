// app/src/lib/db/__tests__/cli-open.test.ts
// CLI 开库时的迁移。
//
// 【这组判据钉的是一次真实事故】2026-08-29 第十一窗实弹：
// `deadline-reminder --apply` 首跑崩在 `no such table: job_runs`。
// 迁移由 app 侧惰性执行，而 CLI 自己开库 ⇒ **滚更后 app 没被任何请求碰过时，cron 必崩**。
// 崩的位置在 cron 日志里，没人看 ⇒ 一条法定期限提醒链**静默死掉，且外表看不出来**。
//
// 所以下面第一条测试不是测一个函数，是**把那次事故本身钉住**：
// 库里其它表都在、唯独最新那张不在——这正是"滚更后未被访问"的形态。
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { openCliDb, rethrowIfSchemaStale, SchemaNotMigratedError } from '../cli-open';
import { runMigrations } from '../migrate';
import { reminderCli } from '../../notify/deadline-reminder';
import { reconcileCli } from '../reconcile';

// 本文件每条用例都要在磁盘上建库、跑一整套迁移（磁盘库每条 DDL 一次 fsync）；单跑就已
// 实耗数秒，全量跑批里和几十个同样吃 CPU 的文件挤在一起，默认 5s 的余量不够——超时红过，
// 但代码一行没错。放宽的**只是这个文件**：全局改宽会把真慢化一起盖掉。
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const tmps: string[] = [];

/** 造一个"滚更前"的库：完整结构，但缺掉指定的表。 */
function staleDb(missing: string[]): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cliopen-')), 'lawer.db');
  tmps.push(p);
  const db = new Database(p);
  runMigrations(db);
  for (const t of missing) db.exec(`DROP TABLE IF EXISTS ${t}`);
  db.close();
  return p;
}

function hasTable(p: string, t: string): boolean {
  const db = new Database(p, { readonly: true });
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  db.close();
  return !!row;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const p of tmps.splice(0)) fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

describe('CLI 开库时补迁移', () => {
  test('【事故复现】库缺 job_runs 时，期限提醒 --apply 不再崩，而是把表补上后跑完', async () => {
    const p = staleDb(['job_runs']);
    expect(hasTable(p, 'job_runs')).toBe(false); // 前置条件成立才算复现

    const rc = await reminderCli(p, { apply: true });

    expect(rc).toBe(0);
    expect(hasTable(p, 'job_runs')).toBe(true);
    // 并且真的留了痕——不是"没崩"就算过，得证明它把活干到了记账那一步
    const db = new Database(p, { readonly: true });
    const r = db
      .prepare("SELECT ok, finished_at FROM job_runs WHERE job_name='期限提醒'")
      .all() as { ok: number; finished_at: string | null }[];
    db.close();
    expect(r.length).toBe(1); // 恰好一行：既不是没跑（0），也不是被重复记账
    expect(r[0].finished_at).not.toBeNull(); // 跑完了，不是"起跑了就崩"的中间态
  });

  test('可写开库会补齐结构，并且**只在真的改了东西时**出声', () => {
    const p = staleDb(['job_runs']);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const db1 = openCliDb(p);
    expect(hasTable(p, 'job_runs')).toBe(true);
    expect(log.mock.calls.flat().join('\n')).toContain('表结构已补齐');
    db1.close();

    // 第二次已经是最新的：不许再喊一遍，否则每次跑 CLI 都像刚发生过一次迁移
    log.mockClear();
    const db2 = openCliDb(p);
    expect(log.mock.calls.flat().join('\n')).not.toContain('表结构已补齐');
    db2.close();
  });

  test('只读开库不写库：结构照旧缺着（跑不了迁移是事实，不能假装跑了）', () => {
    const p = staleDb(['job_runs']);
    const db = openCliDb(p, { readonly: true, fileMustExist: true });
    db.close();
    expect(hasTable(p, 'job_runs')).toBe(false);
  });

  test('只读路径缺表时给的是自述错误——说清「为什么」和「怎么办」，不是一句 no such table', () => {
    const p = staleDb(['token_usage']);
    let err: unknown;
    try {
      reconcileCli(p);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SchemaNotMigratedError);
    const msg = (err as Error).message;
    expect(msg).toContain('表结构不是最新的');
    expect(msg).toContain('惰性执行'); // 为什么会这样
    expect(msg).toContain('怎么办'); // 下一步做什么
    expect(msg).toContain(p); // 到底是哪个库
  });

  test('非结构类错误原样抛，不许被裹成「结构不是最新」', () => {
    const boom = new Error('database is locked');
    expect(() => rethrowIfSchemaStale(boom, '/x/y.db')).toThrow('database is locked');
    try {
      rethrowIfSchemaStale(boom, '/x/y.db');
    } catch (e) {
      expect(e).not.toBeInstanceOf(SchemaNotMigratedError);
    }
  });
});
