// app/src/lib/jobs/extraction-worker.ts
// 内容提取的进程内 worker：从 extraction_jobs 领一条任务，跑对应 handler，把结果写回 evidence。
//
// ───────────────── ⚠️ 单进程假设 ⚠️ ─────────────────
// 本 worker 假设**同一个库同时只有一个进程在跑它**（今日部署形态：一台机、一个
// Next standalone 进程，见 deploy/）。租约（lease_until）挡的是「同一个进程的两次 tick
// 撞上同一条任务」与「进程死了任务卡死」，不是分布式互斥：
// 领取那句是 `UPDATE ... WHERE id=(SELECT ... LIMIT 1)`，在 SQLite 的写串行化下
// 单进程内足够，多进程时两边可能先后领到同一条（后者覆盖前者的租约，于是同一份材料被跑两遍、
// 计费却只有一笔）。**要上多进程/多机，先把领取改成行锁**：
//   UPDATE ... SET status='running', lease_until=? WHERE id=? AND (status='queued' OR lease_until<=?)
// 按 changes===1 判定抢到，抢不到就换下一条——那时本段注释要一并改写，别让下一个人以为
// 单进程假设还成立。
// ────────────────────────────────────────────────
//
// 【为什么是常驻 worker，不是 cron 轮询状态列】仓内此前唯一的异步范式是 cron 每若干分钟
// 推进一次状态列。提取不适用：用户提交一段录音之后是**等在页面上**的，分钟级的领取延迟
// 意味着他先看到十几分钟的「排队中」。5 秒一轮是给「等着看结果」这个节奏定的。
//
// 【租约而不是「清理僵尸任务」的收尾代码】进程被 kill、机器重启，正在跑的任务留在
// status='running'，租约到点自然过期，下一轮扫描把它当可领取的重新捞起。收尾代码只在崩溃时
// 才跑，也就永远没被跑过——真出事那天它自己也是坏的。
//
// 【本文件是共用层，不写死任何具体业务领域的字面量】面向的是「一件材料 + 一种提取方式」。
import type Database from 'better-sqlite3';

import { ocrImage } from '../evidence/sidecar-client';
import { readBytes } from '../evidence/files';
import { nowSql, toSql } from '../db/time';

/** 提取方式。ocr 已落地；asr / video 的 handler 由内容提取接线工单补。 */
export type ExtractionMode = 'ocr' | 'asr' | 'video';

/** 任务状态机。与 evidence.extraction_status 同名同物（那边多一档 none = 从没排过队）。 */
export type ExtractionStatus = 'queued' | 'running' | 'done' | 'failed';

/**
 * 一条任务最多被领取几次。**领取次数不是失败次数**：跑到一半进程没了，既没成功也没写失败，
 * 记失败次数的话这种形态永远不计数，一条毒任务会被无限重领。
 */
export const MAX_ATTEMPTS = 3;
/** 租约时长：领取者承诺在这个点之前干完或续租。 */
export const LEASE_MS = 120_000;
/** 心跳间隔：跑的过程中每隔这么久续一次租。必须显著小于 LEASE_MS，否则跑着跑着就被别人抢走。 */
export const HEARTBEAT_MS = 30_000;
/** 扫描间隔。 */
export const POLL_MS = 5_000;

export interface ExtractionJob {
  id: number;
  evidence_id: number;
  case_id: number;
  user_id: number;
  mode: ExtractionMode;
  status: ExtractionStatus;
  quote_id: number | null;
  cost: number;
  lease_until: string | null;
  heartbeat_at: string | null;
  attempts: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const JOB_COLUMNS =
  `id, evidence_id, case_id, user_id, mode, status, quote_id, cost,
   lease_until, heartbeat_at, attempts, error, started_at, finished_at`;

// ───────────────────────────── 入队与查询 ─────────────────────────────

export interface EnqueueInput {
  evidenceId: number;
  caseId: number;
  userId: number;
  mode: ExtractionMode;
  /** 这次提取是哪张报价买的（service_quotes.id）。NULL = 未走计费的内部重跑。 */
  quoteId?: number | null;
  /** 实扣公道值（券抵/免费为 0）。留痕用，本文件不据它计价。 */
  cost?: number;
}

/**
 * 入队一条提取任务，并把这件材料标成「排队中」。
 *
 * 两处写在同一个事务里：任务行与 evidence.extraction_status 分开写的话，中间崩一下就会
 * 留下「队列里有任务、材料上却写着 none」——页面据 evidence 那一列渲染，用户会看到
 * 「未提取」，然后再点一次，于是同一份材料排两条队、扣两笔钱。
 */
export function enqueueExtraction(db: Database.Database, input: EnqueueInput): ExtractionJob {
  return db.transaction(() => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO extraction_jobs (evidence_id, case_id, user_id, mode, quote_id, cost)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(
          input.evidenceId,
          input.caseId,
          input.userId,
          input.mode,
          input.quoteId ?? null,
          input.cost ?? 0,
        ).lastInsertRowid,
    );
    db.prepare("UPDATE evidence SET extraction_status='queued' WHERE id=?").run(input.evidenceId);
    return getJob(db, id) as ExtractionJob;
  })();
}

