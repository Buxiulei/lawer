// app/src/lib/evidence/brief.ts
// 证据简报：一件材料「能拿来做什么」的结构化答案（设计稿 §2 B evidence_brief_get/update）。
//
// 【为什么每件证据都要有一份】提取出来的文本可能有几千字，后续的 agent 不会每次都读一遍；
// 它读到的多半只是文件名。主理人 09-05 的原话是「存证后每件证据都要有简报，让后续 agent
// 知道它能用来做什么」——所以简报不是摘要，是**用途判断**：能证明什么、关键事实、
// 与诉求的关系、弱点、还缺什么。
//
// 【schema 固定、且落库前逐字段校验】模型返回的 JSON 少一个键、把 key_facts 写成字符串，
// 都是"看起来成功了"的失败：写进库以后读侧渲染成空白，没人知道这件证据其实没有简报。
// validateBrief 是唯一入口，校验不过一律不落库（generateBrief 记失败、brief_update 回 400）。
//
// 【引文只从材料里来】key_facts.quote 与 citations 是给用户拿去开庭用的，编一句原话的代价
// 由用户承担。所以 prompt 里写死「引不到原文就把 quote 留空」，落库前再机器核一遍：
// 有提取文本时，非空 quote 必须是提取文本的逐字子串（归一化只做全半角与空白），
// 对不上就把那句 quote 抹成空串而不是丢掉整条事实——事实可能是真的，编的是那句引号里的话。
import type { Database } from 'better-sqlite3';

import type { ChatMessage } from '@/lib/llm';

/** 简报的一条关键事实。五个字段都是字符串，取不到就是空串——**不许缺键**（读侧要按位渲染）。 */
export interface BriefFact {
  /** 什么时候（材料里写的时间，不是入库时间） */
  when: string;
  /** 谁（说话人、落款人、抬头） */
  who: string;
  /** 发生了什么 */
  what: string;
  /** 逐字原话；引不到就留空串 */
  quote: string;
  /** 这条事实在材料里的位置（页码、时间点、帧） */
  where: string;
}

/** 固定 schema。字段名对外原样暴露（MCP 回包与 REST 同形），改名等于换接口。 */
export interface EvidenceBrief {
  /** 这件材料能证明什么 */
  proves: string;
  key_facts: BriefFact[];
  /** 与诉求的关系（支持哪一项、削弱哪一项） */
  relation_to_claims: string;
  /** 弱点：为什么对方可能不认 */
  weaknesses: string[];
  /** 补强建议：还该拿到什么 */
  suggested_followups: string[];
  /** 引用位置（页码 / 时间点 / 帧号），供人回到原件核对 */
  citations: string[];
}

const FACT_KEYS = ['when', 'who', 'what', 'quote', 'where'] as const;
const BRIEF_KEYS = [
  'proves',
  'key_facts',
  'relation_to_claims',
  'weaknesses',
  'suggested_followups',
  'citations',
] as const;

/** 一条关键事实最多几条、一份简报里字段各自的上限。防的是模型把整篇文本倒进简报里。 */
export const MAX_FACTS = 12;
export const MAX_LIST_ITEMS = 8;
const MAX_TEXT = 600;
const MAX_ITEM = 200;

export interface BriefValidation {
  ok: boolean;
  /** 校验通过时的规范化结果（多余键已丢、超长已截、类型已收敛） */
  brief?: EvidenceBrief;
  /** 校验不过的原因，逐条列出——只说"格式不对"没法改 */
  problems: string[];
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function strList(v: unknown, problems: string[], field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    problems.push(`${field} 必须是字符串数组，收到 ${typeof v}`);
    return [];
  }
  return v
    .map((x) => str(x, MAX_ITEM))
    .filter((x) => x !== '')
    .slice(0, MAX_LIST_ITEMS);
}

/**
 * 校验并规范化一份简报。**这是落库的唯一入口**（generateBrief 与 brief_update 都过它）。
 *
 * 只有一条硬性必填：proves。其余可以为空——一份"这件材料只能证明劳动关系存在、
 * 没有别的关键事实"的简报是合法的；而一份连"能证明什么"都答不出的简报没有存在意义，
 * 落进库里只会让读侧显示一个空壳，看起来像有简报。
 */
