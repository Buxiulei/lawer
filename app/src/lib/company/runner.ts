// app/src/lib/company/runner.ts
// 「公司档案采集」定时任务的本体。CLI 壳在 scripts/dossier-runner.ts
//（那里只做「定位库 + 退出码」，同 scripts/reconcile.ts 的分工）。
//
// 【两个粒度别混，这是 job_runs 存在的全部理由】
//   job_runs（本文件 startRun/finishRun）→ 「这一轮有没有发生」
//   company_dossier_blocks（各块自己写） → 「你这份档案到哪一步了」
// 整轮炸（ok=0 + error_text）与逐项失败（items_failed）不许混一格：
// 「推进了 10 份、其中 3 份失败」与「一份没推进、整个任务崩了」读起来必须不一样。
//
// 【这个任务不会去抓文书】采集器在外勤工作站、要真人过验证码。本任务只做入库之后的事：
// 重算统计、跑套路归纳、推进状态。文书什么时候来由外勤开窗决定，不由这个 cron 决定。
import type { Database } from 'better-sqlite3';

import { finishRun, startRun } from '../db/job-runs';

import { finishBlock, getBlock, startBlock } from './blocks';
import { setStatus, type DossierRow } from './dossier';
import { generatePatterns, type PatternLlm } from './patterns';
import { computeStats, saveStats } from './stats';

/** 可推进的状态：已入队但还没到终态的那几种。done / litigation_expired 不再动。 */
const ADVANCEABLE = ['queued', 'graph_done', 'awaiting_relay', 'stats_ready'];

export interface RunnerReport {
  examined: number;
  ok: number;
  failed: number;
  /** 逐项失败原文，进日志；**不写进 job_runs.error_text**（那格只记整轮致命错误） */
  failures: { dossierId: number; error: string }[];
  note: string;
}

/**
 * 推进一轮。
 *
 * @param llm 归纳模型。**不传就完全不碰 patterns 块**（连行都不插）——
 *   插一行标成 skipped 会让「这次没配模型」看起来像「没有全文可喂」，
 *   而那两件事要采取的行动完全不同（一个去补配置，一个去等外勤开窗）。
 */
export async function advanceDossiers(
  db: Database,
  opts: { llm?: PatternLlm | null } = {},
): Promise<RunnerReport> {
  const rows = db
    .prepare(
      `SELECT d.id, d.status FROM company_dossiers d
        WHERE d.status IN (${ADVANCEABLE.map(() => '?').join(',')})
          AND EXISTS (SELECT 1 FROM company_litigation l WHERE l.dossier_id = d.id)
        ORDER BY d.id`,
    )
    .all(...ADVANCEABLE) as Pick<DossierRow, 'id' | 'status'>[];

  const report: RunnerReport = { examined: rows.length, ok: 0, failed: 0, failures: [], note: '' };

  for (const d of rows) {
    try {
      startBlock(db, d.id, 'stats');
      const stats = computeStats(db, d.id);
      saveStats(db, stats);
      finishBlock(db, d.id, 'stats', {
        status: 'ok',
        note: `已入档 ${stats.docs_total} 条／全文 ${stats.docs_fulltext} 篇／可判定 ${stats.docs_outcome_decided} 篇`,
      });

      if (opts.llm) await generatePatterns(db, d.id, opts.llm);

      const patternsBlock = getBlock(db, d.id, 'patterns');
      const patternsSettled =
        !!patternsBlock && patternsBlock.finished_at !== null && patternsBlock.status !== 'failed';
      setStatus(db, d.id, patternsSettled ? 'done' : 'stats_ready');
      report.ok += 1;
    } catch (e) {
      report.failed += 1;
      report.failures.push({ dossierId: d.id, error: (e as Error).message });
    }
  }
  report.note =
    `推进 ${report.examined} 份档案，成功 ${report.ok} 份、失败 ${report.failed} 份` +
    (opts.llm ? '' : '（本轮未配归纳模型，patterns 块未运行）');
  return report;
}

/**
 * 带 job_runs 留痕的一轮。**先插行后回填**：只在跑完时插行，等于把崩掉的那次抹掉，
 * 而「崩了」与「根本没跑」正是 job_runs 要分开的两件事。
 */
export async function runDossierJob(
  db: Database,
  opts: { llm?: PatternLlm | null } = {},
): Promise<RunnerReport> {
  const runId = startRun(db, '公司档案采集');
  try {
    const report = await advanceDossiers(db, opts);
    finishRun(db, runId, {
      ok: true,
      itemsExamined: report.examined,
      itemsOk: report.ok,
      itemsFailed: report.failed,
      note: report.note,
    });
    return report;
  } catch (e) {
    // 整轮炸：ok=0 + 原文。逐项失败走 items_failed，不走这里。
    finishRun(db, runId, { ok: false, errorText: `公司档案采集整轮失败：${(e as Error).message}` });
    throw e;
  }
}
