// app/src/lib/knowledge/index.ts
// knowledge packs 加载与本地索引检索（spec §3.2；不引向量库，除非 ADR）。
// 数据源是仓库里的 knowledge/index.json + knowledge/packs/**/*.md，只读；
// 索引进程级缓存一次，正文按 id 懒加载。目录缺失、index 指向的文件缺失都直接抛错——
// 少给一张法条卡等于给劳动者错误答案，绝不静默返回空结果。
import fs from 'node:fs';
import path from 'node:path';

/** 结构化事实（规范 §2.1）：被代码消费的数据的唯一读取面——代码只读 facts，禁啃正文散文 */
export interface PackFacts {
  hotlines?: Array<{ name: string; phone: string; category: 'crisis' | 'legal' | 'union' | 'inspection'; status: 'usable' | 'forbidden'; hours?: string; dial_hint?: string; agent_note?: string }>;
  values?: Array<{ key: string; value: number; unit: string; effective_from: string; confidence: string; source_idx: number }>;
  statute_quotes?: Array<{ law: string; article: string; text: string }>;
  case_facts?: { case_no?: string; court?: string; judged_at?: string; gist?: string; issue?: string; holding?: string; reasoning?: string };
  addresses?: Array<{ name: string; scene: Array<'仲裁立案' | '一审起诉' | '二审上诉' | '执行申请'>; address: string; phone?: string; status: 'usable' | 'unverified'; hours?: string; agent_note?: string; source?: string; confidence?: string }>;
  review_rules?: Array<{ id: string; severity: 'must' | 'strong' | 'suggest'; title: string; pattern_hint: string; basis: string; suggestion: string; negotiation_tip?: string }>;
}

/** index.json 里一条卡的元数据，字段与文件内 frontmatter 同名同义（ADR-002：updated 保持 YYYY-MM-DD 字符串，不转 Date） */
export interface PackMeta {
  id: string;
  type: string;
  title: string;
  keywords: string[];
  applies_to: string[];
  region: string;
  confidence: string;
  updated: string;
  path: string;
  /** 规范化法条引用（如 劳动合同法§47）；仅 frontmatter 声明了 law_refs 的卡带此字段 */
  law_refs?: string[];
  /** 仅带结构化事实的卡存在；gen-knowledge-index.py 已做两面一致性校验 */
  facts?: PackFacts;
}

/** 检索结果：元数据 + 剥掉 frontmatter 的正文 markdown */
export interface PackHit extends PackMeta {
  score: number;
  content: string;
}

export interface SearchOptions {
  applies_to?: string;
  type?: string;
  region?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 5;
/** 长度 1 的 keyword（如「N」）与任何 query 都能互为子串，噪音太大，不参与打分 */
const MIN_KEYWORD_LEN = 2;
const SCORE_KEYWORD = 3;
const SCORE_APPLIES_TO = 2;
const SCORE_TITLE_MAX = 2;
/** region 过滤时永远保留的全国性卡（司解、法条），北京用户同样适用 */
const REGION_NATIONWIDE = '全国';

let knowledgeDir: string | null = null;
let packIndex: PackMeta[] | null = null;
const contentCache = new Map<string, string>();

function resolveKnowledgeDir(): string {
  if (knowledgeDir) return knowledgeDir;
  // 缺省相对 cwd 上跳一层：Next dev/build 与 vitest 的 cwd 都是 app/
  const dir = process.env.LAWER_KNOWLEDGE_DIR ?? path.resolve(process.cwd(), '..', 'knowledge');
  if (!fs.existsSync(dir)) {
    throw new Error(`knowledge 目录不存在：${dir}（cwd=${process.cwd()}）；用 env LAWER_KNOWLEDGE_DIR 指向 knowledge/ 目录可覆盖`);
  }
  knowledgeDir = dir;
  return dir;
}

function loadIndex(): PackMeta[] {
  if (packIndex) return packIndex;
  const dir = resolveKnowledgeDir();
  const indexPath = path.join(dir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`knowledge 索引不存在：${indexPath}；用 env LAWER_KNOWLEDGE_DIR 指向含 index.json 的目录可覆盖`);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`knowledge 索引格式错误：${indexPath} 顶层应为数组`);
  }
  for (const entry of parsed as PackMeta[]) {
    if (!entry?.id || !entry?.path) {
      throw new Error(`knowledge 索引条目缺少 id 或 path：${JSON.stringify(entry)}（${indexPath}）`);
    }
  }
  packIndex = parsed as PackMeta[];
  return packIndex;
}

/**
 * 读取正文并剥掉 frontmatter。frontmatter 是 packs 的硬约定（test 会全量校验其 id 与索引一致），
 * 缺失说明这份卡没按规范写，属于数据问题，抛错而不是把 YAML 当正文喂给模型。
 */