export function validateBrief(input: unknown): BriefValidation {
  const problems: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, problems: ['简报必须是一个对象（JSON object）'] };
  }
  const raw = input as Record<string, unknown>;

  const unknown = Object.keys(raw).filter((k) => !(BRIEF_KEYS as readonly string[]).includes(k));
  if (unknown.length) {
    // 多余键不当错误、直接丢：模型多写一个 "summary" 不该让整份简报作废，
    // 但也不能落库——留着它，下一个读侧的人会以为那是 schema 的一部分。
    problems.push(`已忽略 schema 外的字段：${unknown.join(' / ')}`);
  }

  const proves = str(raw.proves, MAX_TEXT);
  if (!proves) problems.push('proves（这件材料能证明什么）不能为空');

  const facts: BriefFact[] = [];
  if (raw.key_facts !== undefined && raw.key_facts !== null) {
    if (!Array.isArray(raw.key_facts)) {
      problems.push(`key_facts 必须是数组，收到 ${typeof raw.key_facts}`);
    } else {
      for (const [i, f] of raw.key_facts.slice(0, MAX_FACTS).entries()) {
        if (!f || typeof f !== 'object' || Array.isArray(f)) {
          problems.push(`key_facts[${i}] 必须是对象，含 ${FACT_KEYS.join(' / ')} 五个字符串字段`);
          continue;
        }
        const o = f as Record<string, unknown>;
        const fact: BriefFact = {
          when: str(o.when, MAX_ITEM),
          who: str(o.who, MAX_ITEM),
          what: str(o.what, MAX_ITEM),
          quote: str(o.quote, MAX_ITEM),
          where: str(o.where, MAX_ITEM),
        };
        // 五个字段全空的一条 = 模型凑数用的空壳，落库只会让"关键事实 5 条"这个数字骗人
        if (FACT_KEYS.every((k) => fact[k] === '')) continue;
        facts.push(fact);
      }
    }
  }

  const brief: EvidenceBrief = {
    proves,
    key_facts: facts,
    relation_to_claims: str(raw.relation_to_claims, MAX_TEXT),
    weaknesses: strList(raw.weaknesses, problems, 'weaknesses'),
    suggested_followups: strList(raw.suggested_followups, problems, 'suggested_followups'),
    citations: strList(raw.citations, problems, 'citations'),
  };

  // 「已忽略多余字段」不算失败；真正的失败是缺 proves 或类型不对
  const fatal = problems.filter((p) => !p.startsWith('已忽略'));
  return fatal.length ? { ok: false, problems } : { ok: true, brief, problems };
}

/** 只做全半角与空白归一（与 company/patterns.ts 同口径）：**不做同义改写**。 */
export function normalizeForQuote(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]+/g, '');
}

/**
 * 把对不上原文的 quote 抹成空串，返回抹掉的条数。
 * **抹 quote 不丢事实**：模型可能把时间地点归纳对了，只是那句带引号的话是它自己组织的语言。
 * 没有提取文本时（出证免费简报那条路）不做这道校验——没有靶子，校验只会全军覆没。
 */
export function stripUnverifiedQuotes(
  brief: EvidenceBrief,
  extractedText: string | null,
): { brief: EvidenceBrief; stripped: number } {
  if (!extractedText) return { brief, stripped: 0 };
  const hay = normalizeForQuote(extractedText);
  let stripped = 0;
  const key_facts = brief.key_facts.map((f) => {
    if (!f.quote) return f;
    const needle = normalizeForQuote(f.quote);
    if (needle && hay.includes(needle)) return f;
    stripped += 1;
    return { ...f, quote: '' };
  });
  return { brief: { ...brief, key_facts }, stripped };
}

/** 事实卡与列表里那一句摘要。默认 60 字（事实卡预算按这个数算）。 */
export const BRIEF_SUMMARY_MAX = 60;

