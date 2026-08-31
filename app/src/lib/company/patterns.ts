// app/src/lib/company/patterns.ts
// 「这家公司的套路」——LLM 归纳 + **零编造约束**。
//
// ─────────────── 这里的每一条约束都是代码拦，不是 prompt 里求它 ───────────────
// 1. **输入白名单**：只喂 has_fulltext=1 且有逐字原文的行。仅列表项的行**连标题都不喂**
//    ——一个「某公司、周某劳动争议一案」的标题足以让模型脑补出整段案情，
//    而它编出来的案情会带着一个真案号，看起来完全像真的。
// 2. **逐条机器校验**（落库前，不是落库后抽查）：
//    a. case_no 必须在**本档案已入库的案号集合**里 —— 用 SQL 存在性查询，
//       **不是**查「这个案号在不在我刚才拼的 prompt 里」。判决书正文里经常引用别的案号，
//       按 prompt 文本判存在，等于把模型抄的那个引用案号也认成证据。
//    b. quote 必须是该案号原文的**逐字子串**，只做全半角/空白归一，**不做同义改写**。
//       放宽成「包含关键词」就等于允许模型换一种说法——而换一种说法正是编造的形态。
// 3. 任一条不过 ⇒ 丢该条 evidence；evidence 清空 ⇒ 丢整条 pattern，并计入
//    company_dossier_stats.dropped_patterns。**这个计数必须可查**：
//    静默丢弃会把模型编造率藏起来，而编造率正是这条红线唯一的体温计。
//
// 【逐字校验的靶子是「逐字摘录」，不是整篇判决书】现有语料里我们手上只有裁判主文的逐字摘录。
// 靶子更小 ⇒ 校验更严 ⇒ 误差偏向「宁可丢掉一条真的」，方向安全。
import type { Database } from 'better-sqlite3';

import type { ChatMessage } from '../llm';

import { finishBlock, startBlock } from './blocks';

/** 模型侧的最小依赖面。lib/llm 的 Provider（实现了 chatJSON 的那几家）天然满足它。 */
export interface PatternLlm {
  chatJSON(messages: ChatMessage[]): Promise<string>;
  /** 计费键，落进 company_patterns.model，供事后追「这条套路是谁归纳的」 */
  readonly billingModel?: string;
}

export interface PatternEvidence {
  case_no: string;
  quote: string;
}

export interface PatternCandidate {
  pattern: string;
  evidence: PatternEvidence[];
}

export interface PatternsReport {
  /** 落库的 pattern 条数 */
  kept: number;
  /** 被校验丢掉的 pattern 条数（本次） */
  dropped: number;
  /** 逐条被丢掉的 evidence 条数（本次），用于分辨「整条编造」与「个别引文对不上」 */
  droppedEvidence: number;
  /** true = 没有可喂的全文，**根本没调模型**（块标 skipped，不是 ok） */
  skipped: boolean;
  /** 喂进去的全文篇数 */
  fedDocs: number;
}

const SYSTEM_PROMPT =
  '你是劳动争议判例的归纳助手。只依据用户给出的判决原文归纳该公司的应诉套路。' +
  '每条结论必须附带证据：证据里的 case_no 必须来自给定材料，quote 必须是该案原文中**一字不差**的连续片段。' +
  '找不到可逐字引用的原文就不要写那一条。' +
  '只输出 JSON：{"patterns":[{"pattern":"...","evidence":[{"case_no":"...","quote":"..."}]}]}';

/** 只做全半角与空白归一。**不做同义改写、不做标点等价、不做大小写以外的任何折叠。** */
export function normalizeForQuote(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]+/g, '');
}

interface FullTextRow {
  case_no: string;
  summary: string;
}

/** 归纳白名单：只有取到全文且有逐字原文的行进得来。 */
export function fullTextRows(db: Database, dossierId: number): FullTextRow[] {
  return db
    .prepare(
      `SELECT case_no, summary FROM company_litigation
        WHERE dossier_id = ? AND has_fulltext = 1
          AND summary IS NOT NULL AND TRIM(summary) <> ''
        ORDER BY id`,
    )
    .all(dossierId) as FullTextRow[];
}

/** 该案号在**本档案**里存在吗——SQL 存在性查询，不查 prompt 上下文。 */
function caseNoExists(db: Database, dossierId: number, caseNo: string): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM company_litigation WHERE dossier_id = ? AND case_no = ?')
    .get(dossierId, caseNo) as { ok: number } | undefined;
  return !!row;
}

/** 累计编造计数。**累加不清零**：它记的是「这份档案一共被模型编过几条」，
 *  是长期体温计；每次重跑归纳只覆盖 company_patterns 的内容，不抹掉这段病史。 */
function bumpDroppedPatterns(db: Database, dossierId: number, n: number): void {
  if (n <= 0) return;
  db.prepare(
    `INSERT INTO company_dossier_stats (dossier_id, dropped_patterns) VALUES (?, ?)
     ON CONFLICT (dossier_id) DO UPDATE SET
       dropped_patterns = company_dossier_stats.dropped_patterns + excluded.dropped_patterns`,
  ).run(dossierId, n);
}

/** 解析模型输出。解析不出来就当零条候选，不抛错——模型输出格式坏掉不该让整块跑崩，
 *  但也绝不能靠猜去修补它（修补出来的 JSON 里的证据没人核过）。 */
