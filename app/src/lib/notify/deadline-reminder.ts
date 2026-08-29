// app/src/lib/notify/deadline-reminder.ts
// 期限提醒：扫 deadlines，按 30/7/3/1 天档发中性邮件（manager 2026-08-29 派）。
//
// 【为什么这件事是 P0】此前**这一层代码根本不存在**——migrate.ts 里那句
// 「notified_stages_json 记已发过哪几档提醒（30/7/3/1 天…），防重复轰炸也防漏提醒」
// 描述的是一个不存在的机制。而驾驶舱倒计时是**拉式**的：用户不打开就看不见。
// deadlines 表当时是 0 行，看起来不急——但 agent 的 deadline_set 是接好的，
// **从 0 行到 1 行不需要任何人做决定**，而错过仲裁时效即权利灭失。
import type { Database } from 'better-sqlite3';

import { deadlineReminder as deadlineReminderCopy } from './copy';

/** 提醒档位（天）。降序，先到大的档。 */
export const STAGES = [30, 7, 3, 1] as const;

/**
 * 错过即不可回复的期限类型。
 * 这几类没有救济途径：时效一过，实体权利灭失，不是"晚点再办"。
 * 与 migrate.ts deadlines.kind 的注释同一词表。
 */
export const IRRECOVERABLE_KINDS = new Set(['仲裁时效', '起诉15日', '上诉15日', '申请执行2年']);

export interface DueRow {
  id: number;
  case_id: number;
  kind: string;
  due_at: string;
  notified_stages_json: string | null;
  email: string | null;
  notify_verbose: number;
}

export interface Plan {
  deadlineId: number;
  email: string;
  kind: string;
  daysLeft: number;
  /** 写进 notified_stages_json 的键；日更档带日期，故同一天只发一次 */
  stageKey: string;
  detailed: boolean;
}

/**
 * 整天数差：按日历日算，不按 24 小时——用户感知的是"还剩几天"不是"还剩几小时"。
 *
 * 【"今天"取**本地**日历日，不取 UTC 日】due_at 是一个本地日历日（'2026-09-04'，
 * 北京口径），所以"今天"也必须是本地日历日，两边才在同一把尺子上。
 * 第一版用 now.toISOString().slice(0,10) 取 UTC 日：在 CST 的 00:00–08:00 之间，
 * UTC 还停在昨天 ⇒ 今天被算小一天 ⇒ daysLeft **整体多 1**。
 * 后果不是显示难看，是**档位错位**：真剩 1 天会被算成 2 天，逐日加码档（≤1 天才进）
 * 那一天不触发——而那正是不可回复类期限最不能漏的一天。
 * 当前 cron 挂在 09:30（UTC 01:30，同日）故未爆；改时间、补跑、临时手动跑都会踩上。
 *
 * 做法：用 getFullYear/getMonth/getDate 取本地年月日，再用 Date.UTC 搬到 UTC 零点，
 * 与同样按 UTC 零点解析的 due 对齐 ⇒ 差值恒为整天，且不受夏令时影响。
 * 前提：进程时区 = Asia/Shanghai（生产服务器如此；测试里显式 pin）。
 */