export function briefSummary(brief: EvidenceBrief | null, max = BRIEF_SUMMARY_MAX): string {
  if (!brief) return '';
  const s = brief.proves.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 从一行 evidence 上把 brief_json 解出来。解不动回 null（脏行不该让读侧崩）。 */
export function parseBrief(json: string | null | undefined): EvidenceBrief | null {
  if (!json) return null;
  try {
    const v = validateBrief(JSON.parse(json));
    return v.ok ? v.brief! : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── 落库（乐观锁） ─────────────────────────────

/** 简报是谁写的。web = 网页上的人；agent:<key_id> = 用户自己的 agent；system = 服务端自动生成。 */
export type BriefAuthor = string;

export interface SaveBriefResult {
  ok: boolean;
  /** 冲突时是库里当前的版本号，成功时是写入后的新版本号 */
  version: number;
  conflict?: boolean;
}

/**
 * 写一份简报，版本号 +1。`baseVersion` 是乐观锁：传的必须是**你读到的那一版**。
 *
 * 【为什么必须有锁】两个 agent 同时改同一件证据的简报，后写的会把先写的整份盖掉，
 * 而两边都收到"成功"。带上 base_version 之后，第二个会拿到 409 与库里的当前版本，
 * 它能重新读一遍再改——冲突从"静默丢失"变成"看得见的一次失败"。
 *
 * baseVersion 传 undefined = 不加锁（服务端自动生成走这条：它是在没人编辑的时候跑的）。
 */
export function saveBrief(
  db: Database,
  input: {
    evidenceId: number;
    brief: EvidenceBrief;
    updatedBy: BriefAuthor;
    baseVersion?: number;
  },
): SaveBriefResult {
  const row = db
    .prepare('SELECT brief_version AS v FROM evidence WHERE id=?')
    .get(input.evidenceId) as { v: number } | undefined;
  if (!row) return { ok: false, version: 0 };

  if (input.baseVersion !== undefined && input.baseVersion !== row.v) {
    return { ok: false, version: row.v, conflict: true };
  }

  const next = row.v + 1;
  const res = db
    .prepare(
      `UPDATE evidence
          SET brief_json=?, brief_version=?, brief_updated_by=?
        WHERE id=? AND brief_version=?`,
    )
    .run(JSON.stringify(input.brief), next, input.updatedBy, input.evidenceId, row.v);
  // changes=0 = 读到版本号与真正更新之间有人抢先写了一版（同一进程内的并发请求）。
  // 不重试、不覆盖：回冲突，让调用方重读。
  if (res.changes === 0) {
    const now = db.prepare('SELECT brief_version AS v FROM evidence WHERE id=?').get(input.evidenceId) as
      | { v: number }
      | undefined;
    return { ok: false, version: now?.v ?? row.v, conflict: true };
  }
  return { ok: true, version: next };
}

// ───────────────────────────── 生成 ─────────────────────────────

/** 模型侧最小依赖面（同 company/patterns.ts：lib/llm 的 Provider 天然满足）。 */
export interface BriefLlm {
  chatJSON(messages: ChatMessage[]): Promise<string>;
  readonly billingModel?: string;
}

const SYSTEM_PROMPT =
  '你是证据分析助手。依据用户给出的一份材料（元数据 + 可能有的提取文本），判断它在争议处理中能派什么用场。' +
  '只依据材料本身，材料里没有的信息一律留空，不要推测、不要补全。' +
  '关键事实里的 quote 必须是提取文本中一字不差的连续片段；引不到就把 quote 留空字符串。' +
  '没有提取文本时，只依据文件名、分类、证明目的与载体作判断，并在 weaknesses 里写明「内容尚未提取，以下判断只依据登记信息」。' +
  '只输出 JSON，形如：' +
  '{"proves":"…","key_facts":[{"when":"","who":"","what":"","quote":"","where":""}],' +
  '"relation_to_claims":"…","weaknesses":["…"],"suggested_followups":["…"],"citations":["…"]}';

/** 喂给模型的材料。文本超这个长度就截断并注明——一份两小时的转写稿会把上下文吃光。 */
const MATERIAL_TEXT_MAX = 12_000;

export interface BriefMaterial {
  name: string;
  category: string;
  provePurpose: string | null;
  originalMedium: string | null;
  mime: string | null;
  status: string;
  extractionStatus: string;
  extractedText: string | null;
  extractedMeta: Record<string, unknown> | null;
}

export function buildMaterialPrompt(m: BriefMaterial): string {
  const lines = [
    `【文件名】${m.name}`,
    `【分类】${m.category}`,
    `【用户填写的证明目的】${m.provePurpose ?? '未填写'}`,
    `【原始载体】${m.originalMedium ?? '未填写'}`,
    `【文件类型】${m.mime ?? '未知'}`,
    `【固化状态】${m.status}`,
  ];
  if (m.extractedMeta) lines.push(`【提取附注】${JSON.stringify(m.extractedMeta)}`);
  if (m.extractedText) {
    const t = m.extractedText;
    lines.push(
      `【提取文本】${t.length > MATERIAL_TEXT_MAX ? `${t.slice(0, MATERIAL_TEXT_MAX)}\n（后续 ${t.length - MATERIAL_TEXT_MAX} 字未喂入）` : t}`,
    );
  } else {
    lines.push('【提取文本】无（这份材料的内容尚未提取）');
  }
  return lines.join('\n');
}

export interface GenerateBriefResult {
  ok: boolean;
  brief?: EvidenceBrief;
  version?: number;
  /** 被机器核掉的引文条数（模型编的原话）。0 以上就说明这一轮有编造，值得看一眼。 */
  strippedQuotes?: number;
  /** 失败原因（模型没连上 / JSON 解不动 / schema 不过）。 */
  error?: string;
}

interface EvidenceBriefRow {
  id: number;
  name: string;
  category: string;
  prove_purpose: string | null;
  original_medium: string | null;
  status: string;
  extraction_status: string;
  extracted_text: string | null;
  extracted_meta_json: string | null;
  mime: string | null;
}

export function readBriefMaterial(db: Database, evidenceId: number): BriefMaterial | null {
  const row = db
    .prepare(
      `SELECT e.id, e.name, e.category, e.prove_purpose, e.original_medium, e.status,
              e.extraction_status, e.extracted_text, e.extracted_meta_json, f.mime
         FROM evidence e JOIN files f ON f.id = e.file_id
        WHERE e.id = ?`,
    )
    .get(evidenceId) as EvidenceBriefRow | undefined;
  if (!row) return null;
  let meta: Record<string, unknown> | null = null;
  if (row.extracted_meta_json) {
    try {
      meta = JSON.parse(row.extracted_meta_json) as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  return {
    name: row.name,
    category: row.category,
    provePurpose: row.prove_purpose,
    originalMedium: row.original_medium,
    mime: row.mime,
    status: row.status,
    extractionStatus: row.extraction_status,
    extractedText: row.extracted_text,
    extractedMeta: meta,
  };
}

/** 剥掉模型可能加的 ```json 围栏。chatJSON 各家实现已剥过一层，这里是兜底。 */
function stripFence(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith('```')) return t;
  return t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
}

/**
 * 生成并落库一份简报。**不抛错**：简报生成失败不该把提取任务判成失败——
 * 文本已经提取出来了，那才是用户花钱买的东西。失败以 ok:false + error 返回，由调用方记一笔。
 */
export async function generateBrief(
  db: Database,
  evidenceId: number,
  llm: BriefLlm,
  updatedBy: BriefAuthor = 'system',
): Promise<GenerateBriefResult> {
  const material = readBriefMaterial(db, evidenceId);
  if (!material) {
    return {
      ok: false,
      error:
        `找不到要写简报的材料（evidence_id=${evidenceId}）。` +
        '为什么：这条材料在排队期间被删了，或它指向的文件登记行不在了。' +
        '怎么办：材料还在的话重新发起一次提取；不在就不必处理。',
    };
  }

  let raw: string;
  try {
    raw = await llm.chatJSON([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildMaterialPrompt(material) },
    ]);
  } catch (e) {
    return { ok: false, error: `调用简报模型失败：${(e as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return { ok: false, error: `简报模型返回的不是 JSON（前 200 字）：${raw.slice(0, 200)}` };
  }

  const check = validateBrief(parsed);
  if (!check.ok) {
    return { ok: false, error: `简报不合 schema：${check.problems.join('；')}` };
  }

  const { brief, stripped } = stripUnverifiedQuotes(check.brief!, material.extractedText);
  const saved = saveBrief(db, { evidenceId, brief, updatedBy });
  if (!saved.ok) {
    return { ok: false, error: '简报落库失败：这件材料在写入前被改动或删除了，请重读后重试' };
  }
  return { ok: true, brief, version: saved.version, strippedQuotes: stripped };
}
