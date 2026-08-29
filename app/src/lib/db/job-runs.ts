// app/src/lib/db/job-runs.ts
// job_runs 表的封装（spec §6：lib/db 是唯一 SQL 层）。表结构与三态语义见 migrate.ts。
//
// 本表是**运行粒度**的留痕：notify_log / company_watch_checks 那类逐项表答「这一项怎么样」，
// 本表答「这一轮有没有发生」。两者不能互相替代——定时任务的进程压根没起来时，逐项表一行都不落，
// 而「今天零行」与「今天没有可做的」在逐项表里长得一模一样。
//
// **正确用法只有一种：开跑时 startRun，跑完（成功或失败都算跑完）finishRun。**
// 倒过来只在跑完时插一行，等于把崩掉的那次抹掉——而「崩了」和「根本没跑」正是本表存在的
// 全部理由。所以 startRun 不收任何结果参数、finishRun 只认 runId：先插后回填是这里最省事的写法。
//
// **整轮失败（ok=0 + error_text）与逐项失败（items_failed）是两回事，本层不许把它们揉一起：**
// items_failed=3 且 ok=1 是「这轮跑通了，其中 3 项各自失败」，那 3 条的原因去 notify_log 逐条查；
// ok=0 是「整轮炸了」（库连不上、配置缺失），此时 items_* 可能只是半截数。混成一格的话，
// 「发了 100 封失败 3 封」与「一封没发成、整个任务崩了」读起来一模一样——那正是本表要解决的
// 那类问题，别在它自己身上再犯一次。
//
// 读者接口是 staleJobs。它只管**跑没跑**、不管**跑得对不对**：一个每小时准点跑、每次都 ok=0
// 的任务，staleJobs 一声不吭；每轮 items_failed 全红的任务同样一声不吭。那两种失败请读
// lastRun() 的 ok / error_text / items_failed——要采取的行动不同（没跑 = 去看调度器；
// 整轮失败 = 去看 error_text；逐项失败 = 去 notify_log 翻那几条），合成一句报不清。
import type { Database } from 'better-sqlite3';

/** 任务名值集（与 migrate.ts 的列注释同步）。TEXT 列不加 CHECK，值集由本层把关。 */
export type JobName = '期限提醒' | '公道值对账' | '公司监控巡检';

export interface JobRun {
  id: number;
  job_name: string;
  started_at: string;
  /** NULL = 没跑完（进程被杀 / 崩了 / 还在跑），三态全靠它区分 */
  finished_at: string | null;
  /** NULL=未跑完；1=整轮跑通；0=整轮失败。与 items_failed 不是一回事 */
  ok: number | null;
  items_examined: number | null;
  items_ok: number | null;
  /** 逐项失败数。>0 且 ok=1 = 这轮跑通了、其中几项各自失败，原因去 notify_log 逐条查 */
  items_failed: number | null;
  /** **整轮**致命错误原文（ok=0 时才有），不是逐项失败的原因 */
  error_text: string | null;
  /** 人话摘要，给读表的人看 */
  note: string | null;
}

const COLS =
  'id, job_name, started_at, finished_at, ok, items_examined, items_ok, items_failed, error_text, note';

/** 开跑：先插行占位，返回 runId。started_at 交给列 DEFAULT (datetime('now'))，不从 JS 落串（ADR-002）。 */
export function startRun(db: Database, jobName: JobName | string): number {
  const info = db.prepare('INSERT INTO job_runs (job_name) VALUES (?)').run(jobName);
  return Number(info.lastInsertRowid);
}

/**
 * 跑完回填。失败也要调——不调的那一行会一直停在「未跑完」，被 staleJobs 报成卡住。
 *
 * ok=false 时 errorText 必填且必须是原文（三方错误码与文案），空串直接抛错：
 * 这是把 migrate.ts 那句「禁止只写失败」硬化成代码，与 notify_log.logAttempt 同一条规矩。
 * runId 对不上任何行时也抛错，不容忍静默的 0 行更新：那行永远停在未跑完，
 * 于是这个任务从此天天被报成卡住——一次静默的写失败会长成一族假告警。
 */
