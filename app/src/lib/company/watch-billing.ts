// app/src/lib/company/watch-billing.ts
// 守望订阅的月度计费（spec v3 §2.2）。每月一轮：为每个活跃盯梢按 tier 扣一笔月费，
// 走 lib/billing.gongdaoSettle（公道值一律经账本入口，本文件不直写 gongdao_ledger）。
//
// 【本产品最危险的失败模式：静默停盯】用户以为还在被守着、实际早已停了——等他发现，
// 对方可能已经简易注销跑路，赢了官司也拿不到钱。所以余额不足**绝不静默停盯**：
//   余额不足 → billing_status='arrears' + 中性通知（仍在盯）→ 连续 3 轮欠费 → status='paused'
//   且**再发一次**通知。把"停了"这件事永远变成一次显式的、发得出去的通知，绝不让它无声发生。
//
// 【幂等三层，缺一层就会重复扣/重复数】
//   1. 每笔扣款 refId = watch-{id}-{YYYYMM}，gongdaoSettle 的唯一索引挡重复扣款；
//   2. company_watches.billed_month 记"本月处理过没有"，挡 arrears_rounds 被同月重跑重复自增
//      （refId 只挡钱、挡不住计数器）；
//   3. 通知 notify_log 的 (scene,biz_key,channel) sent 位挡重复发信。
import type Database from 'better-sqlite3';

import { getGongdao, gongdaoSettle } from '../billing';
import { watchTierGongdao } from '../billing/pricing';
import { logAttempt, tryMarkSent, wasSent } from '../db/notify-log';
import { watchBillingNotice } from '../notify/copy';
import type { MailCopy } from '../notify/copy';

/** 连续欠费到此轮数即暂停盯梢（且再通知一次）。 */
export const PAUSE_THRESHOLD = 3;

/** 计费月键 YYYYMM。取**本地**日历月（进程时区＝Asia/Shanghai，生产如此、测试里显式 pin）。 */
export function monthKey(now: Date): string {
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
}

interface BillableWatch {
  id: number;
  tier: string;
  status: string;
  billing_status: string;
  arrears_rounds: number;
  billed_month: string | null;
  user_id: number;
  email: string | null;
  notify_verbose: number;
}

/** 扫出所有活跃盯梢（连同其所属用户的收件人信息）。paused 的不在此列（已停盯，不再计费）。 */
function scanActiveWatches(db: Database.Database): BillableWatch[] {
  return db
    .prepare(
      `SELECT w.id, w.tier, w.status, w.billing_status, w.arrears_rounds, w.billed_month,
              c.user_id, u.email, u.notify_verbose
         FROM company_watches w
         JOIN cases c ON c.id = w.case_id
         JOIN users u ON u.id = c.user_id
        WHERE w.status = 'active'
        ORDER BY w.id`,
    )
    .all() as BillableWatch[];
}

/** 一个盯梢本轮的处理结果（供计数与"是否已处理"判断，通知另算）。 */
type BillOutcome =
  | { kind: 'skipped' } // archive / 未知档 / 本月已处理
  | { kind: 'charged'; amount: number }
  | { kind: 'arrears'; rounds: number; paused: boolean };

/**
 * 处理单个盯梢的计费状态推进（同步、事务内原子）。**不发通知**（通知是异步的，在外层做）。
 * archive 与未知档一律不扣、不落 ledger 行、不动状态；本月已处理过（billed_month===mk）直接跳过。
 */
