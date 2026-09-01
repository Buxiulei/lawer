// app/src/lib/billing/__tests__/redeem-race-worker.ts
// redeem-race.test.ts 的子进程臂：**一个独立进程、一条独立 SQLite 连接**，
// 到点同时冲同一条码。不是测试文件（文件名不匹配 vitest 的 include），不会被单独收集。
//
// 【为什么必须开子进程】better-sqlite3 是同步的，同一个进程里的两次 redeemCode 调用天然串行——
// 在那种排队里 CAS 永远不会失手，于是「去掉 CAS 也照样绿」。真正要防的并发只存在于
// 多连接之间（多实例部署、CLI 与 app 同时开着库），只有多进程才复现得出来。
//
// 用法：tsx redeem-race-worker.ts <dbPath> <uid> <code> <startAtEpochMs>
// 输出恰好一行：ok:<到账后余额> | fail:<reason> | err:<原文>
import Database from 'better-sqlite3';

import { redeemCode } from '../redeem';

const [dbPath, uidArg, code, startAtArg] = process.argv.slice(2);
const db = new Database(dbPath);
// 多写者会撞锁；没有这一行，先到的拿锁、后到的当场 SQLITE_BUSY，
// 于是测出来的是「谁先抢到文件锁」，不是「CAS 挡没挡住第二次认领」。
db.pragma('busy_timeout = 15000');
db.pragma('foreign_keys = ON');

// 同步起跑线：各进程的启动耗时差着几十上百毫秒，不对表的话它们其实是排队进来的。
const startAt = Number(startAtArg);
while (Date.now() < startAt) {
  /* 自旋到起跑时刻——sleep 的精度不够，而这里要的正是"同一毫秒一起冲" */
}

try {
  const r = redeemCode(db, Number(uidArg), code);
  process.stdout.write(r.ok ? `ok:${r.balance}` : `fail:${r.reason}`);
} catch (e) {
  process.stdout.write(`err:${(e as Error).message}`);
}