/** 取一条任务；不存在返回 null。 */
export function getJob(db: Database.Database, id: number): ExtractionJob | null {
  return (db.prepare(`SELECT ${JOB_COLUMNS} FROM extraction_jobs WHERE id=?`).get(id) ??
    null) as ExtractionJob | null;
}

// ───────────────────────────── 领取 / 心跳 / 收尾 ─────────────────────────────

/**
 * 领一条任务：queued 的，或 running 但租约已过期的（= 上一个领取者死了）。
 * 领取即 attempts+1、置租约、标 running，并把材料标成「处理中」。
 *
 * 返回 null 表示这一轮没有可领的任务（不是错误）。
 */
function claimNext(db: Database.Database, leaseMs: number): ExtractionJob | null {
  const now = nowSql();
  const lease = toSql(new Date(Date.now() + leaseMs));
  return db.transaction(() => {
    const job = db
      .prepare(
        `UPDATE extraction_jobs
            SET status='running',
                attempts = attempts + 1,
                lease_until = ?,
                heartbeat_at = ?,
                started_at = COALESCE(started_at, ?),
                error = NULL
          WHERE id = (
            SELECT id FROM extraction_jobs
             WHERE status='queued'
                OR (status='running' AND (lease_until IS NULL OR lease_until <= ?))
             ORDER BY id LIMIT 1)
        RETURNING ${JOB_COLUMNS}`,
      )
      .get(lease, now, now, now) as ExtractionJob | undefined;
    if (!job) return null;
    db.prepare("UPDATE evidence SET extraction_status='running' WHERE id=?").run(job.evidence_id);
    return job;
  })();
}

/**
 * 续租一次。**只续还在 running 的那条**：任务已经收尾（done/failed）之后再被心跳改回去，
 * 会让一条已完成的任务重新长出租约，读侧一眼看去像是又在跑了。
 */
export function heartbeat(db: Database.Database, jobId: number, leaseMs: number = LEASE_MS): void {
  db.prepare(
    `UPDATE extraction_jobs SET heartbeat_at=?, lease_until=? WHERE id=? AND status='running'`,
  ).run(nowSql(), toSql(new Date(Date.now() + leaseMs)), jobId);
}

/** 提取产物：正文 + 结构化附注（时间轴、说话人、模型名、帧号等，随 mode 不同）。 */
export interface ExtractionOutput {
  text: string;
  meta?: Record<string, unknown>;
}

function finishOk(db: Database.Database, job: ExtractionJob, out: ExtractionOutput): void {
  const now = nowSql();
  db.transaction(() => {
    db.prepare(
      `UPDATE extraction_jobs SET status='done', finished_at=?, error=NULL, lease_until=NULL WHERE id=?`,
    ).run(now, job.id);
    // 结果与状态一起写：分开写的话中间崩一下就会留下「任务 done、材料上没有文本」，
    // 而重跑会被 done 挡掉——那份材料从此永远是空的。
    db.prepare(
      `UPDATE evidence
          SET extraction_status='done', extracted_text=?, extracted_meta_json=?, extracted_at=?
        WHERE id=?`,
    ).run(out.text, out.meta ? JSON.stringify(out.meta) : null, now, job.evidence_id);
  })();
}

/**
 * 收尾一次失败。还没用完领取次数就退回 queued 等下一轮重试；用完了置 failed。
 * 两种情形材料上的状态不同：queued（还会再试）与 failed（不会再试了）——
 * 合成一档的话，用户看到「失败」却过一会儿又自己好了，或看到「排队中」却永远不动。
 */
function finishFailed(db: Database.Database, job: ExtractionJob, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const exhausted = job.attempts >= MAX_ATTEMPTS;
  const now = nowSql();
  db.transaction(() => {
    db.prepare(
      `UPDATE extraction_jobs SET status=?, error=?, lease_until=NULL, finished_at=? WHERE id=?`,
    ).run(exhausted ? 'failed' : 'queued', message, exhausted ? now : null, job.id);
    db.prepare('UPDATE evidence SET extraction_status=? WHERE id=?').run(
      exhausted ? 'failed' : 'queued',
      job.evidence_id,
    );
  })();
}

// ───────────────────────────── handler ─────────────────────────────

export type ExtractionHandler = (
  db: Database.Database,
  job: ExtractionJob,
) => Promise<ExtractionOutput>;

interface MaterialRow {
  file_id: number;
  name: string;
  mime: string | null;
}

