// app/src/lib/auth/__tests__/helpers.ts
// 测试库直接跑 WS1 的 runMigrations 建表，不另抄一份建表语句：
// 抄一份就会和生产 schema 悄悄漂移，而认证是最不该"本地全绿、线上列不存在"的模块。
import BetterSqlite3, { type Database } from 'better-sqlite3';

import { runMigrations } from '@/lib/db/migrate';

export function makeTestDb(): Database {
  const db = new BetterSqlite3(':memory:');
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
