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

import { generateBrief } from '../evidence/brief';
import { defaultBriefLlm } from '../evidence/brief-llm';
import {
  extractVideo,
  ocrImage,
  transcribeAudio,
  type AsrSentence,
} from '../evidence/sidecar-client';
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

/** 秒 → `时:分:秒`（毫秒进来先除 1000）。时间轴是给人回原件核对用的，必须能直接对上播放器。 */
function stamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * 把逐句结果排成带时间轴与说话人的正文。
 *
 * 【为什么正文里要带时间轴，而不是只在 meta 里】用户拿这段文字去核对时，手上只有正文；
 * 时间点只存在结构化附注里，等于要他自己把两份东西对起来看。说话人也一样：
 * 一段两个人的对话拉平成一大段，读的人分不出哪句是谁说的——而"谁说的"往往就是要害。
 */
function renderTranscript(sentences: AsrSentence[], fallback: string): string {
  if (sentences.length === 0) return fallback;
  return sentences
    .map((s) => {
      const speaker = s.speaker_id === null ? '说话人未分离' : `说话人${s.speaker_id}`;
      return `[${stamp(s.begin_time / 1000)}-${stamp(s.end_time / 1000)}] ${speaker}：${s.text}`;
    })
    .join('\n');
}

/** 逐句结果压成可落库的附注（时间轴以毫秒原样保留，不做取整——取整过的时间对不回播放器）。 */
function timelineMeta(sentences: AsrSentence[]): Record<string, unknown>[] {
  return sentences.map((s) => ({
    begin_ms: s.begin_time,
    end_ms: s.end_time,
    speaker_id: s.speaker_id,
    text: s.text,
  }));
}

/** 录音转写。同 ocr：app 侧解密、把明文字节传给 sidecar（解密密钥只在 app 这边）。 */
const asrHandler: ExtractionHandler = async (db, job) => {
  const material = loadMaterial(db, job);
  const bytes = readBytes(db, material.file_id);
  const result = await transcribeAudio(bytes, material.name);
  return {
    text: renderTranscript(result.sentences, result.text),
    meta: {
      mode: 'asr',
      model: result.model,
      task_id: result.task_id,
      mime: material.mime,
      speakers: [...new Set(result.sentences.map((s) => s.speaker_id).filter((x) => x !== null))],
      timeline: timelineMeta(result.sentences),
    },
  };
};

/**
 * 每张关键帧问一次：**一句画面描述 + 逐字抄画面上的字**。
 *
 * 【为什么合成一次问，而不是描述一次、认字一次】同一张图问两遍要付两遍钱，
 * 而两个答案的依据是同一张图。合成一问的代价是格式要靠模型配合——所以第一行固定是描述，
 * 拿不到就整段当描述用（下面 splitFrameAnswer），不会因为格式没对上就把认出来的字丢掉。
 */
const FRAME_PROMPT =
  '先用一句话描述这张画面里发生了什么（谁、在哪、在做什么），单独成第一行；' +
  '再从第二行开始，把画面上出现的所有文字逐字抄下来，一个字都不要改写或补全；' +
  '画面上没有文字就只写第一行。';

function splitFrameAnswer(answer: string): { caption: string; text: string } {
  const lines = answer.split(/\r?\n/).map((l) => l.trim());
  const first = lines.findIndex((l) => l !== '');
  if (first < 0) return { caption: '', text: '' };
  return {
    caption: lines[first],
    text: lines.slice(first + 1).join('\n').trim(),
  };
}

/**
 * 视频提取：sidecar 拆出音轨与关键帧 → 音轨走转写、每帧走识别 → 合成一份正文。
 *
 * 【为什么一帧失败不算整条失败】十二张帧里有一张识别不出来（模糊、纯黑），
 * 把整次提取判失败等于让用户为已经跑完的转写与其余十一张白付一次钱。失败的帧在正文里
 * 明写「这一帧没认出来」——**留一个看得见的洞，而不是一个看不见的空白**。
 */
