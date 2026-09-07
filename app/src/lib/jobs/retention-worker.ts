// app/src/lib/jobs/retention-worker.ts
// 保留期到点清理：把 30 日前标删的档案真删掉，把 30 日前注销的账号做最终清理。
// 依据是用户服务协议 v0.2 第五条第 8 款那句「30 日内彻底删除」——**这个任务不跑，那句话
// 就是假的**，而且是最难被发现的那种假：页面上那些档案早就不见了。
//
// ───────────────── 与 extraction-worker 的异同 ─────────────────
// 同：常驻 tick、进程内单例、不重入（上一轮没跑完不叠下一轮）、定时器 unref（后台巡检不
//     拖住进程退出）、一轮里的失败不往外抛（一条坏行不能让后面所有行都清不掉）。
// 异：**没有 lease_until 列**。那边的租约是为了「领了任务、跑一段时间、再回来收尾」这种
//     长活；这边一行的处置就是一句带条件的 DELETE / UPDATE，抢占与完成是同一次写：
//       DELETE FROM cases WHERE id=? AND deleted_at IS NOT NULL AND deleted_at<=?
//     按 changes===1 判「这一次是我做成的」。两个 tick（或两个进程）同时扫到同一行时，
//     只有一个会拿到 1，另一个自然跳过——比租约更强，也没有租约过期这一档要维护。
//     加一个只在同一句 SQL 里活半毫秒的租约列，反倒多出一批要有人盯着才不腐坏的状态。
//
// 【时钟注入】判据要能把「现在」拨到 31 天后，否则这个任务只能靠等 30 天来验。
// 所以 now 是一个可注入的函数，不是 new Date()。
//
// 【本文件是共用层，不写死任何具体领域的字面量】面向的是「一行到期数据 + 一种清理方式」。
import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { gcOrphanFiles } from '../db/filesGc';
import { finishRun, startRun } from '../db/job-runs';
import * as lifecycle from '../db/lifecycle';
import { toSql } from '../db/time';
import { purgeCutoff } from '../lifecycle/retention';

/** job_runs 里这个任务的名字。「跑没跑」由那张表回答（见 lib/db/job-runs 抬头）。 */
export const RETENTION_JOB_NAME = '数据留存清理';

/** 扫描间隔。到期判定的粒度是天，一小时一轮足够，而且不会在重启密集时反复空跑。 */
export const RETENTION_POLL_MS = 60 * 60 * 1000;

/** 一轮最多处置多少行。**不是为了限流，是为了让一轮的时长可预期**：某天积压了十万行时，
 *  一轮跑完再跑下一轮，好过一轮跑上几个小时、期间没有任何一处看得出它还活着。 */
export const RETENTION_BATCH = 200;

export interface RetentionResult {
  /** 真删掉的案件数 */
  cases_purged: number;
  /** 做完最终清理的账号数 */
  users_purged: number;
  /** 顺带回收的无引用密文文件数 */
  files_removed: number;
  freed_bytes: number;
  /** 逐行失败数（某一行删不掉不影响其余行） */
  failed: number;
}

export interface RetentionOptions {
  /** 注入时钟（判据把它拨到保留期之后）。不给取当前时刻。 */
  now?: () => Date;
  batch?: number;
  /** 删密文文件；不给走真 unlink。判据注入探针，不碰文件系统。 */
  deleteFromDisk?: (encPath: string) => void;
  /** 落 job_runs 留痕。默认落——「今天有没有跑过」只有那张表答得上来。 */
  recordRun?: boolean;
}

/** 生产的删盘动作：路径与 lib/evidence/files 的 filesDir() 同源，否则会找不到文件。 */
function defaultDeleteFromDisk(encPath: string): void {
  const dir = process.env.FILES_DIR ?? path.join(process.cwd(), 'data', 'files');
  try {
    fs.unlinkSync(path.join(dir, encPath));
  } catch (err) {
    // 盘上文件缺失/无权限只警告不抛：抛错会回滚整个事务，让本轮已删掉的盘文件
    // 对应的库行复活成「有记录无密文」的坏行（同 scripts/gc-files.ts 的口径）。
    console.warn(`[retention] 删密文文件失败（库行已删）：${encPath}：${(err as Error).message}`);
  }
}

/**
 * 跑一轮清理。**不抛错**：一行删不掉是那一行的事，不该让后面的行全都清不掉，
 * 也不该让常驻循环本身断掉。逐行失败计进 failed，整轮失败才落 job_runs 的 ok=0。
 */