export function parseCandidates(raw: string): PatternCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (parsed as { patterns?: unknown })?.patterns;
  if (!Array.isArray(list)) return [];
  const out: PatternCandidate[] = [];
  for (const item of list) {
    const p = item as { pattern?: unknown; evidence?: unknown };
    if (typeof p?.pattern !== 'string' || !p.pattern.trim()) continue;
    const ev = Array.isArray(p.evidence) ? p.evidence : [];
    out.push({
      pattern: p.pattern.trim(),
      evidence: ev
        .map((e) => e as { case_no?: unknown; quote?: unknown })
        .filter((e) => typeof e?.case_no === 'string' && typeof e?.quote === 'string')
        .map((e) => ({ case_no: (e.case_no as string).trim(), quote: e.quote as string })),
    });
  }
  return out;
}

/**
 * 逐条校验一批候选。**纯函数式的判定入口，供测试直接打**——
 * 校验规则只写在这一处，generatePatterns 只是调用它。
 */
export function verifyCandidates(
  db: Database,
  dossierId: number,
  candidates: PatternCandidate[],
  docs: FullTextRow[],
): { kept: PatternCandidate[]; dropped: number; droppedEvidence: number } {
  const textByCase = new Map(docs.map((d) => [d.case_no, normalizeForQuote(d.summary)]));
  const kept: PatternCandidate[] = [];
  let dropped = 0;
  let droppedEvidence = 0;

  for (const c of candidates) {
    const good: PatternEvidence[] = [];
    for (const e of c.evidence) {
      // (a) 案号必须真在本档案库里 —— SQL 查，不查 prompt
      if (!caseNoExists(db, dossierId, e.case_no)) {
        droppedEvidence += 1;
        continue;
      }
      // (b) 引文必须是该案原文的逐字子串
      const hay = textByCase.get(e.case_no);
      const needle = normalizeForQuote(e.quote);
      if (!hay || !needle || hay.indexOf(needle) < 0) {
        droppedEvidence += 1;
        continue;
      }
      good.push(e);
    }
    if (good.length === 0) {
      dropped += 1;
      continue;
    }
    kept.push({ pattern: c.pattern, evidence: good });
  }
  return { kept, dropped, droppedEvidence };
}

/**
 * 跑一次套路归纳。**白名单为空时一次模型都不调**（块标 skipped）——
 * 没有全文却照样调一次，得到的只会是模型凭标题编的东西，且我们还要为它付钱。
 */
export async function generatePatterns(
  db: Database,
  dossierId: number,
  llm: PatternLlm,
): Promise<PatternsReport> {
  startBlock(db, dossierId, 'patterns');
  const docs = fullTextRows(db, dossierId);

  if (docs.length === 0) {
    finishBlock(db, dossierId, 'patterns', {
      status: 'skipped',
      note:
        '本档案暂无取到全文的判例，套路归纳未运行（未调用模型）。' +
        '归纳只依据全文，仅有案号的条目不作为输入——它们不足以支撑任何结论。',
    });
    return { kept: 0, dropped: 0, droppedEvidence: 0, skipped: true, fedDocs: 0 };
  }

  const material = docs.map((d) => `【案号】${d.case_no}\n【判决原文】${d.summary}`).join('\n\n');
  let raw: string;
  try {
    raw = await llm.chatJSON([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: material },
    ]);
  } catch (e) {
    finishBlock(db, dossierId, 'patterns', {
      status: 'failed',
      errorText: `调用归纳模型失败：${(e as Error).message}`,
    });
    throw e;
  }

  const { kept, dropped, droppedEvidence } = verifyCandidates(
    db,
    dossierId,
    parseCandidates(raw),
    docs,
  );

  // 重跑覆盖：company_patterns 只保留最近一次归纳的结果，
  // 否则同一条套路会随重跑越攒越多，看起来像「证据很多」。
  db.prepare('DELETE FROM company_patterns WHERE dossier_id = ?').run(dossierId);
  const ins = db.prepare(
    'INSERT INTO company_patterns (dossier_id, pattern, evidence_json, model) VALUES (?,?,?,?)',
  );
  for (const c of kept) {
    ins.run(dossierId, c.pattern, JSON.stringify(c.evidence), llm.billingModel ?? null);
  }
  bumpDroppedPatterns(db, dossierId, dropped);

  finishBlock(db, dossierId, 'patterns', {
    status: 'ok',
    note: `喂入全文 ${docs.length} 篇，落库 ${kept.length} 条，逐条校验丢弃 ${dropped} 条（证据不实 ${droppedEvidence} 条）`,
  });
  return { kept: kept.length, dropped, droppedEvidence, skipped: false, fedDocs: docs.length };
}

/** 已落库的一条套路（evidence_json 尚未解析，解析在呈现层做一次即可）。 */
export interface PatternRow {
  id: number;
  pattern: string;
  evidence_json: string;
  model: string | null;
  generated_at: string;
}

/**
 * 读某份档案已落库的全部套路。
 *
 * 【读侧不再判空 evidence】证据被清空的候选在落库前就整条丢掉了（见文件头第 3 条），
 * 所以这张表里没有「无证据的套路」这种行。呈现层仍有一道双保险，防的是别处写进来的脏行。
 */
export function listPatterns(db: Database, dossierId: number): PatternRow[] {
  return db
    .prepare(
      `SELECT id, pattern, evidence_json, model, generated_at
         FROM company_patterns WHERE dossier_id = ? ORDER BY id`,
    )
    .all(dossierId) as PatternRow[];
}