function loadMaterial(db: Database.Database, job: ExtractionJob): MaterialRow {
  const row = db
    .prepare(
      `SELECT e.file_id AS file_id, e.name AS name, f.mime AS mime
         FROM evidence e JOIN files f ON f.id = e.file_id
        WHERE e.id = ?`,
    )
    .get(job.evidence_id) as MaterialRow | undefined;
  if (!row) {
    // 自述三段式：缺什么 / 为什么缺 / 怎么办
    throw new Error(
      `找不到任务 ${job.id} 要处理的材料（evidence_id=${job.evidence_id}）。` +
        '为什么：这条材料在排队期间被删掉了，或它指向的文件登记行不在了。' +
        '怎么办：这条任务不必重试；材料还在的话重新发起一次提取。',
    );
  }
  return row;
}

/**
 * 图片文字识别。**app 侧解密、把明文字节传给 sidecar**（同 /pades 那条已验证的路径）：
 * 解密密钥只在 app 这边，sidecar 照路径读到的是一份读不懂的密文。
 */
const ocrHandler: ExtractionHandler = async (db, job) => {
  const material = loadMaterial(db, job);
  const bytes = readBytes(db, material.file_id);
  const result = await ocrImage(bytes, material.mime ?? 'image/jpeg', material.name);
  return {
    text: result.text,
    meta: { mode: 'ocr', model: result.model, request_id: result.request_id, mime: material.mime },
  };
};

/** 尚未落地的提取方式：**明说没做**，不要退化成「提取出来是空的」。 */
const notImplemented =
  (mode: ExtractionMode): ExtractionHandler =>
  async () => {
    throw new Error(
      `提取方式「${mode}」还没接线。` +
        '为什么：这一期只落了 ocr 的 handler，其余两种的 handler 由内容提取接线工单补。' +
        '怎么办：这条任务不必重试，等对应能力上线后重新发起。',
    );
  };

export const HANDLERS: Record<ExtractionMode, ExtractionHandler> = {
  ocr: ocrHandler,
  asr: notImplemented('asr'),
  video: notImplemented('video'),
};

// ───────────────────────────── 主循环 ─────────────────────────────

export interface WorkerOptions {
  /** 覆盖 handler 表（测试用假 handler 观察状态机；生产不传）。 */
  handlers?: Partial<Record<ExtractionMode, ExtractionHandler>>;
  leaseMs?: number;
  heartbeatMs?: number;
}

/** 这一轮做了什么。'idle' = 没有可领的任务（不是错误）。 */
export type TickResult = 'idle' | 'done' | 'failed';

/**
 * 跑一轮：领一条任务、开心跳、跑 handler、收尾。**不抛错**——handler 的失败是任务的失败，
 * 不该把 worker 循环本身打断（一条毒任务不能让后面所有任务都排不上）。
 */
export async function runOnce(
  db: Database.Database,
  options: WorkerOptions = {},
): Promise<TickResult> {
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const handlers = { ...HANDLERS, ...options.handlers };

  const job = claimNext(db, leaseMs);
  if (!job) return 'idle';

  // 领取次数用尽：这条任务反复被领却从没跑完（每次都崩在半路），到此为止。
  if (job.attempts > MAX_ATTEMPTS) {
    finishFailed(
      db,
      job,
      new Error(
        `提取任务 ${job.id} 已被领取 ${job.attempts} 次仍未跑完，不再重试。` +
          '为什么：每次领取都没能走到收尾（多半是进程中途退出或依赖持续不可用）。' +
          '怎么办：查 sidecar 与本进程的日志确认原因，修好后重新发起一次提取。',
      ),
    );
    return 'failed';
  }

  const timer = setInterval(() => heartbeat(db, job.id, leaseMs), heartbeatMs);
  try {
    const out = await handlers[job.mode](db, job);
    finishOk(db, job, out);
    return 'done';
  } catch (err) {
    finishFailed(db, job, err);
    return 'failed';
  } finally {
    clearInterval(timer);
  }
}

let loop: ReturnType<typeof setInterval> | null = null;

/**
 * 起进程内 worker（幂等：已经起过就不再起第二个）。
 * 一轮没跑完不会叠下一轮——`running` 这个门闩挡住重入，否则慢任务会让 tick 越堆越多。
 */
export function startExtractionWorker(db: Database.Database, options: WorkerOptions = {}): void {
  if (loop) return;
  let running = false;
  loop = setInterval(() => {
    if (running) return;
    running = true;
    void runOnce(db, options).finally(() => {
      running = false;
    });
  }, POLL_MS);
  // 这个定时器不该拖住进程退出：它是后台巡检，不是待办事项。
  loop.unref?.();
}

/** 停 worker（测试与优雅退出用）。 */
export function stopExtractionWorker(): void {
  if (!loop) return;
  clearInterval(loop);
  loop = null;
}