const videoHandler: ExtractionHandler = async (db, job) => {
  const material = loadMaterial(db, job);
  const bytes = readBytes(db, material.file_id);
  const cut = await extractVideo(bytes, material.name);

  let transcript = '';
  let asrMeta: Record<string, unknown> | null = null;
  if (cut.audio_wav_b64) {
    const audio = Buffer.from(cut.audio_wav_b64, 'base64');
    const heard = await transcribeAudio(audio, `${material.name}.wav`);
    transcript = renderTranscript(heard.sentences, heard.text);
    asrMeta = {
      model: heard.model,
      task_id: heard.task_id,
      speakers: [...new Set(heard.sentences.map((s) => s.speaker_id).filter((x) => x !== null))],
      timeline: timelineMeta(heard.sentences),
    };
  }

  const frames: Record<string, unknown>[] = [];
  const frameLines: string[] = [];
  for (const f of cut.frames) {
    try {
      const shot = await ocrImage(
        Buffer.from(f.jpeg_b64, 'base64'),
        'image/jpeg',
        `${material.name}-${f.t_s}s.jpg`,
        FRAME_PROMPT,
      );
      const { caption, text } = splitFrameAnswer(shot.text);
      frames.push({ t_s: f.t_s, caption, text, model: shot.model });
      frameLines.push(
        `[${stamp(f.t_s)}] ${caption || '（没给出画面描述）'}${text ? `\n  画面文字：${text}` : ''}`,
      );
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      frames.push({ t_s: f.t_s, caption: '', text: '', error: why });
      frameLines.push(`[${stamp(f.t_s)}] （这一帧没能识别：${why}）`);
    }
  }

  const sections: string[] = [];
  sections.push(
    cut.audio_wav_b64
      ? `【音轨转写】\n${transcript || '（音轨里没有识别出话音）'}`
      : '【音轨转写】（这段影像没有音轨）',
  );
  sections.push(
    cut.frames.length > 0
      ? `【画面关键帧】\n${frameLines.join('\n')}`
      : '【画面关键帧】（这个文件里没有可抽帧的画面轨）',
  );

  return {
    text: sections.join('\n\n'),
    meta: {
      mode: 'video',
      mime: material.mime,
      duration_s: cut.duration_s,
      probe: cut.probe,
      frames,
      asr: asrMeta,
    },
  };
};

export const HANDLERS: Record<ExtractionMode, ExtractionHandler> = {
  ocr: ocrHandler,
  asr: asrHandler,
  video: videoHandler,
};

// ───────────────────────────── 主循环 ─────────────────────────────

/**
 * 提取跑完之后的收尾动作。默认是给这份材料写一份摘要卡（见下方 writeSummary）。
 * 测试可以注入一个假的观察它有没有被调；**传 null 明确表示不做**，
 * 而不是"忘了传就悄悄不做"——判据「摘要生成跳过 ⇒ 红」钉的就是这个默认值。
 */
export type AfterExtraction = (db: Database.Database, job: ExtractionJob) => Promise<void>;

export interface WorkerOptions {
  /** 覆盖 handler 表（测试用假 handler 观察状态机；生产不传）。 */
  handlers?: Partial<Record<ExtractionMode, ExtractionHandler>>;
  /** 覆盖收尾动作；显式传 null = 这一轮不做收尾。 */
  afterExtraction?: AfterExtraction | null;
  leaseMs?: number;
  heartbeatMs?: number;
}

/**
 * 默认收尾：提取完成后给这份材料自动写一份摘要卡（不额外收费，价含在提取里）。
 *
 * 【为什么失败只吞不抛】正文已经落库了，那才是用户付钱买的东西。摘要写不出来
 * （模型没连上、返回的不合 schema）时把整条任务判失败，会让它被重领、重跑一遍提取——
 * 为一张卡片再烧一次转写的钱。所以这里只吞掉并留一行日志，材料仍是 done。
 */
export const writeSummary: AfterExtraction = async (db, job) => {
  const llm = defaultBriefLlm();
  if (!llm) {
    console.warn(`[extraction] 任务 ${job.id}：没有可用的模型，这份材料暂时没有摘要卡`);
    return;
  }
  const r = await generateBrief(db, job.evidence_id, llm);
  if (!r.ok) console.warn(`[extraction] 任务 ${job.id} 的摘要卡没写成：${r.error}`);
};

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
  const after = options.afterExtraction === undefined ? writeSummary : options.afterExtraction;

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
    // 收尾在 finishOk 之后，且**它抛错也不改判**：正文已经落库，那是用户付钱买的东西。
    // 让收尾的失败冒到下面的 catch 里，会把一条已经 done 的任务改写成 failed 并重排一次——
    // 为一张卡片再烧一次提取的钱。
    if (after) {
      try {
        await after(db, job);
      } catch (err) {
        console.warn(`[extraction] 任务 ${job.id} 的收尾动作抛错（不影响提取结果）：`, err);
      }
    }
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