function loadContent(meta: PackMeta): string {
  const cached = contentCache.get(meta.id);
  if (cached !== undefined) return cached;
  const abs = path.join(resolveKnowledgeDir(), meta.path);
  if (!fs.existsSync(abs)) {
    throw new Error(`knowledge 索引指向的文件不存在：${meta.id} → ${abs}；index.json 与 packs/ 不一致，需修数据`);
  }
  const raw = fs.readFileSync(abs, 'utf-8');
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw);
  if (!match) {
    throw new Error(`knowledge pack 缺少 frontmatter：${meta.id} → ${abs}`);
  }
  const content = raw.slice(match[0].length);
  contentCache.set(meta.id, content);
  return content;
}

/** 字符二元组集合：中文没有空格分词，二元组是不引依赖又能反映词序的最简近似 */
function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < text.length; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

/** 互为子串即算命中：既让「调岗」命中 keyword「调岗降薪」，也让「经济补偿金个税」命中 keyword「经济补偿」 */
function matches(term: string, query: string): boolean {
  return term.length >= MIN_KEYWORD_LEN && (query.includes(term) || term.includes(query));
}

function scoreOf(meta: PackMeta, query: string, queryBigrams: Set<string>): number {
  let score = 0;
  for (const kw of meta.keywords) if (matches(kw, query)) score += SCORE_KEYWORD;
  for (const scene of meta.applies_to) if (matches(scene, query)) score += SCORE_APPLIES_TO;
  if (queryBigrams.size > 0) {
    const title = bigrams(meta.title);
    let overlap = 0;
    for (const gram of queryBigrams) if (title.has(gram)) overlap += 1;
    score += (overlap / queryBigrams.size) * SCORE_TITLE_MAX;
  }
  return score;
}

function passesFilters(meta: PackMeta, opts: SearchOptions): boolean {
  if (opts.type && meta.type !== opts.type) return false;
  if (opts.applies_to && !meta.applies_to.includes(opts.applies_to)) return false;
  if (opts.region && meta.region !== opts.region && meta.region !== REGION_NATIONWIDE) return false;
  return true;
}

/**
 * 同分时的类型优先序（依据优先）：agent 的重要结论必须引法条/算法依据（charter §3），
 * 所以法条卡、计算规则先于案例与话术出现；判例是佐证不是依据，排最后。
 */
const TYPE_TIEBREAK = ['法条卡', '计算规则', '数据卡', '审查规则', '流程SOP', '文书模板', '话术卡', '判例卡', '情绪指南'];

function typeRank(type: string): number {
  const i = TYPE_TIEBREAK.indexOf(type);
  return i < 0 ? TYPE_TIEBREAK.length : i;
}

/**
 * 本地关键词检索。打分确定性、无分词依赖：keyword 命中 +3、applies_to 命中 +2、
 * 标题二元组重合率 ×2。score 为 0 的不返回（宁可空手也不给不相关的法条），
 * 同分先按类型优先序（依据优先）再按 id 字典序，保证同一 query 每次输出一致。
 */
export function search(query: string, opts: SearchOptions = {}): PackHit[] {
  const q = query.trim();
  if (!q) {
    throw new Error('knowledge.search 的 query 不能为空：调用方需先确认用户诉求关键词');
  }
  const queryBigrams = bigrams(q);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  return loadIndex()
    .filter((meta) => passesFilters(meta, opts))
    .map((meta) => ({ meta, score: scoreOf(meta, q, queryBigrams) }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        typeRank(a.meta.type) - typeRank(b.meta.type) ||
        a.meta.id.localeCompare(b.meta.id),
    )
    .slice(0, limit)
    .map((row) => ({ ...row.meta, score: row.score, content: loadContent(row.meta) }));
}

/** 按 id 取整张卡（含正文）。score 恒为 0：没有 query 就没有相关度可言，不是「不相关」。 */
export function get(id: string): PackHit {
  const meta = loadIndex().find((m) => m.id === id);
  if (!meta) {
    throw new Error(`knowledge pack 不存在：${id}；可用 id 见 knowledge/index.json`);
  }
  return { ...meta, score: 0, content: loadContent(meta) };
}

/** 全量元数据（不含正文），供管理端与调试。返回副本，调用方改不到进程级缓存。 */
export function listPacks(): PackMeta[] {
  return loadIndex().map((meta) => ({ ...meta }));
}

/** 仅供测试：清掉进程级缓存，让改 env LAWER_KNOWLEDGE_DIR 后的调用重新解析目录 */
export function __resetForTest(): void {
  knowledgeDir = null;
  packIndex = null;
  contentCache.clear();
}
