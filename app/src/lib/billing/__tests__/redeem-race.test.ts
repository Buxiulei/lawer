// app/src/lib/billing/__tests__/redeem-race.test.ts
// 同一条码被 8 个**独立进程**同时兑：只能到账一次。
//
// 【这一组与 redeem.test.ts 里那条「二次核销返回 used」是两回事】那条是**顺序**重放：
// 第一次兑完了，第二次进来时 redeemed_by 已经写好，靠的是那个前置 if 就能挡住。
// 这一组是**并发**：八个进程的 SELECT 全都读到 redeemed_by IS NULL，八个都过了前置检查，
// 唯一挡得住的是 `UPDATE ... WHERE redeemed_by IS NULL` 那条单语句 CAS。
// 把 CAS 的 WHERE 去掉，redeem.test.ts 全绿，这里当场红。
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test } from 'vitest';

import { runMigrations } from '../../db/migrate';
import { issueRedeemCodes } from '../redeem';

const execFileAsync = promisify(execFile);

const APP_DIR = process.cwd();
const TSX = path.join(APP_DIR, 'node_modules', '.bin', 'tsx');
const WORKER = path.join(APP_DIR, 'src/lib/billing/__tests__/redeem-race-worker.ts');

const ARMS = 8;
const FACE_VALUE = 500;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redeem-race-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function makeFileDb(): { dbPath: string; uid: number; code: string } {
  const dbPath = path.join(tmpDir, `${crypto.randomUUID()}.db`);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  // WAL：多连接下读不挡写。默认的 rollback journal 在这个场景里会把并发退化成排队。
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('race@t.com').lastInsertRowid);
  const [code] = issueRedeemCodes(db, { count: 1, gongdaoValue: FACE_VALUE });
  db.close();
  return { dbPath, uid, code };
}

async function runArms(dbPath: string, uid: number, code: string): Promise<string[]> {
  // 起跑时刻放在未来一点点：各进程冷启动要几百毫秒，不对表就成了顺序执行。
  const startAt = Date.now() + 3000;
  const arms = Array.from({ length: ARMS }, () =>
    execFileAsync(TSX, [WORKER, dbPath, String(uid), code, String(startAt)], {
      cwd: APP_DIR,
      timeout: 60_000,
    }).then((r) => r.stdout.trim()),
  );
  return Promise.all(arms);
}

describe('同码并发双兑', () => {
  test(
    `${ARMS} 个进程同时兑同一条码：恰好一个成功，公道值只加一次`,
    async () => {
      const { dbPath, uid, code } = makeFileDb();
      const outs = await runArms(dbPath, uid, code);

      // 先把异常臂点名。默默过滤掉 err: 会让「八个进程全崩了」看起来像「一个成功七个失败」的反面
      const errs = outs.filter((o) => o.startsWith('err:'));
      expect(errs, `有进程抛异常：${errs.join(' | ')}`).toEqual([]);

      const oks = outs.filter((o) => o.startsWith('ok:'));
      const fails = outs.filter((o) => o.startsWith('fail:'));
      expect(oks, `成功臂：${outs.join(' | ')}`).toHaveLength(1);
      expect(fails).toHaveLength(ARMS - 1);
      // 落败的一律 used——不是 not_found（那说明读到了别的东西），也不是别的原因
      expect(new Set(fails.map((f) => f.slice('fail:'.length)))).toEqual(new Set(['used']));

      const db = new Database(dbPath, { readonly: true });
      const ledger = db
        .prepare("SELECT COUNT(*) c, COALESCE(SUM(delta),0) s FROM gongdao_ledger WHERE type='兑换'")
        .get() as { c: number; s: number };
      const balance = (db.prepare('SELECT balance FROM gongdao WHERE user_id=?').get(uid) as {
        balance: number;
      }).balance;
      const sum = (db.prepare('SELECT COALESCE(SUM(delta),0) s FROM gongdao_ledger WHERE user_id=?').get(uid) as {
        s: number;
      }).s;
      const claimed = db.prepare('SELECT redeemed_by FROM redemption_codes WHERE code=?').get(code) as {
        redeemed_by: number | null;
      };
      db.close();

      expect(ledger.c).toBe(1); // 一条码一笔流水
      expect(ledger.s).toBe(FACE_VALUE); // 面值只入一次
      expect(balance).toBe(FACE_VALUE);
      expect(sum).toBe(balance); // 不变量：物化余额 ≡ Σledger
      expect(claimed.redeemed_by).toBe(uid);
    },
    120_000,
  );
});