export function runRetentionOnce(
  db: Database.Database,
  options: RetentionOptions = {},
): RetentionResult {
  const now = (options.now ?? (() => new Date()))();
  const cutoff = toSql(purgeCutoff(now));
  const batch = options.batch ?? RETENTION_BATCH;
  const nowStr = toSql(now);
  const runId = options.recordRun === false ? null : startRun(db, RETENTION_JOB_NAME);

  const result: RetentionResult = {
    cases_purged: 0,
    users_purged: 0,
    files_removed: 0,
    freed_bytes: 0,
    failed: 0,
  };

  try {
    // ① 到期的案件。硬删即级联带走它的全部子表（见 lib/db/lifecycle.purgeCase 的说明）。
    for (const due of lifecycle.listCasesDueForPurge(db, cutoff, batch)) {
      try {
        if (lifecycle.purgeCase(db, due.id, cutoff)) result.cases_purged += 1;
      } catch (err) {
        result.failed += 1;
        console.warn(`[retention] 案件 ${due.id} 没能删掉：${(err as Error).message}`);
      }
    }

    // ② 到期的注销账号。抢占位（purged_at）拿到才做后面的抹除；
    //    抹除本身是幂等的，所以抢占失败直接跳过，不需要回滚什么。
    //
    //    【这一步为什么只剩「再抹一遍」】注销当场就把可识别字段抹掉了（见
    //    lib/lifecycle/account-cancel），名下案件也在那一刻标了删、由上面 ① 到期删掉。
    //    这里再抹一遍是兜「注销之后又有别的路径往这一行写回了什么」，并盖上 purged_at
    //    ——那个时刻是我们对外能说「这个账号已经清理完了」的唯一凭据。
    for (const user of lifecycle.listUsersDueForPurge(db, cutoff, batch)) {
      try {
        if (!lifecycle.claimUserPurge(db, user.id, cutoff, nowStr)) continue;
        lifecycle.anonymizeUser(db, user.id);
        result.users_purged += 1;
      } catch (err) {
        result.failed += 1;
        console.warn(`[retention] 账号 ${user.id} 没能清理：${(err as Error).message}`);
      }
    }

    // ③ 回收无人引用的密文文件。
    //
    // 【为什么调全局回收，而不是「只删这个案子的那几份」】files 是内容寻址的裸资源，
    // 同一份文件可能被别的案件引用着（按 sha256 全局去重）。按案件删就会把别人的证据
    // 一起删掉——而那份文件的所有者那边一切正常，直到他去下载。
    // 判据「无引用才删」只有 lib/db/filesGc 那一份，这里不另写一套。
    const gc = gcOrphanFiles(db, {
      deleteFromDisk: options.deleteFromDisk ?? defaultDeleteFromDisk,
    });
    result.files_removed = gc.removed;
    result.freed_bytes = gc.freedBytes;

    if (runId !== null) {
      finishRun(db, runId, {
        ok: true,
        itemsExamined: result.cases_purged + result.users_purged + result.failed,
        itemsOk: result.cases_purged + result.users_purged,
        itemsFailed: result.failed,
        note:
          `到期删除：案件 ${result.cases_purged}、账号 ${result.users_purged}；` +
          `回收密文文件 ${result.files_removed} 个（${result.freed_bytes} 字节）；` +
          `逐行失败 ${result.failed}`,
      });
    }
    return result;
  } catch (err) {
    // 整轮失败（库连不上、回收器抛了）：与逐行失败分开记，两者要采取的行动不同
    // （整轮看 error_text，逐行去日志里翻那几条）。
    if (runId !== null) {
      finishRun(db, runId, {
        ok: false,
        itemsExamined: result.cases_purged + result.users_purged + result.failed,
        itemsOk: result.cases_purged + result.users_purged,
        itemsFailed: result.failed,
        errorText: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
    return result;
  }
}

let loop: ReturnType<typeof setInterval> | null = null;

/**
 * 起进程内清理任务（幂等：已经起过就不再起第二个）。
 * 一轮没跑完不会叠下一轮——`running` 这个门闩挡住重入。
 */
export function startRetentionWorker(
  db: Database.Database,
  options: RetentionOptions = {},
): void {
  if (loop) return;
  let running = false;
  loop = setInterval(() => {
    if (running) return;
    running = true;
    try {
      runRetentionOnce(db, options);
    } finally {
      running = false;
    }
  }, RETENTION_POLL_MS);
  // 这个定时器不该拖住进程退出：它是后台巡检，不是待办事项。
  loop.unref?.();
}

/** 停任务（判据与优雅退出用）。 */
export function stopRetentionWorker(): void {
  if (!loop) return;
  clearInterval(loop);
  loop = null;
}
