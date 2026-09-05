// app/src/lib/docs/review.ts
// 来文解读（设计稿 §2 J：doc_submit）。公司发来的解除通知 / 协议 / 调岗通知，
// 逐条比对审查规则库，给出「签 / 不签 / 改签 / 待定」与逐条风险。
//
// ─────────────────────────── 三条不能松的口径 ───────────────────────────
// ① **报价在前，确认在后**。第一次调用只出一张免费报价（quoteService 只落一行、绝不动钱），
//    带着 quote_id 再调一次才扣费。跳过报价直接扣费的形态是：用户问了一句「这份能不能看看」，
//    钱已经没了——而回包看起来完全正常。扣费本身一律经 confirmService，本文件不碰 gongdaoSettle。
// ② **逐条机器校验，落库前不是落库后**。模型报的每一处风险都要满足两件事：
//    clause_ref 是原文的逐字片段（只做全半角/空白归一，不接受同义改写），
//    rule_id（若给）必须在本次真正喂进去的候选规则集里。任一条不过就丢掉这条发现，
//    并把丢弃条数如实回报——静默丢弃会把模型的编造率藏起来。
// ③ **severity 取规则库的常量，不取模型的说法**。坑有多大是规则定的；让模型自己报的形态是，
//    同一条「试用期超上限」这次 must、下次 suggest，而用户据此决定签不签。
// ───────────────────────────────────────────────────────────────────────
import type { Database } from 'better-sqlite3';

import {
  SERVICE_FEATURE,
  confirmService,
  quoteService,
  type PricedService,
} from '@/lib/billing/service-quotes';
import { gongdaoRefund } from '@/lib/billing';
import type { DomainFailure, Result } from '@/lib/cases';
import { writeOnce } from '@/lib/capabilities/shared';
import { readBytes, storeBytes } from '@/lib/evidence/files';
import { ocrImage } from '@/lib/evidence/sidecar-client';
import { nowSql } from '@/lib/db/time';
import type { ChatMessage } from '@/lib/llm';

import { getDoc, type DocDetail, type RiskFlag } from './read';
import { isDocKind, rulesFor, type DocKind, type ReviewRule } from './rules';

/** 落库的结论四态。模型给不出其中之一时一律落「待定」，不猜。 */
const ADVICE_VALUES = ['签', '不签', '改签', '待定'] as const;
type Advice = (typeof ADVICE_VALUES)[number];

/** 坑的三级 → 页面高亮的三档。两套词表的对应关系只在这一处。 */
const LEVEL_BY_SEVERITY: Record<string, RiskFlag['level']> = {
  must: '高',
  strong: '中',
  suggest: '低',
};

function fail(status: number, errorCode: string, message: string): DomainFailure {
  return { ok: false, status, errorCode, message };
}

// ───────────────────────────── 逐字校验 ─────────────────────────────

/**
 * 归一化并保留「归一后的第 i 个字符来自原文第几位」。
 *
 * 【为什么要带下标，不能只归一化比对】校验要的是「模型没有改写原文」，页面要的是
 * 「这段字能在原文里高亮出来」——只做归一化比对能满足前者，落库的却是模型交回来的那串
 * （可能全角变半角、空格被吃掉），页面 indexOf 找不到，于是校验通过的风险点一处都标不出来。
 */
function normalizeMapped(text: string): { norm: string; at: number[] } {
  let norm = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (/[\s　]/.test(ch)) continue;
    const code = ch.charCodeAt(0);
    norm += code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : ch;
    at.push(i);
  }
  return { norm, at };
}

/**
 * 在原文里定位一段引文，命中返回**原文里的那一段**（不是模型交回来的那串），落空返回 null。
 * 先试逐字，再试归一化——归一化只放宽全半角与空白，不放宽用词。
 */