function billOneWatch(db: Database.Database, w: BillableWatch, mk: string): BillOutcome {
  if (w.tier === 'archive') return { kind: 'skipped' };
  const price = watchTierGongdao(w.tier);
  // 未知档价 0：宁可不扣，也不凭一个猜出来的价扣钱（fail safe）。
  if (price <= 0) return { kind: 'skipped' };
  if (w.billed_month === mk) return { kind: 'skipped' };

  return db.transaction((): BillOutcome => {
    const balance = getGongdao(w.user_id, db);
    if (balance >= price) {
      // 够扣：走账本入口扣一笔（refId 幂等），状态置 paid 并清欠费计数。
      gongdaoSettle(w.user_id, price, `watch-${w.id}-${mk}`, 'companywatch', null, db);
      db.prepare(
        "UPDATE company_watches SET billing_status='paid', paid_through=?, arrears_rounds=0, billed_month=? WHERE id=?",
      ).run(mk, mk, w.id);
      return { kind: 'charged', amount: price };
    }
    // 余额不足：**不扣**（不透支订阅），记欠费、自增轮数；达上限即暂停（但仍留行、留历史）。
    const rounds = w.arrears_rounds + 1;
    const paused = rounds >= PAUSE_THRESHOLD;
    db.prepare(
      "UPDATE company_watches SET billing_status='arrears', arrears_rounds=?, billed_month=?, status=? WHERE id=?",
    ).run(rounds, mk, paused ? 'paused' : w.status, w.id);
    return { kind: 'arrears', rounds, paused };
  })();
}

export interface WatchBillingDeps {
  /** 发信。注入以便测试与干跑；生产默认走 lib/notify 的 sendMail。 */
  sendMail: (to: string, copy: MailCopy) => Promise<void>;
  now?: Date;
  /** true = 只算不扣不发不改库（看这轮会扣谁、谁会欠费）。 */
  dryRun?: boolean;
}

export interface WatchBillingResult {
  /** 本轮检查的活跃非 archive 盯梢数。 */
  examined: number;
  /** 成功扣费笔数。 */
  charged: number;
  /** 本轮判为欠费的盯梢数。 */
  arrears: number;
  /** 本轮由欠费转入暂停的盯梢数。 */
  paused: number;
  /** 通知发送失败数（状态已推进，仅通知没发出去，下轮/人工重试）。 */
  failed: number;
  note: string;
}

/**
 * 发一封守望计费通知（余额不足 / 已暂停）。幂等 + 失败可重试：
 *   · 已发过（notify_log sent 位在）→ skipped，不重发；
 *   · 发失败 → logAttempt(failed) 留原文，**不占 sent 位**，下轮自然重试
 *     （宁可重发不可漏发——静默停盯比重复提醒严重得多）。
 */
async function notifyWatch(
  db: Database.Database,
  sendMail: WatchBillingDeps['sendMail'],
  w: BillableWatch,
  mk: string,
  paused: boolean,
): Promise<'sent' | 'skipped' | 'failed'> {
  const scene = paused ? 'watch_paused' : 'watch_arrears';
  const bizKey = `${paused ? 'paused' : 'arrears'}-${w.id}-${mk}`;
  const channel = 'email';
  if (!w.email) return 'skipped'; // 没绑邮箱发不了：不是错误，是这个用户还没绑（状态照常推进）
  if (wasSent(db, scene, bizKey, channel)) return 'skipped';

  const copy = watchBillingNotice(paused, { detailed: w.notify_verbose === 1 });
  try {
    await sendMail(w.email, copy);
  } catch (e) {
    logAttempt(db, {
      scene,
      bizKey,
      channel,
      status: 'failed',
      detail: e instanceof Error ? e.message || String(e) : String(e),
    });
    return 'failed';
  }
  tryMarkSent(db, { scene, bizKey, channel });
  return 'sent';
}

/**
 * 跑一轮守望月度计费。
 *
 * 【计数取自状态推进（outcome），通知取自落库后的状态】这样同月重跑时：outcome 记 skipped
 * （不重复计 arrears），但若该盯梢本月确为欠费且通知上轮没发成，仍会**重试**那封通知——
 * 计费只该发生一次，通知该发到发出去为止，两者的幂等各管各的。
 */
