// app/src/lib/company/blocks.ts
// company_dossier_blocks 的封装：**逐块粒度**的进度留痕。
//
// 与 job_runs 的分工照 migrate.ts 那条规矩，别混：
//   job_runs                → 「公司档案采集这一轮有没有发生」（运行粒度）
//   company_dossier_blocks  → 「你这份档案到哪一步了」（逐项粒度）
// 进度态 API 只读本表。读 job_runs 答不出单个档案的进度——那张表里一行代表一整轮，
// 一轮推进了十个档案，谁成谁败它只给得出三个总数。
//
// 三态与 job_runs 同一套，靠 finished_at 分：
//   无行                      → 这一块从来没排过
//   有行、finished_at IS NULL → 在跑，或跑到一半崩了
//   有行、finished_at 非空    → 有结论，status 说明是哪种
//
// **skipped 必须是独立的一种结论，不许并进 ok**：「没有全文可喂，所以没调模型」
// 与「归纳跑完了，得到零条套路」在用户眼里是两件事；合成一个绿灯，
// 「这块其实是空的」就被藏起来了——而那正是用户付了钱最该知道的事。
import type { Database } from 'better-sqlite3';

/** 四个交付块，顺序即依赖顺序（stats 依赖 litigation，patterns 依赖 litigation 的全文）。 */
export type BlockName = 'graph' | 'litigation' | 'stats' | 'patterns';

export const BLOCK_NAMES: readonly BlockName[] = ['graph', 'litigation', 'stats', 'patterns'];

/** running=在跑（或崩了）；ok=有结论且成功；failed=有结论且失败；skipped=没跑，且这是正常的 */
export type BlockStatus = 'running' | 'ok' | 'failed' | 'skipped';

export interface BlockRow {
  id: number;
  dossier_id: number;
  block: string;
  status: string;
  started_at: string;
  /** NULL = 没跑完（在跑 / 崩了），三态全靠它区分 */
  finished_at: string | null;
  /** 失败原因**原文**，禁止只写「失败」 */
  error_text: string | null;
  note: string | null;
}

const COLS = 'id, dossier_id, block, status, started_at, finished_at, error_text, note';

/**
 * 开跑：插行占位（重跑同一块则把它重置回 running 并清掉上一次的结论）。
 *
 * 先插后回填，同 job_runs.startRun 的理由：只在跑完时插行，等于把崩掉的那次抹掉，
 * 而「崩了」与「根本没排过」正是本表要分开的两件事。
 */
export function startBlock(db: Database, dossierId: number, block: BlockName): void {
  db.prepare(
    `INSERT INTO company_dossier_blocks (dossier_id, block, status)
     VALUES (?, ?, 'running')
     ON CONFLICT (dossier_id, block) DO UPDATE SET
       status      = 'running',
       started_at  = datetime('now'),
       finished_at = NULL,
       error_text  = NULL,
       note        = NULL`,
  ).run(dossierId, block);
}

/**
 * 跑完回填。失败也要调——不调的那一行会一直停在 running，被进度页显示成「正在处理」，
 * 用户干等一个永远不会来的结果。
 *
 * status='failed' 时 errorText 必填且必须是原文，空串当场抛错：
 * 与 job-runs.finishRun / notify_log.detail 同一条规矩（「写了等于没写」的失败原因不算原因）。
 * runId 对不上任何行时也抛错，不容忍静默的 0 行更新。
 */
export function finishBlock(
  db: Database,
  dossierId: number,
  block: BlockName,
  result: { status: Exclude<BlockStatus, 'running'>; errorText?: string; note?: string },
): void {
  if (result.status === 'failed' && !result.errorText?.trim()) {
    throw new Error(
      `company_dossier_blocks: ${block} 块标失败必须写明原因原文（缺什么/为什么缺/怎么办），` +
        '只写「失败」等于没写——进度页会把它原样转给用户，用户拿它没有任何可做的事。',
    );
  }
  const info = db
    .prepare(
      `UPDATE company_dossier_blocks
          SET status = ?, finished_at = datetime('now'), error_text = ?, note = ?
        WHERE dossier_id = ? AND block = ?`,
    )
    .run(result.status, result.errorText ?? null, result.note ?? null, dossierId, block);
  if (info.changes !== 1) {
    throw new Error(
      `company_dossier_blocks: 回填失败，dossier_id=${dossierId} block=${block} 查无此行——` +
        'finishBlock 之前必须先 startBlock（先插后回填是三态的前提）。',
    );
  }
}

/** 某一块的当前行；无行即「从来没排过」，返回 undefined（不要拿它跟 running 混）。 */
export function getBlock(
  db: Database,
  dossierId: number,
  block: BlockName,
): BlockRow | undefined {
  return db
    .prepare(`SELECT ${COLS} FROM company_dossier_blocks WHERE dossier_id = ? AND block = ?`)
    .get(dossierId, block) as BlockRow | undefined;
}

/** 一份档案的全部块（只返回排过的；没排过的块在这里根本不出现，别用长度当进度）。 */
export function listBlocks(db: Database, dossierId: number): BlockRow[] {
  return db
    .prepare(`SELECT ${COLS} FROM company_dossier_blocks WHERE dossier_id = ? ORDER BY id`)
    .all(dossierId) as BlockRow[];
}