export function locateQuote(text: string, quote: string): string | null {
  if (!quote) return null;
  if (text.includes(quote)) return quote;
  const hay = normalizeMapped(text);
  const needle = normalizeMapped(quote).norm;
  if (!needle) return null;
  const hit = hay.norm.indexOf(needle);
  if (hit < 0) return null;
  return text.slice(hay.at[hit], hay.at[hit + needle.length - 1] + 1);
}

// ───────────────────────────── 模型依赖面 ─────────────────────────────

/** 模型侧的最小依赖面。lib/llm 的 Provider（实现了 chatJSON 的那几家）天然满足它。 */
export interface DocReviewLlm {
  chatJSON(messages: ChatMessage[]): Promise<string>;
  /** 计费键，落进 contract_reviews.model，供事后追「这份解读是谁做的」 */
  readonly billingModel?: string;
}

/** 外部依赖：模型与 OCR。测试注入假件，生产用默认实现。 */
export interface DocReviewDeps {
  llm: DocReviewLlm;
  /** 图片/扫描件取文字。默认走 sidecar /ocr（app 侧解密后传明文字节）。 */
  ocr?: (bytes: Buffer, mime: string, filename: string) => Promise<{ text: string; model: string }>;
}

const SYSTEM_PROMPT =
  '你是公司来文的审查助手。只依据用户给出的文件原文作答，原文里没有的内容一个字都不要补。\n' +
  '用户会给你一份候选规则清单（每条有 id、标题、命中特征）。逐条判断这份文件有没有踩到，' +
  '踩到的就在 findings 里写一条并带上该条的 rule_id；规则清单之外你自己看出来的坑也可以写，' +
  '那种情况不要写 rule_id，改为自己给 severity（must 大坑必改 / strong 强烈建议改 / suggest 建议改）。\n' +
  '每条 findings 必须带 clause_ref：**原文中一字不差的连续片段**，不要转述、不要改标点。' +
  '找不到可逐字引用的原文就不要写那一条。\n' +
  '只输出 JSON：{"summary":"要点式说清这份文件写了什么、对用户意味着什么",' +
  '"advice":"签|不签|改签|待定","advice_detail":"为什么，以及要改就改哪几处",' +
  '"findings":[{"rule_id":"可选","clause_ref":"原文片段","issue":"这一处的问题",' +
  '"severity":"可选，只在没有 rule_id 时给","suggestion":"怎么改","negotiation_tip":"谈判怎么说"}]}';

interface RawFinding {
  rule_id?: unknown;
  clause_ref?: unknown;
  issue?: unknown;
  severity?: unknown;
  basis?: unknown;
  suggestion?: unknown;
  negotiation_tip?: unknown;
}

