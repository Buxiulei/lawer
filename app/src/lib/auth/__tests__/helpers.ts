// app/src/lib/auth/__tests__/helpers.ts
// 测试库直接跑 WS1 的 runMigrations 建表，不另抄一份建表语句：
// 抄一份就会和生产 schema 悄悄漂移，而认证是最不该"本地全绿、线上列不存在"的模块。
import BetterSqlite3, { type Database } from 'better-sqlite3';

import { runMigrations } from '@/lib/db/migrate';

/**
 * @param file 落盘路径。默认 :memory:；给具体路径是为了能**关掉句柄再开一个新的**——
 *   「进程重启后限流还算不算数」这种判据，:memory: 库天然测不出来（新句柄=新空库）。
 */
export function makeTestDb(file: string = ':memory:'): Database {
  const db = new BetterSqlite3(file);
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** 读某手机号最新一条验证码的明文，用来在测试里"收到"验证码 */
export function lastSmsCode(db: Database, phoneHash: string): string {
  const row = db
    .prepare('SELECT code FROM sms_codes WHERE phone_hash = ? ORDER BY id DESC LIMIT 1')
    .get(phoneHash) as { code: string };
  return row.code;
}

export function lastEmailCode(db: Database, email: string): string {
  const row = db
    .prepare('SELECT code FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1')
    .get(email) as { code: string };
  return row.code;
}
