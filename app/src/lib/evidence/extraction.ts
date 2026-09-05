// app/src/lib/evidence/extraction.ts
// 内容提取的领域层：报价 → 确认扣费 → 入队，以及提取结果与简报的读写。
// MCP 工具（lib/capabilities/families/evidence）与网页的 REST 路由都只调本文件，
// 两个入口共用同一套闸门（P1）——闸开在这里，工具壳里一个判断都不放。
//
// 【两步不是一步的原因】报价免费、确认才扣钱（P5）。合成一步就没有「用户看到价再决定」
// 这个环节了，而耗算力动作的价随材料大小浮动，事先看不见。
//
// 【为什么归属判在这里、且不区分"不存在"与"不是你的"】evidence_id 是连号的，
// 区分开就等于给了一个探测别人上传了多少材料的信号。他人的 evidence_id 一律 404，
// 且在任何写入之前返回——判据「他人 evidence_id 零写入」钉着这条。
import type { Database } from 'better-sqlite3';

import { AUTH_STATUS } from '@/lib/auth/realname';

import {
  confirmService,
  peekServiceQuote,
  quoteService,
  unitsFromSeconds,
  type PricedService,
  type ServiceQuote,
} from '@/lib/billing/service-quotes';
import {
  enqueueExtraction,
  getJob,
  type ExtractionJob,
  type ExtractionMode,
} from '@/lib/jobs/extraction-worker';

import { fail, type Result } from './attest';
import { briefSummary, parseBrief, saveBrief, type EvidenceBrief } from './brief';
import { readBytes } from './files';
import { countPdfPages, isPdf, MediaMetaError, probeDurationSeconds } from './media-meta';

/** 三种提取方式（与 extraction_jobs.mode、service_quotes.service 同名同物）。 */
export const EXTRACTION_MODES: readonly ExtractionMode[] = ['ocr', 'asr', 'video'];

/**
 * evidence_get 回包里提取文本的字符上限。超过就截断并置 truncated=true。
 * 【为什么要有】一份两小时的转写稿有几万字，整份塞进一次工具回包会把 agent 的上下文吃光，
 * 而它多半只需要前面几段就知道该不该细读。要全文的走网页详情页或分段再问。
 */
export const EXTRACTED_TEXT_LIMIT = 8000;

interface EvidenceOwnedRow {
  id: number;
  case_id: number;
  user_id: number;
  file_id: number;
  name: string;
  category: string;
  prove_purpose: string | null;
  original_medium: string | null;
  status: string;
  created_at: string;
  extraction_status: string;
  extracted_text: string | null;
  extracted_meta_json: string | null;
  extracted_at: string | null;
  brief_json: string | null;
  brief_version: number;
  brief_updated_by: string | null;
  mime: string | null;
  size: number;
}

const NOT_FOUND = () =>
  fail(
    404,
    'EVIDENCE_NOT_FOUND',
    '这件材料不存在，或不属于本人（两者刻意不区分）。先用 evidence_list 取本人名下真实的编号。',
  );

/** 取一行并判归属。**任何写入之前都先过这里**。 */
function ownedEvidence(db: Database, evidenceId: number, userId: number): EvidenceOwnedRow | null {
  if (!Number.isInteger(evidenceId) || evidenceId <= 0) return null;
  const row = db
    .prepare(
      `SELECT e.id, e.case_id, e.user_id, e.file_id, e.name, e.category, e.prove_purpose,
              e.original_medium, e.status, e.created_at, e.extraction_status, e.extracted_text,
              e.extracted_meta_json, e.extracted_at, e.brief_json, e.brief_version,
              e.brief_updated_by, f.mime, f.size
         FROM evidence e JOIN files f ON f.id = e.file_id
        WHERE e.id = ?`,
    )
    .get(evidenceId) as EvidenceOwnedRow | undefined;
  if (!row || row.user_id !== userId) return null;
  return row;
}

// ───────────────────────────── 计量 ─────────────────────────────

export interface ExtractionUnits {
  units: number;
  unitLabel: string;
  /** 这个数是怎么来的，报价里原样印给用户看——只给一个数字的报价没法核。 */
  basis: string;
}