export function daysUntil(dueAt: string, now: Date): number {
  const due = new Date(`${dueAt.slice(0, 10)}T00:00:00Z`).getTime();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

/**
 * 这一行此刻该发哪一档（不该发则 null）。
 *
 * 【③ 末档加码：宁可轰炸不可漏】不可回复类期限在剩 ≤1 天后**逐日重发**，
 * 直到了结或过期。stageKey 带上日期 ⇒ 同一天不会重复，跨天必然重发。
 * 这与 notified_stages_json 天然偏向"少发"的设计是相反方向——
 * 而**这一类的失败代价不对称**：多发一封是打扰，漏发一封是权利灭失。
 */
export function stageFor(row: DueRow, now: Date): { stageKey: string; daysLeft: number } | null {
  const daysLeft = daysUntil(row.due_at, now);
  if (daysLeft < 0) return null; // 已过期，发了也没用
  const sent = new Set<string>(safeParse(row.notified_stages_json));

  if (daysLeft <= 1 && IRRECOVERABLE_KINDS.has(row.kind)) {
    const key = `daily-${now.toISOString().slice(0, 10)}`;
    return sent.has(key) ? null : { stageKey: key, daysLeft };
  }
  // 【取**最紧**的那档，不是最松的】第一版写成"命中的第一个大档"，测试当场撞出问题：
  // 剩 2 天且从未提醒过时，它会先发「30 档」，次日发「7 档」，再次日「3 档」——
  // **一条晚发现的期限会在最后几天连发四封**。取最紧档 + 一次把已覆盖的档全记上，
  // 才是"补一封现在该发的，然后按剩下的档走"。
  const tightest = [...STAGES].reverse().find((s) => daysLeft <= s && !sent.has(String(s)));
  return tightest === undefined ? null : { stageKey: String(tightest), daysLeft };
}

/**
 * 发这一档时，**所有比它更松的档也算覆盖过了**。
 * 剩 2 天补发时记 30/7/3 三档 ⇒ 明天只会因为「1 档」再发一次，不会把历史档补发一遍。
 */
export function stagesCoveredBy(stageKey: string): string[] {
  const n = Number(stageKey);
  if (!Number.isFinite(n)) return [stageKey]; // daily-YYYY-MM-DD 只记自己
  return STAGES.filter((s) => s >= n).map(String);
}

function safeParse(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    // 【解不开就当没发过】宁可重发，不可因为一个坏字段静默漏发。
    return [];
  }
}

/** 扫出所有生效中的期限（含收件人）。resolved_at 非空 = 已了结，停止提醒。 */
export function scanDue(db: Database): DueRow[] {
  return db
    .prepare(
      `SELECT d.id, d.case_id, d.kind, d.due_at, d.notified_stages_json,
              u.email, u.notify_verbose
         FROM deadlines d
         JOIN cases c ON c.id = d.case_id
         JOIN users u ON u.id = c.user_id
        WHERE d.resolved_at IS NULL
        ORDER BY d.due_at`,
    )
    .all() as DueRow[];
}

export function planReminders(db: Database, now: Date): Plan[] {
  const out: Plan[] = [];
  for (const row of scanDue(db)) {
    if (!row.email) continue; // 没邮箱发不了；不是错误，是这个用户还没绑
    const s = stageFor(row, now);
    if (!s) continue;
    out.push({
      deadlineId: row.id,
      email: row.email,
      kind: row.kind,
      daysLeft: s.daysLeft,
      stageKey: s.stageKey,
      detailed: row.notify_verbose === 1,
    });
  }
  return out;
}

/**
 * 落档：**只在发送确认成功之后才写**（manager ② 定）。
 * 发送失败不记档 ⇒ 下一轮自然重试。
 * 反过来做（先记后发）会在发送失败时留下"已通知"的假象，而那一档再也不会重来。
 */
export function markSent(db: Database, deadlineId: number, stageKey: string): void {
  const row = db.prepare('SELECT notified_stages_json FROM deadlines WHERE id=?').get(deadlineId) as
    | { notified_stages_json: string | null }
    | undefined;
  const next = [...new Set([...safeParse(row?.notified_stages_json ?? null), ...stagesCoveredBy(stageKey)])];
  db.prepare('UPDATE deadlines SET notified_stages_json=? WHERE id=?').run(
    JSON.stringify(next),
    deadlineId,
  );
}


export interface RunDeps {
  /** 发信。注入以便测试与干跑；默认走 lib/notify 的 sendMail */
  sendMail: (to: string, copy: { subject: string; text: string }) => Promise<void>;
  now?: Date;
  /** true = 只算不发不记档 */
  dryRun?: boolean;
}

export interface RunResult {
  examined: number;
  ok: number;
  failed: number;
  note: string;
}

/**
 * 跑一轮。
 *
 * 【② 先发后记，绝不反过来】记档在**发送 resolve 之后**。
 * 反过来（先记后发）会在发送失败时留下"已通知"的假象，**而那一档再也不会重来**——
 * 对仲裁时效这类期限，那一次静默漏发就是权利灭失。
 *
 * 【一封失败不拖累其余】逐条 try：失败的不记档（下轮自然重试），其余照发。
 * 整轮抛错与"其中 N 封失败"是两回事，返回值把两者分开
 * （job_runs 的 items_failed 与 error_text 也是这么分的——数据表管理 2026-08-29）。
 */