interface RawReview {
  summary?: unknown;
  advice?: unknown;
  advice_detail?: unknown;
  findings?: unknown;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 校验过的一条发现，字段已经与 review_findings 的列对齐。 */
export interface VerifiedFinding {
  clause_ref: string;
  severity: 'must' | 'strong' | 'suggest';
  issue: string;
  basis: string | null;
  suggestion: string | null;
  negotiation_tip: string | null;
  rule_id: string | null;
}

export interface VerifyReport {
  findings: VerifiedFinding[];
  /** 逐条校验丢掉的条数：引文对不上原文，或 rule_id 不在候选规则集里 */
  dropped: number;
}

/**
 * 逐条校验模型交回来的发现。**这一步是规则库真正起作用的地方**：
 * rule_id 必须落在本次喂进去的候选集里（不在 = 模型自己编了一个规则号，连同这条一起丢），
 * 命中规则的 severity / basis 一律取规则库的常量，模型说什么不算数。
 */
export function verifyFindings(
  raw: unknown,
  text: string,
  rules: ReadonlyMap<string, ReviewRule>,
): VerifyReport {
  const list = Array.isArray(raw) ? (raw as RawFinding[]) : [];
  const findings: VerifiedFinding[] = [];
  let dropped = 0;

  for (const item of list) {
    const quoteRaw = str(item.clause_ref);
    const quote = quoteRaw ? locateQuote(text, quoteRaw) : null;
    if (!quote) {
      dropped += 1;
      continue;
    }

    const ruleId = str(item.rule_id);
    const rule = ruleId ? rules.get(ruleId) : undefined;
    if (ruleId && !rule) {
      // 编出来的规则号：连同这条发现一起丢。留下它等于给一句话挂上一个查无此条的「依据」。
      dropped += 1;
      continue;
    }

    const llmSeverity = str(item.severity);
    const severity = rule
      ? rule.severity
      : llmSeverity === 'must' || llmSeverity === 'strong' || llmSeverity === 'suggest'
        ? llmSeverity
        : 'suggest';

    const issue = str(item.issue) ?? rule?.title;
    if (!issue) {
      dropped += 1;
      continue;
    }

    findings.push({
      clause_ref: quote,
      severity,
      issue,
      basis: rule ? rule.basis : str(item.basis),
      suggestion: str(item.suggestion) ?? rule?.suggestion ?? null,
      negotiation_tip: str(item.negotiation_tip) ?? rule?.negotiation_tip ?? null,
      rule_id: rule ? rule.id : null,
    });
  }

  return { findings, dropped };
}

// ───────────────────────────── 入参与出参 ─────────────────────────────

export interface SubmitDocInput {
  userId: number;
  caseId: number;
  keyId?: number | null;
  /** 二选一：已登记的证据，或直接粘进来的原文 */
  evidenceId?: number;
  text?: string;
  docKind: string;
  /** 不给 = 只报价不扣费；给了 = 按这张报价确认扣费并真的开始解读 */
  quoteId?: number;
  clientRef?: string;
}

/**
 * 报价回包的对外形态：字段名一律下划线，与 evidence_extract 的报价回包（ExtractionQuoteView）
 * 及 MCP 全部入参对齐。ServiceQuote 是仓内 camelCase 风格，转换在这一层做——
 * 直接把 ServiceQuote 抛出去会让 doc_submit 回 quoteId/expiresAt、与 evidence_extract 打架。
 */
export interface DocQuoteView {
  quote_id: number;
  amount: number;
  expires_at: string;
  units: number;
  unit_label: string;
  unit_price: number;
  price_key: string;
  label: string;
}

export interface DocQuoteResult {
  stage: 'quote';
  quote: DocQuoteView;
  /** 这次解读要不要先做一次文字识别（价钱已经含在这张报价里，不另收） */
  needs_ocr: boolean;
  next: string;
}

export interface DocReviewResult {
  stage: 'done';
  doc: DocDetail;
  /** 本次真扣走的公道值（券抵或重放为 0） */
  charged: number;
  /** true = 这张报价/这个 client_ref 之前已经解读过，本次没有重复解读也没有重复扣费 */
  deduped: boolean;
  /** 逐条校验丢掉的发现条数（引文对不上原文 / 规则号不存在） */
  dropped_findings: number;
  /** 本次比对了多少条审查规则 */
  rules_considered: number;
}

interface Source {
  fileId: number | null;
  mime: string | null;
  name: string;
  /** 已有的文本；null 表示要现做一次 OCR */
  text: string | null;
  evidenceId: number | null;
  pastedText: string | null;
}

/** 解析来源：证据（可能已有提取文本）或直接粘进来的原文。**不碰钱、不调外部**。 */
function resolveSource(db: Database, input: SubmitDocInput): Source | DomainFailure {
  const pasted = str(input.text);
  if (input.evidenceId === undefined && !pasted) {
    return fail(
      400,
      'DOC_SOURCE_REQUIRED',
      '没有可解读的来文：evidence_id 与 text 至少给一个。' +
        '为什么：解读的对象要么是已登记的证据（会自动取它的文本，没有就现做一次文字识别），' +
        '要么是直接粘进来的原文。怎么办：把文件先传进证据库拿到 evidence_id，或把原文粘在 text 里。',
    );
  }

  if (input.evidenceId !== undefined) {
    const row = db
      .prepare(
        `SELECT e.id AS id, e.file_id AS file_id, e.name AS name, e.extracted_text AS extracted_text,
                f.mime AS mime
           FROM evidence e JOIN files f ON f.id = e.file_id
          WHERE e.id = ? AND e.case_id = ? AND e.user_id = ?`,
      )
      .get(input.evidenceId, input.caseId, input.userId) as
      | { id: number; file_id: number; name: string; extracted_text: string | null; mime: string | null }
      | undefined;
    if (!row) {
      return fail(
        404,
        'EVIDENCE_NOT_FOUND',
        `证据 ${input.evidenceId} 不在这个案件下，或不属于本人（两者刻意不区分）。` +
          '怎么办：先用 evidence_list 取本案真实的证据编号。',
      );
    }
    return {
      fileId: row.file_id,
      mime: row.mime,
      name: row.name,
      text: str(row.extracted_text),
      evidenceId: row.id,
      pastedText: null,
    };
  }

  return { fileId: null, mime: 'text/plain', name: '粘贴的来文', text: pasted, evidenceId: null, pastedText: pasted };
}

/** 案件必须是本人的。不存在与不是你的同码同文案。 */
function assertOwnedCase(db: Database, caseId: number, userId: number): DomainFailure | null {
  const row = db.prepare('SELECT id FROM cases WHERE id=? AND user_id=?').get(caseId, userId);
  return row
    ? null
    : fail(404, 'CASE_NOT_FOUND', `案件 ${caseId} 不存在，或不属于本人（两者刻意不区分）。`);
}

/** 这次解读的幂等键：调用方给了就用它，没给就拿报价号当自然键（一张报价只解读一份文件）。 */
function refOf(input: SubmitDocInput, quoteId: number): string {
  return str(input.clientRef) ?? `quote-${quoteId}`;
}

function existingTarget(db: Database, caseId: number, clientRef: string): number | null {
  const row = db
    .prepare(
      "SELECT target_id FROM agent_writes WHERE case_id=? AND tool='doc_submit' AND client_ref=?",
    )
    .get(caseId, clientRef) as { target_id: number } | undefined;
  return row ? row.target_id : null;
}

// ───────────────────────────── 主流程 ─────────────────────────────

/**
 * 提交一份来文做解读。**两步**：
 *   不带 quote_id ⇒ 回一张免费报价（一个字都不扣）；
 *   带 quote_id  ⇒ 确认扣费，然后取文本 → 比对规则 → 调模型 → 逐条校验 → 落三张表。
 *
 * 【为什么校验、取源、载规则都排在扣费之前】案件不是你的、证据编号不存在、规则库读不出来，
 * 这些都该在钱动之前失败。排在扣费之后的形态是：扣了 20 公道值，然后回一句「证据不存在」。
 *
 * 【扣费之后失败怎么办】OCR 或模型这两步失败会**原路退款**（gongdaoRefund 按同一个幂等键退），
 * 并把失败原因如实回给调用方。不退的形态是：用户付了钱，什么都没拿到，而账面上是一笔正常消费。
 */
export async function submitDoc(
  db: Database,
  input: SubmitDocInput,
  deps: DocReviewDeps,
): Promise<Result<DocQuoteResult | DocReviewResult>> {
  const owned = assertOwnedCase(db, input.caseId, input.userId);
  if (owned) return owned;

  if (!isDocKind(input.docKind)) {
    return fail(
      400,
      'INVALID_DOC_KIND',
      `doc_kind 只能是 解除通知 / 协议 / 调岗通知 / 其他，收到 ${JSON.stringify(input.docKind)}。`,
    );
  }
  const docKind: DocKind = input.docKind;

  const source = resolveSource(db, input);
  if ('ok' in source) return source;

  // 规则库读不出来是配置故障，必须在扣费之前炸，而不是让用户买到一次「一条规则都没命中」。
  const ruleList = rulesFor(docKind);
  const rules = new Map(ruleList.map((r) => [r.id, r]));

  // ── 第一步：报价（不动钱）──
  if (input.quoteId === undefined) {
    const quoted = quoteService(db, {
      userId: input.userId,
      caseId: input.caseId,
      service: 'doc_review',
      payload: { units: 1, evidenceId: source.evidenceId ?? undefined },
    });
    if (!quoted.ok) return quoted;
    const q = quoted.quote;
    return {
      ok: true,
      stage: 'quote',
      quote: {
        quote_id: q.quoteId,
        amount: q.amount,
        expires_at: q.expiresAt,
        units: q.breakdown.units,
        unit_label: q.breakdown.unitLabel,
        unit_price: q.breakdown.unitPrice,
        price_key: q.breakdown.priceKey,
        label: q.breakdown.label,
      },
      needs_ocr: source.text === null,
      next:
        `带上 quote_id=${q.quoteId} 再调一次 doc_submit 才开始解读并扣费。` +
        '报价免费，不确认就一分钱都不扣；报价过期了重新报一次即可。',
    };
  }

  // ── 第二步：确认扣费 ──
  const clientRef = refOf(input, input.quoteId);
  const already = existingTarget(db, input.caseId, clientRef);
  if (already !== null) {
    // 这次调用之前已经解读过（同一张报价 / 同一个 client_ref）。**不再调模型、不再扣费**，
    // 直接把上次那份结果原样回去，并如实说明这是重放。
    const doc = getDoc(db, already, input.userId);
    if (doc) {
      return {
        ok: true,
        stage: 'done',
        doc,
        charged: 0,
        deduped: true,
        dropped_findings: 0,
        rules_considered: ruleList.length,
      };
    }
  }

  const confirmed = confirmService(db, input.userId, input.quoteId);
  if (!confirmed.ok) return confirmed;

  /**
   * 扣费之后的任何失败都走这里：原路退款，再把原因如实抛回去。
   *
   * 【为什么这个闭包必须紧跟 confirmService，中间一行判断都不许插】confirmService 一返回，
   * 钱就已经扣了。在它与本闭包之间写任何 `return fail(...)`，那条分支就是「扣了钱、什么都没给、
   * 也不退」——而回包看起来只是一条参数校验错误，用户照着错误提示重新报一次价，再付一次。
   * 退款的 feature 照**这次真扣的那张报价的服务**算（与 confirmService 记账时同一个表达式），
   * 不写死 'doc_review'：下面那条服务不符的分支扣的可能是一张文字识别的报价，
   * 写死的形态是账上「文件解读 -5」旁边挂一笔「来文解读 +5」，两笔功能名对不上、月账差一行。
   */
  const refundFeature =
    SERVICE_FEATURE[confirmed.service as PricedService] ?? confirmed.service;
  const refundAnd = (failure: DomainFailure): DomainFailure => {
    if (confirmed.charged > 0) {
      gongdaoRefund(input.userId, confirmed.charged, confirmed.orderRef, refundFeature, db);
    }
    return failure;
  };

  /**
   * 这张报价此前已经确认过，而上面按 client_ref 查旧结果那一步没查到东西。
   * 只有两种来路，两种都不能白发一份解读：
   *   ① 上次扣费之后失败、已原路退款——账上这张报价仍是「已确认」，重放 charged=0，
   *      再走下去就是「退了款还照样解读一次」，一张报价买两份；
   *   ② 换了个 client_ref 再确认——「一张报价只解读一份来文」这条自然键被绕开，
   *      同一张报价可以换着 ref 无限次解读不同的 text / doc_kind。
   * 合法的重放（同 client_ref、结果还在库里）在上面就返回旧结果了，走不到这里。
   */
  if (confirmed.deduped) {
    return refundAnd(
      fail(
        409,
        'QUOTE_ALREADY_USED',
        `报价 ${input.quoteId} 已经确认过了，不能再用来解读一份新的来文。` +
          '为什么：一张报价对应一份解读；上一次要么已经出结果（用同一个 client_ref 再调即可取回），' +
          '要么已失败并原路退款。' +
          '怎么办：不带 quote_id 调一次本工具重新取报价号，再带新的 quote_id 来确认。',
      ),
    );
  }

  // 报价的服务必须就是来文解读。不校验的形态是：拿一张 5 公道值的文字识别报价来确认，
  // 扣 5、解读照做——同一件事按两个价卖，而两条路径都不报错。
  if (confirmed.service !== 'doc_review') {
    return refundAnd(
      fail(
        400,
        'QUOTE_SERVICE_MISMATCH',
        `报价 ${input.quoteId} 是给「${confirmed.service}」报的，不能用来解读来文。` +
          '怎么办：本次费用已原路退回；不带 quote_id 调一次本工具重新取报价号。',
      ),
    );
  }

  if (confirmed.caseId !== input.caseId) {
    return refundAnd(
      fail(
        400,
        'QUOTE_CASE_MISMATCH',
        `报价 ${input.quoteId} 是给案件 ${confirmed.caseId} 报的，不能用来解读案件 ${input.caseId} 的文件。` +
          '怎么办：本次费用已原路退回；对这个案件重新报一次价，再带新的 quote_id 来确认。',
      ),
    );
  }

  // ── 取文本：已有提取文本直接用；没有就现做一次 OCR（价钱含在这张报价里）──
  let text = source.text;
  let ocrModel: string | null = null;
  if (text === null) {
    if (source.fileId === null) return refundAnd(fail(500, 'DOC_TEXT_MISSING', '没有可解读的文本。'));
    try {
      const bytes = readBytes(db, source.fileId);
      const run = deps.ocr ?? ((b, m, n) => ocrImage(b, m, n).then((r) => ({ text: r.text, model: r.model })));
      const out = await run(bytes, source.mime ?? 'image/jpeg', source.name);
      text = str(out.text);
      ocrModel = out.model;
    } catch (err) {
      return refundAnd(
        fail(
          502,
          'OCR_FAILED',
          `这份文件的文字识别没做成：${(err as Error).message}。` +
            '为什么：解读要先把图片里的字取出来，这一步依赖外部识别服务。' +
            '怎么办：本次费用已原路退回，稍后重新报价再试一次。',
        ),
      );
    }
    if (text === null) {
      return refundAnd(
        fail(
          422,
          'OCR_EMPTY',
          '这份文件识别不出任何文字（多半是空白页或整页糊掉）。' +
            '为什么：没有文字就没有可比对的条款，解读会是一份空结论。' +
            '怎么办：本次费用已原路退回，换一张更清楚的图或直接把原文粘在 text 里。',
        ),
      );
    }
    // 识别结果回写到证据上：下次再解读同一件证据不必重做一遍（也不该重收一次钱）。
    if (source.evidenceId !== null) {
      db.prepare(
        `UPDATE evidence
            SET extraction_status='done', extracted_text=?, extracted_meta_json=?, extracted_at=?
          WHERE id=?`,
      ).run(
        text,
        JSON.stringify({ mode: 'ocr', model: ocrModel, by: 'doc_review' }),
        nowSql(),
        source.evidenceId,
      );
    }
  }

  // ── 调模型 ──
  const material =
    `【文件种类】${docKind}\n【候选审查规则】\n` +
    ruleList
      .map((r) => `- ${r.id}｜${r.title}\n  命中特征：${r.pattern_hint}`)
      .join('\n') +
    `\n\n【文件原文】\n${text}`;
  let rawJson: string;
  try {
    rawJson = await deps.llm.chatJSON([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: material },
    ]);
  } catch (err) {
    return refundAnd(
      fail(
        502,
        'DOC_REVIEW_FAILED',
        `解读没做成：${(err as Error).message}。怎么办：本次费用已原路退回，稍后重新报价再试。`,
      ),
    );
  }