/**
 * 这件材料按这种方式提取要算几个单位。图片一张一页、PDF 数页对象、音视频按 ffprobe 的时长。
 * 数量只从文件本身读出来，**不接受调用方传**（见 media-meta 文件头）。
 */
function measure(db: Database, row: EvidenceOwnedRow, mode: ExtractionMode): ExtractionUnits {
  if (mode === 'ocr') {
    if (isPdf(row.mime, row.name)) {
      const pages = countPdfPages(readBytes(db, row.file_id));
      return { units: pages, unitLabel: '页', basis: `PDF 数出 ${pages} 页` };
    }
    return { units: 1, unitLabel: '页', basis: '单张图片按 1 页计' };
  }
  const seconds = probeDurationSeconds(readBytes(db, row.file_id), row.name);
  const units = unitsFromSeconds(seconds);
  return {
    units,
    unitLabel: '分钟',
    basis: `实测时长 ${seconds.toFixed(1)} 秒，不足一分钟按一分钟计，共 ${units} 分钟`,
  };
}

/** 载体与提取方式对不上时当场拒绝，不要报出一个跑起来必定失败的价。 */
function modeMismatch(row: EvidenceOwnedRow, mode: ExtractionMode): string | null {
  const mime = row.mime ?? '';
  if (mode === 'ocr' && (mime.startsWith('audio/') || mime.startsWith('video/'))) {
    return `《${row.name}》是${mime.startsWith('audio/') ? '音频' : '视频'}，不能按图片识别（ocr）。` +
      '为什么：ocr 认的是画面上的字，音频里没有画面。' +
      `怎么办：改用 ${mime.startsWith('audio/') ? 'asr（录音转写）' : 'video（视频提取）'}。`;
  }
  if (mode === 'asr' && (mime.startsWith('image/') || isPdf(row.mime, row.name))) {
    return `《${row.name}》是${isPdf(row.mime, row.name) ? 'PDF' : '图片'}，里面没有声音，不能转写（asr）。` +
      '为什么：asr 转的是音轨。怎么办：改用 ocr（图片/PDF 文字识别）。';
  }
  if (mode === 'video' && !mime.startsWith('video/') && mime !== '') {
    return `《${row.name}》的类型是 ${mime}，不是视频，不能走 video 提取。` +
      '为什么：video 要先抽音轨与关键帧，非视频容器抽不出来。' +
      '怎么办：音频用 asr，图片/PDF 用 ocr。';
  }
  return null;
}

/**
 * 实名闸（P3：闸门在服务端，不靠调用方自觉）。**只挡扣费那一步，不挡报价**：
 * 报价免费且只读，先让人看得到价再去补实名，比"先补实名才知道多少钱"讲理。
 */
function requireVerified(db: Database, userId: number): ReturnType<typeof fail> | null {
  const row = db.prepare('SELECT auth_status FROM users WHERE id=?').get(userId) as
    | { auth_status: string }
    | undefined;
  if (row?.auth_status === AUTH_STATUS.verified) return null;
  return fail(
    403,
    'REALNAME_REQUIRED',
    '这一步需要先完成实名认证。' +
      '为什么：提取出来的内容会随材料一起进入对外使用的链路，与本人身份绑定。' +
      '怎么办：在网页的账户页完成实名后重试；报价这一步不需要实名，可以先看价。',
  );
}

// ───────────────────────────── 报价 ─────────────────────────────

export interface ExtractionQuoteView {
  quote_id: number;
  amount: number;
  expires_at: string;
  units: number;
  unit_label: string;
  unit_price: number;
  /** 计价读的是 pricing_config 的哪个键，改价的人照它去改表 */
  price_key: string;
  basis: string;
  label: string;
  note: string;
}

const QUOTE_NOTE =
  '这一步没有扣任何费用。带着 quote_id 再调一次同一个工具才会扣费并开始提取；' +
  '不确认就什么都不会发生，报价过期作废。';

/**
 * 报价。**只读钱、不动钱**（quoteService 的第一条铁律）。
 * 计量失败（读不出时长、没装 ffprobe）回 422 并把三段式原因原样带出去。
 */
