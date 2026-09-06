// app/src/lib/jobs/referral-worker.ts
// 转介数据包的发送队列（设计稿 §14）。
//
// 【为什么是队列而不是在请求里直接发】用户点「同意并转介」的那一刻，对面可能在重启。
// 同步发的形态是：他看到一句失败，而他的同意已经给过了、包也已经生成好了，只差发出去。
// 落 pending 之后由本文件慢慢发，对面什么时候起来什么时候送达。
//
// 【为什么不复用 extraction-worker 的租约骨架】那套骨架是为「一条任务跑几分钟、
// 中途进程可能死掉」设计的（租约 + 心跳 + 续租）。发一个 HTTP 请求是秒级的，
// 给它配一整套租约机制，代码量比它本身还大，而且多出来的每一条分支都得有人维护。
// 这里用的是同一套**语义**（attempts 记尝试次数、last_error 记原文、失败退回等下一轮），
// 抢占靠 markSent / markAttemptFailed 那两句带 WHERE 的 UPDATE。
//
// 【本文件是共用层，不写死任何具体业务领域的字面量】面向的是「一份已获同意的数据包 +
// 一个外部收件方」。
import type Database from 'better-sqlite3';

import { createReferralLead, type NbdpsyFailure, type NbdpsyLeadAccepted } from '../nbdpsy/client';
import { withPlainPhone, type ReferralPacket } from '../referral/packet';
import * as store from '../db/referrals';

/**
 * 一条转介最多尝试发几次。
 *
 * 【「没接通」不算一次】缺配置时对方压根没被联系过，那是我们自己没接线。
 * 把它记成一次尝试的形态是：一个还没配好 env 的环境，跑三轮就把所有转介判成
 * failed——而每一条的失败原因都是「我们还没接线」，用户那边看到的却是"转介失败"。
 */
export const MAX_SEND_ATTEMPTS = 5;

/** 一轮最多处理几条。给个上限是为了别让一次积压把这一轮拖到几分钟。 */
const BATCH = 20;

/** 扫描间隔。发送不像提取那样有人等在页面上，30 秒足够。 */
export const POLL_MS = 30_000;

/** 这一轮的战果，给日志与判据看。 */
export interface ReferralTick {
  sent: number;
  failed: number;
  /** 看过但没发出去、仍留在 pending 的条数 */
  deferred: number;
}

export interface ReferralWorkerOptions {
  /** 覆盖发送函数（判据注入假的对方）。生产不传。 */
  send?: (payload: Record<string, unknown>) => Promise<NbdpsyLeadAccepted | NbdpsyFailure>;
  batch?: number;
}

/**
 * 跑一轮：把待发的转介逐条发出去。**不抛错**——一条发不出去不该让后面的都排不上。
 *
 * 发送成功（含对方判 duplicate 的幂等命中）⇒ status=sent + external_ref；
 * 没接通 / 被限流(429) ⇒ 留 pending，只写 last_error（attempts 不动，稍后自动再发）；
 * 其它失败 ⇒ attempts+1，用完置 failed，否则留 pending 等下一轮。
 */
export async function runReferralQueue(
  db: Database.Database,
  options: ReferralWorkerOptions = {},
): Promise<ReferralTick> {
  const send = options.send ?? createReferralLead;
  const rows = store.listPendingReferrals(db, options.batch ?? BATCH);
  const tick: ReferralTick = { sent: 0, failed: 0, deferred: 0 };

  for (const row of rows) {
    let packet: ReferralPacket;
    try {
      packet = JSON.parse(row.payload_json) as ReferralPacket;
    } catch (err) {
      // 包解不开就永远解不开，重试没有意义——直接判失败，把原因写清楚。
      store.markAttemptFailed(
        db,
        row.id,
        `第 ${row.id} 条转介的数据包读不出来：${err instanceof Error ? err.message : String(err)}。` +
          '为什么：payload_json 不是合法 JSON（多半是落库时被截断了）。' +
          '怎么办：这条不会再重试；请用户重新发起一次转介。',
        { countsAsAttempt: true, exhausted: true },
      );
      tick.failed += 1;
      continue;
    }

    // 手机明文只在这一刻出现在内存里，不回写库（见 packet.withPlainPhone）。
    const result = await send(withPlainPhone(db, row.user_id, packet));
    if (result.ok) {
      store.markSent(db, row.id, result.externalRef);
      tick.sent += 1;
      continue;
    }

    // 没接通与被限流都不是「这一条本身发失败」：一个是我们没接线，一个是要稍后再来。
    // 把它们记成一次尝试的形态是：跑满几轮后把一条本可送达的转介判成 failed。
    const countsAsAttempt = result.reason !== 'NOT_CONNECTED' && result.reason !== 'RATE_LIMITED';
    const exhausted = countsAsAttempt && row.attempts + 1 >= MAX_SEND_ATTEMPTS;
    store.markAttemptFailed(db, row.id, result.message, { countsAsAttempt, exhausted });
    if (exhausted) tick.failed += 1;
    else tick.deferred += 1;
  }
  return tick;
}

let loop: ReturnType<typeof setInterval> | null = null;

/**
 * 起进程内队列（幂等：已经起过就不再起第二个）。
 * 一轮没跑完不会叠下一轮——门闩挡住重入，否则对方慢的时候 tick 会越堆越多。
 */
export function startReferralWorker(
  db: Database.Database,
  options: ReferralWorkerOptions = {},
): void {
  if (loop) return;
  let running = false;
  loop = setInterval(() => {
    if (running) return;
    running = true;
    void runReferralQueue(db, options)
      .catch((err) => console.warn('[referral] 这一轮发送出错（下一轮会重来）：', err))
      .finally(() => {
        running = false;
      });
  }, POLL_MS);
  // 后台巡检，不该拖住进程退出。
  loop.unref?.();
}

/** 停队列（判据与优雅退出用）。 */
export function stopReferralWorker(): void {
  if (!loop) return;
  clearInterval(loop);
  loop = null;
}