export async function runReminders(db: Database, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? new Date();
  const plans = planReminders(db, now);
  let ok = 0;
  let failed = 0;
  const errs: string[] = [];

  for (const p of plans) {
    const copy = deadlineReminderCopy(p.daysLeft, p.kind, { detailed: p.detailed });
    if (deps.dryRun) {
      ok += 1;
      continue;
    }
    try {
      await deps.sendMail(p.email, copy);
      markSent(db, p.deadlineId, p.stageKey); // ← 只有走到这里才记
      ok += 1;
    } catch (e) {
      failed += 1;
      errs.push(`#${p.deadlineId}:${(e as Error).message}`);
    }
  }

  const note =
    plans.length === 0
      ? '本轮无到档期限'
      : `${plans.length} 条到档，成功 ${ok}${failed ? `，失败 ${failed}（${errs.slice(0, 3).join('; ')}）` : ''}${deps.dryRun ? '（干跑，未发未记档）' : ''}`;
  return { examined: plans.length, ok, failed, note };
}


/**
 * CLI 本体。脚本只解析参数与退出码，开库在这里
 * （scripts/ 解析不到 app/node_modules 的 better-sqlite3——与 reconcile/backfill 同一分工）。
 *
 * @returns 0 正常；1 有发送失败；2 用法错
 */
export async function reminderCli(
  dbPath: string,
  opts: { apply: boolean; smokeTo?: string },
): Promise<number> {
  const { default: BetterSqlite3 } = await import('better-sqlite3');
  const { sendMail } = await import('./index');

  // 【冒烟投递为什么不走真实扫描】manager 要的是"验证真的能发出去、文案对"。
  // 若让它走真实扫描再把收件人改掉，就会出现**邮件发给测试信箱、而真实期限被标记成已通知**——
  // 那条期限从此再也不会提醒，用户永远不知道。
  // 所以冒烟只发一封合成样例，**一行库都不碰**。
  if (opts.smokeTo) {
    const copy = deadlineReminderCopy(3, '仲裁时效');
    console.log(`【冒烟投递】收件人 ${opts.smokeTo}（合成样例，不读库、不写库）`);
    console.log(`  主题：${copy.subject}`);
    console.log(`  正文：${copy.text.replace(/\n/g, '\n        ')}`);
    await sendMail(opts.smokeTo, copy);
    console.log('✅ 已投递。请到该信箱确认收到，并核对上面的主题正文逐字一致。');
    return 0;
  }

  const { startRun, finishRun } = await import('../db/job-runs');
  const db = new BetterSqlite3(dbPath);
  db.pragma('foreign_keys = ON');

  // 【干跑不留痕】job_runs 记的是"这轮真的做了什么"。干跑什么都没做，
  // 给它记一行会让 staleJobs 以为任务在正常跑——**一个只跑干跑的 cron 会看起来很健康**。
  if (!opts.apply) {
    try {
      const r = await runReminders(db, { sendMail, dryRun: true });
      console.log(`库：${dbPath}`);
      console.log(`  ${r.note}`);
      console.log('  【干跑】没有发信、没有记档、不写 job_runs。真发请加 --apply。');
      return 0;
    } finally {
      db.close();
    }
  }

  // 【① startRun 在开跑那一刻调，不是跑完一起写】这是三态的全部来源：
  //   没有行           = 从没跑起来过
  //   有行 finished_at NULL = 跑起来了没跑完（被 OOM 杀 / 崩了 / 还在跑）
  //   有行 finished_at 非空 = 跑完了
  // 跑完才写的话，**被杀掉的那次和从没跑过的那次在表里一模一样**。
  const runId = startRun(db, '期限提醒');
  let examined = 0;
  try {
    const r = await runReminders(db, { sendMail, dryRun: false });
    examined = r.examined;
    // 【② items_failed 与 error_text 不混】这里 ok=true 表示**整轮跑通**；
    // 其中几封发失败是 itemsFailed 的事。混了的话「发了 100 封失败 3 封」
    // 与「一封没发成、整个任务崩了」会读起来一样。
    finishRun(db, runId, {
      ok: true,
      itemsExamined: r.examined,
      itemsOk: r.ok,
      itemsFailed: r.failed,
      note: r.note,
    });
    console.log(`库：${dbPath}`);
    console.log(`  ${r.note}`);
    return r.failed > 0 ? 1 : 0;
  } catch (e) {
    // 整轮炸了：ok=false + 错误原文；items_* 可能是半截数，如实记。
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