export function quoteExtraction(
  db: Database,
  input: { evidenceId: number; userId: number; mode: ExtractionMode },
): Result<{ quote: ExtractionQuoteView }> {
  const row = ownedEvidence(db, input.evidenceId, input.userId);
  if (!row) return NOT_FOUND();

  const mismatch = modeMismatch(row, input.mode);
  if (mismatch) return fail(400, 'MODE_MISMATCH', mismatch);

  let measured: ExtractionUnits;
  try {
    measured = measure(db, row, input.mode);
  } catch (err) {
    if (err instanceof MediaMetaError) return fail(422, 'MEASURE_FAILED', err.message);
    throw err;
  }

  const quoted = quoteService(db, {
    userId: input.userId,
    caseId: row.case_id,
    service: input.mode as PricedService,
    payload: { units: measured.units, evidenceId: row.id },
  });
  if (!quoted.ok) return fail(quoted.status, quoted.errorCode, quoted.message);

  const q: ServiceQuote = quoted.quote;
  return {
    ok: true,
    quote: {
      quote_id: q.quoteId,
      amount: q.amount,
      expires_at: q.expiresAt,
      units: q.breakdown.units,
      unit_label: q.breakdown.unitLabel,
      unit_price: q.breakdown.unitPrice,
      price_key: q.breakdown.priceKey,
      basis: measured.basis,
      label: q.breakdown.label,
      note: QUOTE_NOTE,
    },
  };
}

// ───────────────────────────── 确认并入队 ─────────────────────────────

export interface ExtractionStartView {
  job_id: number;
  status: string;
  mode: ExtractionMode;
  charged: number;
  paid_by: string;
  /** true = 这张报价此前已确认过，本次没有产生第二笔扣费，也没有排第二条队 */
  deduped: boolean;
  note: string;
}

/**
 * 确认扣费并把提取任务排进队列。
 *
 * 【幂等落在两处、方向一致】confirmService 抢占 confirmed_at 抢输的那次判重放（不扣第二笔），
 * 本函数据同一张报价查已有的任务行（quote_id 唯一定位一次提取），有就原样回那条任务——
 * 只挡住扣费不挡住入队的话，重发会让同一份材料排两条队：钱只扣一笔，算力烧两份。
 *
 * 【为什么扣费在入队之前】反过来（先排队再扣费）会在余额不足时留下一条已经开始跑的任务。
 */
export function startExtraction(
  db: Database,
  input: { evidenceId: number; userId: number; mode: ExtractionMode; quoteId: number },
): Result<ExtractionStartView> {
  const row = ownedEvidence(db, input.evidenceId, input.userId);
  if (!row) return NOT_FOUND();

  const gate = requireVerified(db, input.userId);
  if (gate) return gate;

  // 【核对在扣费之前】拿一张给别的材料/别的方式报的价来确认，等于按 A 的页数买 B 的。
  // 放到 confirmService 之后再核就晚了：钱已经扣走，才发现买错了东西。
  const peek = peekServiceQuote(db, input.userId, input.quoteId);
  if (!peek) {
    return fail(
      404,
      'QUOTE_NOT_FOUND',
      `报价 ${input.quoteId} 不存在或不属于本人。重新报一次价再确认——报价是免费的。`,
    );
  }
  if (peek.service !== input.mode || peek.caseId !== row.case_id || peek.payload.evidenceId !== row.id) {
    return fail(
      409,
      'QUOTE_MISMATCH',
      `报价 ${input.quoteId} 买的不是这一次要做的事：那张价是给材料 ${peek.payload.evidenceId ?? '（未记）'} ` +
        `按「${peek.service}」报的，本次请求是材料 ${row.id} 按「${input.mode}」。` +
        '为什么：价随材料大小与方式浮动，换一件材料用同一张价就是按错的数收钱。' +
        '怎么办：对这件材料按这种方式重新报一次价（报价免费），拿新的 quote_id 再确认。',
    );
  }

  // 同一张报价已经排过队就原样回那条任务：只挡住重复扣费不挡住重复入队的话，
  // 重发会让同一份材料排两条队——钱扣一笔，算力烧两份。
  const existing = db
    .prepare('SELECT id FROM extraction_jobs WHERE quote_id=? AND evidence_id=? ORDER BY id LIMIT 1')
    .get(input.quoteId, row.id) as { id: number } | undefined;

  const confirmed = confirmService(db, input.userId, input.quoteId);
  if (!confirmed.ok) return fail(confirmed.status, confirmed.errorCode, confirmed.message);

  if (existing) {
    const job = getJob(db, existing.id) as ExtractionJob;
    return {
      ok: true,
      job_id: job.id,
      status: job.status,
      mode: input.mode,
      charged: 0,
      paid_by: confirmed.paidBy,
      deduped: true,
      note: '这张报价已经确认过了，提取任务也已排队，本次没有重复扣费、也没有重复排队。',
    };
  }

  const job = enqueueExtraction(db, {
    evidenceId: row.id,
    caseId: row.case_id,
    userId: input.userId,
    mode: input.mode,
    quoteId: input.quoteId,
    cost: confirmed.charged,
  });

  return {
    ok: true,
    job_id: job.id,
    status: job.status,
    mode: input.mode,
    charged: confirmed.charged,
    paid_by: confirmed.paidBy,
    deduped: confirmed.deduped,
    note:
      '已排队。提取在后台跑，完成后 evidence_get 能读到 extracted_text，' +
      '并会自动附上一份简报（不额外收费）。中途不必重发：失败会自动重试，三次都失败会把原因写在这件材料上。',
  };
}

