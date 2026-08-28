// app/src/lib/db/client.ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from './migrate';

/**
 * 库路径在**首次 getDb() 时**求值，不在模块加载时。
 *
 * 【为什么改掉原来那个顶层 const】它在 import 的那一刻就把 DB_PATH 冻死了，
 * 于是「谁先 import 了这个模块」变成了一个会改变行为、却没人看得见的输入：
 *  · 测试在 beforeAll 里设好 DB_PATH 再动态 import 自己那几个路由——**只对第一个文件有效**；
 *    同一 worker 里别的文件先加载过 client.ts，这个常量早就是默认值了。
 *  · 本机默认值 `<cwd>/data/lawer.db` 恰好存在（且被 gitignore），所以**测试静默写进开发库**、
 *    一路全绿；干净检出里那个目录不存在，才炸成「Cannot open database」。
 *    —— 2026-08-28 CI 首跑抓到，本机挪走 app/data 可完整复现。
 * `scripts/acceptance-billing.ts` 早就记过这个坑（"脚本里再设已经晚了"），
 * 但当时的处置是**绕开**（要求外面传），坑本身留着。这次把它拿掉。
 *
 * 【为什么顺手建目录】新克隆的仓里 app/data/ 不存在（gitignore），
 * 不建的话第一次 `npm run dev` 就炸在一个跟业务无关的地方。
 * 这不会掩盖上面那个 bug——lazy 求值已经让「测试漏到默认路径」不可能发生了。
 */
/**
 * 测试期禁止落到默认库路径（评测官 2026-08-28 提，我实现）。
 *
 * 惰性求值修掉了「谁先 import」那个顺序问题，**但没修兜底问题**：
 * 任何忘了设 DB_PATH 的测试，仍会静默写进 `<cwd>/data/lawer.db`——那是开发库，
 * 而它被 gitignore、没人 review，于是"跑过测试的人开发库里混着测试数据"。
 * 实测当前全量无人落到这里（把 app/data 挪走跑全量，目录没被造回来），
 * **但那是"现在没有"不是"不可能"**。这道闸把它变成后者：
 * 规则要人记得，能力要人绕过。
 */
function defaultDbPath(): string {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    throw new Error(
      '测试期不许用默认库路径：请在 beforeAll 里设 process.env.DB_PATH（临时文件），' +
        '否则会静默写进开发库 <cwd>/data/lawer.db。',
    );
  }
  return path.join(process.cwd(), 'data', 'lawer.db');
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    const dbPath = process.env.DB_PATH ?? defaultDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    runMigrations(_db);
  }
  return _db;
}