  let parsed: RawReview;
  try {
    parsed = JSON.parse(rawJson) as RawReview;
  } catch {
    return refundAnd(
      fail(
        502,
        'DOC_REVIEW_BAD_JSON',
        '解读模型这次没有交回可解析的结果。怎么办：本次费用已原路退回，重新报价再试一次。',
      ),
    );
  }

  const verified = verifyFindings(parsed.findings, text, rules);
  const adviceRaw = str(parsed.advice);
  const advice: Advice = (ADVICE_VALUES as readonly string[]).includes(adviceRaw ?? '')
    ? (adviceRaw as Advice)
    : '待定';
  const summary = str(parsed.summary);
  const adviceDetail = str(parsed.advice_detail);

  const flags: RiskFlag[] = verified.findings.map((f) => ({
    quote: f.clause_ref,
    level: LEVEL_BY_SEVERITY[f.severity],
    note: f.issue,
  }));

  // 粘进来的原文也落成一份文件：company_docs.file_id 是 NOT NULL，且「解读的是哪一份东西」
  // 事后必须取得回原件——只存一列文本的话，同一份文件传两次会被当成两件毫无关系的材料。
  const fileId =
    source.fileId ?? storeBytes(db, Buffer.from(source.pastedText ?? '', 'utf-8'), 'text/plain').fileId;