// ───────────────────────────── 读侧 ─────────────────────────────

export interface EvidenceExtractionView {
  id: number;
  case_id: number;
  name: string;
  category: string;
  prove_purpose: string | null;
  original_medium: string | null;
  status: string;
  created_at: string;
  mime: string | null;
  size: number;
  extraction_status: string;
  extracted_at: string | null;
  extracted_meta: unknown;
  /**
   * 提取失败时的说明，含退款信息（「本次费用已退款 N 公道值」/「已退还 1 次提取额度」）；
   * 非失败态恒 null。失败原文存在 extraction_jobs.error，不在 evidence 行上，故读侧现取。
   */
  extraction_failure: string | null;
  /** include_text 未开时恒 null（省上下文），开了才带正文 */
  extracted_text: string | null;
  /** true = 正文被截到 EXTRACTED_TEXT_LIMIT 字；要全文去网页详情页 */
  truncated: boolean;
  extracted_text_chars: number;
  brief: EvidenceBrief | null;
  brief_version: number;
  brief_updated_by: string | null;
  brief_summary: string;
}

/** 最近一条已失败任务及其报价的退款事实（读侧据此拼失败说明）。 */
interface FailedJobRefund {
  error: string | null;
  refunded_at: string | null;
  /** job.cost：这次实扣的公道值（钱付=原价；券付/免费=0） */
  charged: number;
  entitlement_id: number | null;
}

function latestFailedRefund(db: Database, evidenceId: number): FailedJobRefund | null {
  const row = db
    .prepare(
      `SELECT j.error AS error, j.refunded_at AS refunded_at, j.cost AS charged,
              q.entitlement_id AS entitlement_id
         FROM extraction_jobs j
         LEFT JOIN service_quotes q ON q.id = j.quote_id
        WHERE j.evidence_id = ? AND j.status = 'failed'
        ORDER BY j.id DESC LIMIT 1`,
    )
    .get(evidenceId) as FailedJobRefund | undefined;
  return row ?? null;
}

/**
 * 失败态的对外说明：失败原文 + 退款结果。退了才说退了——refunded_at 为空（还没退、
 * 或这单本来没扣钱）时只给原文，不能凭空说「已退款」让用户去等一笔不存在的退款。
 */
function failureNote(f: FailedJobRefund | null): string | null {
  if (!f) return null;
  const base = f.error ?? '这件材料的内容提取失败了。';
  if (f.refunded_at === null) return base;
  const refund =
    f.entitlement_id !== null
      ? '本次为会员赠送额度，已退还 1 次提取额度。'
      : `本次费用已退款 ${f.charged} 公道值。`;
  return `${base}${refund}`;
}