export function finishRun(
  db: Database,
  runId: number,
  result: {
    /** **整轮**跑通没有。逐项失败几条不影响它——那是 itemsFailed 的事 */
    ok: boolean;
    /** 本轮检查了几项；0 是合法值（跑了，没有可做的），别用它表示「没跑」 */
    itemsExamined?: number;
    /** 其中成功几项；0 同样合法（examined=5, ok=0, failed=5 = 跑了，五条全失败） */
    itemsOk?: number;
    /** 其中失败几项。**逐项的失败原因不写这儿**，写 notify_log；本表只记这一轮的总账 */
    itemsFailed?: number;
    /** ok=false 时为整轮致命错误原文，不得为空 */
    errorText?: string;
    /** 人话摘要，给读表的人看（「扫 12 条期限，发出 9 封，3 封网关超时」） */
    note?: string;
  },
): void {
  if (!result.ok && !result.errorText?.trim()) {
    throw new Error('job_runs: ok=false 必须写明失败原因原文（三方返回的错误码与文案）');
  }
  const info = db
    .prepare(
      `UPDATE job_runs
          SET finished_at = datetime('now'), ok = ?, items_examined = ?, items_ok = ?,
              items_failed = ?, error_text = ?, note = ?
        WHERE id = ?`,
    )
    .run(
      result.ok ? 1 : 0,
      result.itemsExamined ?? null,
      result.itemsOk ?? null,
      result.itemsFailed ?? null,
      result.errorText ?? null,
      result.note ?? null,
      runId,
    );
  if (info.changes !== 1) {
    throw new Error(`job_runs: 回填失败，run_id=${runId} 查无此行`);
  }
}

/** 最近一次运行（含还没跑完的那次）。按 id 取最新而非时间串——秒精度不足以定序（ADR-002）。 */
export function lastRun(db: Database, jobName: JobName | string): JobRun | undefined {
  return db
    .prepare(`SELECT ${COLS} FROM job_runs WHERE job_name = ? ORDER BY id DESC LIMIT 1`)
    .get(jobName) as JobRun | undefined;
}

/** 三种异常要采取的行动不同，所以分开报，不合并成一句「不正常」。 */
export type StaleReason = '从未跑过' | '太久没跑' | '未跑完';

export interface JobSpec {
  name: JobName | string;
  /** 超过这个小时数还没跑完一轮就算异常；按任务自己的周期给（日更任务给 24～36 之类）。 */
  maxAgeHours: number;
}

export interface StaleJob {
  name: string;
  reason: StaleReason;
  /** 从未跑过时没有 */
  lastRun?: JobRun;
  /** 可直接进告警的人话（三种 reason 各说各的，不写成一句通用文案） */
  detail: string;
}

/**
 * 超期未跑清单：喂一份任务与各自允许的最大间隔，吐出所有异常的任务。**空数组 = 都正常。**
 *
 * 「未跑完」那一类只在**开跑时刻本身已经超过阈值**时才报。不加这个条件的话，
 * 每一轮正常运行的窗口期（已 startRun 未 finishRun）都会被报成卡住——一个天天响的告警
 * 等于没有告警。代价是真崩掉的那次要等一个阈值才报出来，这个取舍是刻意的。
 */
export function staleJobs(db: Database, jobs: JobSpec[]): StaleJob[] {
  const cutoffOf = db.prepare("SELECT datetime('now', ?) AS cutoff");
  const out: StaleJob[] = [];

  for (const job of jobs) {
    // 阈值算不出来（NaN / 负数）时 datetime() 返回 NULL，比较恒为 false ⇒ 这个任务从此没人盯。
    // 配置写错必须当场炸，不能变成一个安静的空清单。
    if (!(job.maxAgeHours >= 0)) {
      throw new Error(`job_runs: maxAgeHours 非法（${job.name}: ${job.maxAgeHours}）`);
    }
    const { cutoff } = cutoffOf.get(`-${job.maxAgeHours} hours`) as { cutoff: string };
    const last = lastRun(db, job.name);

    if (!last) {
      out.push({
        name: job.name,
        reason: '从未跑过',
        detail: `任务「${job.name}」一行运行记录都没有——它可能从来没被调度起来过`,
      });
    } else if (last.finished_at === null) {
      if (last.started_at < cutoff) {
        out.push({
          name: job.name,
          reason: '未跑完',
          lastRun: last,
          detail:
            `任务「${job.name}」最近一次于 ${last.started_at} 开跑，至今没有跑完` +
            `（已超 ${job.maxAgeHours} 小时，进程多半被杀或崩了）`,
        });
      }
    } else if (last.finished_at < cutoff) {
      out.push({
        name: job.name,
        reason: '太久没跑',
        lastRun: last,
        detail: `任务「${job.name}」最近一次跑完于 ${last.finished_at}，已超过 ${job.maxAgeHours} 小时没有再跑`,
      });
    }
  }

  return out;
}