export async function runWatchBilling(
  db: Database.Database,
  deps: WatchBillingDeps,
): Promise<WatchBillingResult> {
  const now = deps.now ?? new Date();
  const mk = monthKey(now);
  const watches = scanActiveWatches(db);

  let examined = 0;
  let charged = 0;
  let arrears = 0;
  let paused = 0;
  let failed = 0;
  const errs: string[] = [];

  for (const w of watches) {
    if (w.tier === 'archive') continue; // archive 本就不监控、不计费，不计入 examined
    examined += 1;

    if (deps.dryRun) {
      const price = watchTierGongdao(w.tier);
      if (price <= 0 || w.billed_month === mk) continue;
      if (getGongdao(w.user_id, db) >= price) charged += 1;
      else {
        arrears += 1;
        if (w.arrears_rounds + 1 >= PAUSE_THRESHOLD) paused += 1;
      }
      continue;
    }

    const outcome = billOneWatch(db, w, mk);
    if (outcome.kind === 'charged') charged += 1;
    else if (outcome.kind === 'arrears') {
      arrears += 1;
      if (outcome.paused) paused += 1;
    }

    // 通知：以落库后的真实状态为准（覆盖"本轮刚欠费"与"上轮欠费、通知没发成、本月重跑重试"两种）。
    const state = db
      .prepare('SELECT billing_status, billed_month, status FROM company_watches WHERE id=?')
      .get(w.id) as { billing_status: string; billed_month: string | null; status: string };
    if (state.billing_status === 'arrears' && state.billed_month === mk) {
      const r1 = await notifyWatch(db, deps.sendMail, w, mk, false);
      if (r1 === 'failed') {
        failed += 1;
        errs.push(`#${w.id}:arrears 通知失败`);
      }
      if (state.status === 'paused') {
        const r2 = await notifyWatch(db, deps.sendMail, w, mk, true);
        if (r2 === 'failed') {
          failed += 1;
          errs.push(`#${w.id}:paused 通知失败`);
        }
      }
    }
  }

  const note =
    examined === 0
      ? '本轮无活跃盯梢'
      : `扫 ${examined} 个盯梢：扣费 ${charged}，欠费 ${arrears}${paused ? `（其中暂停 ${paused}）` : ''}` +
        `${failed ? `，通知失败 ${failed}（${errs.slice(0, 3).join('; ')}）` : ''}` +
        `${deps.dryRun ? '（干跑，未扣未发未改库）' : ''}`;
  return { examined, charged, arrears, paused, failed, note };
}

/**
 * CLI 本体（scripts/ 解析不到 app/node_modules 的 better-sqlite3，故开库在这里，同 deadline-reminder）。
 * @returns 0 正常；1 有通知发送失败；2 用法错（保留）。
 */
export async function watchBillingCli(
  dbPath: string,
  opts: { apply: boolean },
): Promise<number> {
  const { sendMail } = await import('../notify');
  const { startRun, finishRun } = await import('../db/job-runs');
  const { openCliDb } = await import('../db/cli-open');
  const db = openCliDb(dbPath);
  db.pragma('foreign_keys = ON');

  // 干跑不写 job_runs：一个只跑干跑的 cron 会看起来很健康，实际一分钱没扣、一封没发。
  if (!opts.apply) {
    try {
      const r = await runWatchBilling(db, { sendMail, dryRun: true });
      console.log(`库：${dbPath}`);
      console.log(`  ${r.note}`);
      console.log('  【干跑】没有扣费、没有发信、不写 job_runs。真跑请加 --apply。');
      return 0;
    } finally {
      db.close();
    }
  }

  const runId = startRun(db, '守望计费');
  let examined = 0;
  try {
    const r = await runWatchBilling(db, { sendMail, dryRun: false });
    examined = r.examined;
    finishRun(db, runId, {
      ok: true,
      itemsExamined: r.examined,
      itemsOk: r.charged,
      itemsFailed: r.failed,
      note: r.note,
    });
    console.log(`库：${dbPath}`);
    console.log(`  ${r.note}`);
    return r.failed > 0 ? 1 : 0;
  } catch (e) {
    finishRun(db, runId, {
      ok: false,
      errorText: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e),
      itemsExamined: examined,
      note: '整轮失败，items_* 可能是半截数',
    });
    console.error(`❌ 整轮失败：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    db.close();
  }
}