function view(
  row: EvidenceOwnedRow,
  includeText: boolean,
  extractionFailure: string | null,
): EvidenceExtractionView {
  const brief = parseBrief(row.brief_json);
  const full = row.extracted_text ?? '';
  let meta: unknown = null;
  if (row.extracted_meta_json) {
    try {
      meta = JSON.parse(row.extracted_meta_json);
    } catch {
      meta = null;
    }
  }
  return {
    id: row.id,
    case_id: row.case_id,
    name: row.name,
    category: row.category,
    prove_purpose: row.prove_purpose,
    original_medium: row.original_medium,
    status: row.status,
    created_at: row.created_at,
    mime: row.mime,
    size: row.size,
    extraction_status: row.extraction_status,
    extracted_at: row.extracted_at,
    extracted_meta: meta,
    extraction_failure: extractionFailure,
    extracted_text: includeText ? full.slice(0, EXTRACTED_TEXT_LIMIT) : null,
    truncated: includeText && full.length > EXTRACTED_TEXT_LIMIT,
    extracted_text_chars: full.length,
    brief,
    brief_version: row.brief_version,
    brief_updated_by: row.brief_updated_by,
    brief_summary: briefSummary(brief),
  };
}

export function getEvidenceExtraction(
  db: Database,
  input: { evidenceId: number; userId: number; includeText?: boolean },
): Result<{ evidence: EvidenceExtractionView }> {
  const row = ownedEvidence(db, input.evidenceId, input.userId);
  if (!row) return NOT_FOUND();
  // 失败原文与退款信息只在失败态才现取一次——非失败态的读是热路径，不多一次 join。
  const failure =
    row.extraction_status === 'failed' ? failureNote(latestFailedRefund(db, row.id)) : null;
  return { ok: true, evidence: view(row, input.includeText === true, failure) };
}

export interface BriefView {
  evidence_id: number;
  brief: EvidenceBrief | null;
  /** 乐观锁基准：要改简报就把这个数原样回传给 brief_update 的 base_version */
  version: number;
  updated_by: string | null;
  extraction_status: string;
  note: string;
}

const NO_BRIEF_NOTE =
  '这件材料还没有简报。简报在内容提取完成后自动生成，出证时也会生成一份；' +
  '都还没做过就先发起提取（evidence_extract）。';

export function getEvidenceBrief(
  db: Database,
  input: { evidenceId: number; userId: number },
): Result<BriefView> {
  const row = ownedEvidence(db, input.evidenceId, input.userId);
  if (!row) return NOT_FOUND();
  const brief = parseBrief(row.brief_json);
  return {
    ok: true,
    evidence_id: row.id,
    brief,
    version: row.brief_version,
    updated_by: row.brief_updated_by,
    extraction_status: row.extraction_status,
    note: brief ? '要改就带上 version 作为 base_version 调 evidence_brief_update。' : NO_BRIEF_NOTE,
  };
}

/**
 * 改写简报（乐观锁）。base_version 必须是**你刚读到的那一版**：
 * 忽略它就会把别人的改动静默盖掉，而两边都收到"成功"。
 */
export function updateEvidenceBrief(
  db: Database,
  input: {
    evidenceId: number;
    userId: number;
    brief: EvidenceBrief;
    reason: string;
    baseVersion: number;
    updatedBy: string;
  },
): Result<{ evidence_id: number; version: number; reason: string }> {
  const row = ownedEvidence(db, input.evidenceId, input.userId);
  if (!row) return NOT_FOUND();

  const saved = saveBrief(db, {
    evidenceId: row.id,
    brief: input.brief,
    updatedBy: input.updatedBy,
    baseVersion: input.baseVersion,
  });
  if (!saved.ok) {
    if (saved.conflict) {
      return fail(
        409,
        'BRIEF_VERSION_CONFLICT',
        `简报已经被改过了：你基于第 ${input.baseVersion} 版改，库里现在是第 ${saved.version} 版。` +
          '为什么：中间有别的入口（网页、另一个 agent、服务端重新生成）写过一版，' +
          '照你的版本写下去会把那次改动整份盖掉。' +
          '怎么办：先用 evidence_brief_get 重读当前版本，把你的改动合进去，再带新的 base_version 提交。',
      );
    }
    return NOT_FOUND();
  }
  return { ok: true, evidence_id: row.id, version: saved.version, reason: input.reason };
}