  // writeOnce 抛异常（数据库锁死、约束冲突、磁盘满）同样在扣费之后：
  // 不接住就是异常一路冒到 handler，钱扣了、库里一行没有、也没人退。
  let written:
    | { ok: true; docId: number; deduped: false }
    | { ok: true; deduped: true; id: number; note: string }
    | DomainFailure;
  try {
    written = writeOnce(
      db,
      { caseId: input.caseId, tool: 'doc_submit', clientRef, keyId: input.keyId },
      () => {
        const docId = Number(
          db
            .prepare(
              `INSERT INTO company_docs (case_id, file_id, ocr_text, doc_type, risk_flags_json, advice, advice_detail)
               VALUES (?,?,?,?,?,?,?)`,
            )
            .run(input.caseId, fileId, text, docKind, JSON.stringify(flags), advice, adviceDetail)
            .lastInsertRowid,
        );
        const reviewId = Number(
          db
            .prepare(
              `INSERT INTO contract_reviews (company_doc_id, case_id, contract_type, model, reviewed_at, summary)
               VALUES (?,?,?,?,?,?)`,
            )
            .run(docId, input.caseId, docKind, deps.llm.billingModel ?? null, nowSql(), summary)
            .lastInsertRowid,
        );
        const ins = db.prepare(
          `INSERT INTO review_findings (review_id, clause_ref, severity, issue, basis, suggestion, negotiation_tip, rule_id)
           VALUES (?,?,?,?,?,?,?,?)`,
        );
        for (const f of verified.findings) {
          ins.run(reviewId, f.clause_ref, f.severity, f.issue, f.basis, f.suggestion, f.negotiation_tip, f.rule_id);
        }
        return { ok: true as const, docId };
      },
      (r) => ({ table: 'company_docs', id: r.docId }),
    );
  } catch (err) {
    return refundAnd(
      fail(
        500,
        'DOC_WRITE_FAILED',
        `解读结果没能存下来：${(err as Error).message}。` +
          '怎么办：本次费用已原路退回，稍后重新报价再试一次。',
      ),
    );
  }
  // 落库失败同样在扣费之后：不退的话就是「钱扣了、库里一行没有、页面上什么都看不到」。
  if (written.ok !== true) return refundAnd(written);

  const docId = 'docId' in written ? written.docId : written.id;
  const doc = getDoc(db, docId, input.userId);
  if (!doc) return fail(500, 'DOC_READBACK_FAILED', `刚落库的解读 ${docId} 读不回来。`);

  return {
    ok: true,
    stage: 'done',
    doc,
    charged: confirmed.charged,
    deduped: written.deduped === true,
    dropped_findings: verified.dropped,
    rules_considered: ruleList.length,
  };
}
