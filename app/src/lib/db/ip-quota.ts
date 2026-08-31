// app/src/lib/db/ip-quota.ts
// ip_quota_events 一张表的封装（spec §6：lib/db 是唯一 SQL 层）。
// 表结构由 migrate.ts 定义，本文件只负责读写，不建表。判定阈值与业务语义在 lib/auth/ip-quota.ts。
import type { Database } from 'better-sqlite3';

/**
 * 统计某 IP 在 sinceIso 之后的发码次数。
 *
 * 时间比较为何两边都套 datetime()：与 countSmsCodesSince 同一个理由——本模块写入的是
 * canonical 串，而建表默认值 datetime('now') 也是 canonical 串，两者本已同格式；
 * 但存量/手写行一旦混进 ISO8601（'…T…Z'），裸字符串比较下 ' '(0x20) < 'T'(0x54)，
 * 同一时刻的两种写法会排出先后，把「刚刚发的」读成「很久以前」而漏放一次。
 * 过滤先走 ip（有索引），单 IP 的行数以百计，包一层函数的代价可以忽略。
 */
export function countIpEventsSince(db: Database, ip: string, sinceIso: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM ip_quota_events WHERE ip = ? AND datetime(created_at) > datetime(?)',
    )
    .get(ip, sinceIso) as { n: number };
  return row.n;
}

/**
 * 记一次发码，并顺手删掉该 IP 早于 gcBeforeIso 的旧行（机会式 GC，不设定时任务）。
 *
 * GC 只删**本 IP** 的行：全表扫一遍才能删干净别人的，那是定时任务该干的事；
 * 而每个 IP 都会在自己下一次发码时清掉自己的旧行，活跃 IP 自然收敛，
 * 不活跃 IP 留下的那几十行不构成问题。
 *
 * 两条语句包在一个事务里：中途失败时「记了一次但没清旧行」尚可接受，
 * 「清了旧行却没记这一次」等于白送一次额度，不该存在。
 */
export function recordIpEvent(
  db: Database,
  params: { ip: string; createdAt: string; gcBeforeIso: string },
): void {
  const insert = db.prepare('INSERT INTO ip_quota_events (ip, created_at) VALUES (?, ?)');
  const gc = db.prepare(
    'DELETE FROM ip_quota_events WHERE ip = ? AND datetime(created_at) < datetime(?)',
  );
  db.transaction(() => {
    insert.run(params.ip, params.createdAt);
    gc.run(params.ip, params.gcBeforeIso);
  })();
}
