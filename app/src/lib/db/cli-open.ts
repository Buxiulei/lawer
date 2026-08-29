// app/src/lib/db/cli-open.ts
// CLI 开库的唯一入口。
//
// 【为什么要有它】2026-08-29 第十一窗实弹：`deadline-reminder --apply` 首跑崩在
// `no such table: job_runs`。迁移是 app 侧**惰性**的（lib/db/client.ts 首次 getDb 才跑），
// 而 CLI 自己 `new Database(path)`，**不触发迁移**。
// ⇒ 「带迁移的滚更 + 次日 cron 先于 app 被任何请求碰到」这个组合，
// 会让 cron **静默崩在日志里**——而它发的是法定期限提醒。
//
// 排查发现五个 CLI 同病（backfill / reconcile / filesGc / 护照审核 / 期限提醒），
// 只有 app 自己的 client.ts 跑迁移。**这不是某个脚本忘了，是这类脚本都会忘**——
// 所以修法是把「开库」这件事收成一个入口，而不是在五个地方各补一行。
//
// 【为什么不能一刀切"都跑迁移"】只读连接跑不了迁移：
//   reconcile 恒只读；backfill / filesGc 干跑时只读（用文件句柄兜底"不写"，是好设计）。
// 所以分两路：可写的跑迁移；只读的跑不了，就得在崩之前把话说清楚。
//
// 【不碰 pragma】各站点的 foreign_keys / journal_mode 保持原样：
// reconcile 与 filesGc 本来就没开外键，本次是修迁移，不是统一 pragma——
// 在 `backfill --apply` 这种碰钱的路径上顺手打开外键会引入新的失败面。
import Database from 'better-sqlite3';

import { runMigrations } from './migrate';

/**
 * 只读路径撞上缺表 / 缺列时的自述错误。
 *
 * 【为什么原样的 `no such table: X` 不够】它只说"没有这张表"，
 * 不说**为什么会没有**（滚更后 app 还没被碰过、惰性迁移没跑）
 * 也不说**怎么办**。排查的人得重新推一遍我们今天推的那一遍。
 */
export class SchemaNotMigratedError extends Error {
  constructor(dbPath: string, cause: string) {
    super(
      `库的表结构不是最新的：${dbPath}\n` +
        `  原始错误：${cause}\n` +
        `  原因：迁移由应用侧惰性执行（首次请求才跑）。本命令以**只读**方式开库，跑不了迁移。\n` +
        `  怎么办：先访问一次应用（触发迁移），或先跑一次同库的可写命令，再重跑本命令。`,
    );
    this.name = 'SchemaNotMigratedError';
  }
}

export interface CliDbOptions {
  /** true = 只读开库；此时不跑迁移，缺表/缺列改报自述错误 */
  readonly?: boolean;
  fileMustExist?: boolean;
  /** 迁移确实改了表结构时打印一行；默认 true。静默只发生在"本来就是最新的"。 */
  announce?: boolean;
}

/** 表结构指纹。ADD COLUMN 会重写 sqlite_master.sql，故这一条覆盖"新表"和"新列"两种变更。 */
function schemaFingerprint(db: Database.Database): string {
  const row = db.prepare('SELECT group_concat(sql) AS s FROM sqlite_master').get() as { s: string | null };
  return row?.s ?? '';
}

/**
 * 给 CLI 开库。可写时**顺手把迁移跑掉**——迁移全幂等（IF NOT EXISTS + addColumnIfMissing），
 * 且有守卫测试盯着非幂等语句，所以这一步安全。
 *
 * 【为什么迁移真的动了要出声】否则"干跑"会静悄悄地改表结构。
 * 干跑的承诺是不写业务数据，不是"什么都没发生"——**发生了就得说**。
 */
export function openCliDb(dbPath: string, opts: CliDbOptions = {}): Database.Database {
  const db = new Database(dbPath, {
    readonly: opts.readonly ?? false,
    fileMustExist: opts.fileMustExist ?? false,
  });
  if (opts.readonly) return db;
  const before = schemaFingerprint(db);
  runMigrations(db);
  if ((opts.announce ?? true) && schemaFingerprint(db) !== before) {
    console.log(`[库] 表结构已补齐（本次迁移执行了变更）：${dbPath}`);
  }
  return db;
}

/** 把只读路径上的「缺表/缺列」翻译成自述错误；其它错误原样抛。 */
export function rethrowIfSchemaStale(err: unknown, dbPath: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (/no such table|no such column/i.test(msg)) throw new SchemaNotMigratedError(dbPath, msg);
  throw err;
}
