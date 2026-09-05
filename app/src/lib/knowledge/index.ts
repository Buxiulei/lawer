// app/src/lib/knowledge/index.ts
// knowledge packs 加载与本地索引检索（spec §3.2；不引向量库，除非 ADR）。
// 数据源是仓库里的 knowledge/index.json + knowledge/packs/**/*.md，只读；
// 索引进程级缓存一次，正文按 id 懒加载。目录缺失、index 指向的文件缺失都直接抛错——
// 少给一张法条卡等于给劳动者错误答案，绝不静默返回空结果。
import fs from 'node:fs';
import path from 'node:path';

import { typeRank } from './types';

/**
 * 结构化事实（规范 §2.1）：被代码消费的数据的唯一读取面——代码只读 facts，禁啃正文散文。
 *
 * 【通用设计纪律（manager 原文，2026-08-21）】
 * > 卡片里任何供代码消费的分类维度，一律设计成**可多值（数组）且语义正交**；
 * > **严禁用 name/title 等展示字段做判断依据**；
 * > 新增消费点前先问：这个判断依据是**结构化字段**还是**我在猜**？
 *
 * 三句话各有出处，都是踩过的坑：
 * - **可多值**：一条坐标可能同时服务多个场景，单值枚举一到第二个场景就要么改 schema、
 *   要么复制一条卡；复制出来的那条迟早只更新其中一份。
 * - **语义正交**：一个维度混进两件事（既表"哪个场景用"又表"核没核实"），
 *   过滤时必然要写复合条件，而复合条件在下一个消费点会被抄错。
 * - **禁用展示字段**：`name` 是给人读的，随时会被润色。按 `name.includes('法院')` 分流的代码，
 *   在有人把机构名改成全称的那天静默走错分支，且不会有任何报错。
 *   判断一律钉在受控枚举字段上（如 `status`、场景枚举）。
 */
export interface PackFacts {
  hotlines?: Array<{ name: string; phone: string; category: 'crisis' | 'legal' | 'union' | 'inspection'; status: 'usable' | 'forbidden'; hours?: string; dial_hint?: string; agent_note?: string }>;
  values?: Array<{ key: string; value: number; unit: string; effective_from: string; confidence: string; source_idx: number }>;
  statute_quotes?: Array<{ law: string; article: string; text: string }>;
  case_facts?: { case_no?: string; court?: string; judged_at?: string; gist?: string; issue?: string; holding?: string; reasoning?: string };
  addresses?: Array<{ name: string; scene: Array<'仲裁立案' | '一审起诉' | '二审上诉' | '执行申请'>; address: string; phone?: string; status: 'usable' | 'unverified'; hours?: string; agent_note?: string; source?: string; confidence?: string }>;
  review_rules?: Array<{ id: string; severity: 'must' | 'strong' | 'suggest'; title: string; pattern_hint: string; basis: string; suggestion: string; negotiation_tip?: string }>;
  /**
   * 【⭐核心条的 S3 档】场景 → 核心依据条的**声明式**映射（见 method-core-article-map 卡）。
   * 键取自已有结构化字段（`cases.stage` / `claims.kind`），`articles` 是 `法名|条号` 归一键。
   * 它给的是**优先权**（优先占用⭐的 3 条上限），不是追加配额。
   */
  core_article_map?: Array<{ scene: string; claim_kind?: string; articles: string[] }>;
}

/** index.json 里一条卡的元数据，字段与文件内 frontmatter 同名同义（ADR-002：updated 保持 YYYY-MM-DD 字符串，不转 Date） */
export interface PackMeta {
  id: string;
  type: string;
  title: string;
  keywords: string[];
  applies_to: string[];
  region: string;
  /**
   * 出处（官方 URL / 本地存档副本路径）。frontmatter 里是必填项，
   * 但早先没有随 index.json 导出，于是消费方（VenueCard.sources）拿到的恒是空数组——
   * 一张说不出出处的「官方流程」卡与一段我们自己编的话，在用户那里长得一模一样。
   */
  sources: string[];
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
  /**
   * 判例的审理机构。匹配的是**结构化字段** `facts.case_facts.court`，给的是子串
   *（「朝阳」能匹到「北京市朝阳区人民法院」——用户不会记全称）。
   *
   * 【为什么不去 title 或正文里找法院名】title 是给人读的展示字段，随时会被润色；
   * 按展示字段分流的代码在有人把「朝阳法院」改成全称的那天静默走错分支，且不报错
   *（规范 §2.1 的三条纪律之一，见 PackFacts 头注释）。
   * 【为什么带 court 时不带 case_facts 的卡一律滤掉】问「某某法院怎么判的」就是只要判例；
   * 把没有审理机构的卡也放行，等于用一个过滤条件换回一批与该法院无关的卡。
   */
  court?: string;
}

const DEFAULT_LIMIT = 5;

// ─────────────────── 指标语义常量（改动须 manager 同级审批）───────────────────
//
// 【为什么这几个常量被圈起来单独说明】`MIN_KEYWORD_LEN`、`matches()` 的子串规则、
// 以及 `SUBSTANTIVE_MIN_SCORE`，共同构成 **`substantiveHitCount` 这个指标的语义**。
// 而该指标同时是「空手感知」的触发判据与「空包率」这项运营指标的分母口径
// （空包率 = 召回质量的直接度量，单日 >40% 报 manager）。
//
// 因此：**改这几个数不是调优，是改指标定义**——历史数据会因此不可比，
// 昨天的 30% 与今天的 30% 不再是同一件事。改动须 manager 同级审批并说明对历史数据的影响。
// 规矩写在它保护的东西旁边，而不是写在别处的文档里——写在别处的规矩，改代码的人看不见。
//
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
    // sources 是**后加**的导出字段：旧版生成器产出的 index.json 里没有它，
    // 而类型上它是 string[]，消费方会直接 `.length` ⇒ 运行时 TypeError，
    // 报错点离病因（索引是旧的）隔着好几层。在入口处一次说清缺什么/为什么缺/怎么办。
    if (!Array.isArray(entry.sources)) {
      throw new Error(
        `knowledge 索引条目 ${entry.id} 缺 sources（${indexPath}）：` +
          '这份 index.json 多半是旧版 scripts/gen-knowledge-index.py 生成的（那一版没导出 sources）。' +
          '重跑 `python3 scripts/gen-knowledge-index.py` 再生成即可。',
      );
    }
  }
  // ⑤【零张卡默认拒绝启动】manager 2026-08-29 产品裁定：
  // **一个没有任何知识、却照常回答法律问题的 agent，是本产品最不可接受的静默故障形态**——
  // 比宕机糟：宕机用户知道坏了。一次把 packs/ 弄丢的部署，此前会静默上线这样一个 agent。
  // 本地想空跑是正当需求，但必须**明说**：KNOWLEDGE_ALLOW_EMPTY=1。默认关。
  if (parsed.length === 0 && process.env.KNOWLEDGE_ALLOW_EMPTY !== '1') {
    throw new Error(
      `knowledge 索引是空的：${indexPath}（0 张卡）。` +
        '一个没有知识却照常作答的 agent 比宕机更坏，故默认拒绝启动；' +
        '本地确需空库请显式设 KNOWLEDGE_ALLOW_EMPTY=1',
    );
  }

  // ⑥【id 重复即拒】id 是索引、卡内 frontmatter、检索三处共用的主键；
  // 重复时 get(id) 返回先到的那张，**不报错、只是从此拿错卡**。
  const seen = new Set<string>();
  for (const entry of parsed as PackMeta[]) {
    if (seen.has(entry.id)) {
      throw new Error(`knowledge 索引里 id 重复：${entry.id}（${indexPath}）；id 是主键，重复即歧义`);
    }
    seen.add(entry.id);
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
  const root = resolveKnowledgeDir();
  const abs = path.resolve(root, meta.path);
  // ⑧【路径必须落在知识库目录内】此前 `../../../etc/hostname` 会被**真的读进来**，
  // 只是内容不像卡才失败——若那个文件恰好有 frontmatter 形状的开头，就会被当成知识卡喂给模型。
  // 【为什么理由要对】拒绝的理由错了，重构时会静默变成放行：
  // 有人把 frontmatter 检查改宽一点，这条路径就通了，而没人知道曾经有过一道路径闸。
  if (path.relative(root, abs).startsWith('..') || path.isAbsolute(path.relative(root, abs))) {
    throw new Error(`knowledge 索引的 path 指向知识库目录之外：${meta.id} → ${meta.path}；不允许越界读取`);
  }
  if (!fs.existsSync(abs)) {
    throw new Error(`knowledge 索引指向的文件不存在：${meta.id} → ${abs}；index.json 与 packs/ 不一致，需修数据`);
  }
  const raw = fs.readFileSync(abs, 'utf-8');
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw);
  if (!match) {
    throw new Error(`knowledge pack 缺少 frontmatter：${meta.id} → ${abs}`);
  }
  // ⑦【卡内 id 必须与索引一致】此前只有 CI 里的全量测试查这个——
  // 而**测试跑在 CI，数据在部署环节被换掉的话那条测试管不着**（manager 采为裁定依据）。
  // 启动闸是数据真正到达之处的最后一道，恰好该管 CI 够不着的这段。
  const idInCard = /^id:\s*(.+?)\s*$/m.exec(match[0]);
  if (idInCard && idInCard[1] !== meta.id) {
    throw new Error(
      `knowledge 卡内 id 与索引不一致：索引说 ${meta.id}，卡里写的是 ${idInCard[1]}（${abs}）`,
    );
  }
  const content = raw.slice(match[0].length);
  contentCache.set(meta.id, content);
  return content;
}

/**
 * 用户口语 → 卡词表规范词的**定点**映射（检索 P0 ③）。
 *
 * 【为什么不是无差别放宽】② 词级双向包含扫遍参数被证死路：
 * 2 字中文片段既带来全部召回（应召回 11→20）也带来全部广度爆炸（真实广度中位 1→25），
 * 长度轴与占比轴都分不开二者。别名只加**意图内**的匹配，广度不动。
 *
 * 【实现方式：扩 query，不改匹配语义】命中别名就把规范词追加到 query 上，
 * 之后仍走原来的整句子串匹配。匹配规则一个字没变 ⇒ 广度的增量**上界就是别名表本身**，
 * 不会随语料或 query 长度膨胀。
 */
interface AliasEntry {
  readonly alias: string;
  readonly canonical: string;
  readonly source: string;
}

let aliasCache: AliasEntry[] | null = null;

function loadAliases(): AliasEntry[] {
  if (aliasCache) return aliasCache;
  const file = path.join(resolveKnowledgeDir(), 'aliases.json');
  if (!fs.existsSync(file)) {
    aliasCache = [];
    return aliasCache;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries?: AliasEntry[] };
  const entries = raw.entries ?? [];
  const vocabulary = new Set<string>();
  for (const meta of loadIndex()) {
    for (const t of [...meta.keywords, ...meta.applies_to]) vocabulary.add(String(t));
  }
  for (const e of entries) {
    if (!e.alias || !e.canonical) {
      throw new Error(`aliases.json 有条目缺 alias/canonical：${JSON.stringify(e)}`);
    }
    // 【出处是硬约束，不是文档】没有出处的别名会让这张表变成无差别放宽的倾倒场，
    // 而那正是 ② 被撤的原因。拒绝启动，不静默跳过。
    if (!e.source?.trim()) {
      throw new Error(`aliases.json 的「${e.alias}→${e.canonical}」缺 source：每条别名必须写明由哪对孪生／哪条真实 query 驱动`);
    }
    // 【规范词必须真实存在】指向不存在的词是死重，而它**不报错、只是静默不生效**——
    // 有人会以为这条别名在起作用。宁可拒绝启动。
    if (!vocabulary.has(e.canonical)) {
      throw new Error(`aliases.json 的「${e.alias}→${e.canonical}」：规范词不在任何卡的词表里，这条别名不会生效`);
    }
  }
  aliasCache = entries;
  return aliasCache;
}

/** 命中别名就把规范词接到 query 尾部；没命中则原样返回 */
function expandQuery(query: string): string {
  let out = query;
  for (const e of loadAliases()) {
    if (query.includes(e.alias) && !query.includes(e.canonical)) out += ` ${e.canonical}`;
  }
  return out;
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

/**
 * 这张卡对本轮 query 是**实质命中**，还是只是被打分排序捞上来的尘埃？
 *
 * 【判定】keyword 或 applies_to 与 query 互为子串即算实质命中。
 * 纯靠标题 bigram 重叠捞上来的（`SCORE_TITLE_MAX` 那一项）**不算**——
 * 实测形态：query「上海高温津贴标准」命中 6 张卡（北京失业保险金/最低工资/生育津贴判例…），
 * **没有一张与上海或高温津贴有关**。这类"总能捞到 6 张、只是全无关"的尘埃，
 * 正是「有没有卡」这个旧判据看不见的东西——它数的是 length，而 length 是 6 不是 0。
 *
 * 【为什么必须只有这一处实现】产线用它触发空手感知，运营用它算空包率，判据用它复核
 * "该触发而没触发"。三处若各写一份，就会出现"产线认为有料、判据认为空手"——
 * 而这恰恰是这个指标要防的那类分歧。
 *
 * **manager 2026-08-25 给的判断标准（这条与「两把尺不共用刻度」看似打架，写在这里防误读）**：
 * > **问这两处代码"是在互相监督，还是在做同一件事"——监督要独立，同一件事要唯一。**
 * 判据与产线各自独立判"模型做得对不对"，那是监督，要两把尺；
 * 而"这张卡算不算实质命中"是**同一件事**，只能有一把尺。
 */
export function isSubstantiveHit(pack: Pick<PackMeta, 'keywords' | 'applies_to'>, rawQuery: string): boolean {
  const query = expandQuery(rawQuery);
  return (
    (pack.keywords ?? []).some((kw) => matches(kw, query)) ||
    (pack.applies_to ?? []).some((scene) => matches(scene, query))
  );
}

/** 本轮注入包里有几张是实质命中（空手感知的判据本体；0 = 手上这几张都不能用） */
export function countSubstantiveHits(packs: Pick<PackMeta, 'keywords' | 'applies_to'>[], query: string): number {
  return packs.filter((p) => isSubstantiveHit(p, query)).length;
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
  if (opts.court && !(meta.facts?.case_facts?.court ?? '').includes(opts.court)) return false;
  return true;
}

/**
 * 本地关键词检索。打分确定性、无分词依赖：keyword 命中 +3、applies_to 命中 +2、
 * 标题二元组重合率 ×2。score 为 0 的不返回（宁可空手也不给不相关的法条），
 * 同分先按类型优先序（依据优先）再按 id 字典序，保证同一 query 每次输出一致。
 */
export function search(query: string, opts: SearchOptions = {}): PackHit[] {
  const q = expandQuery(query.trim());
  if (!query.trim()) {
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
/**
 * 本进程**检索真正在用的**那份索引里有多少张卡。
 *
 * 【为什么必须同源，且"同值"不算】manager 2026-08-29 钉的规格：
 * 不许为这个数另读一次 index.json——`packs/` 丢了而 index.json 还在时，
 * 另读的那份会报 218，而 agent 手里是空的。
 * **两个真源在故障时各说各话，报出来的是好看的那个。**
 * 这里返回的就是 `loadIndex()`（与 search/get 同一个缓存数组）的长度，
 * 不是重新解析、也不是复制品的计数。
 */
export function loadedPackCount(): number {
  return loadIndex().length;
}

export function listPacks(): PackMeta[] {
  return loadIndex().map((meta) => ({ ...meta }));
}

export { KNOWLEDGE_TYPES, TYPE_TIEBREAK, typeRank, type KnowledgeType } from './types';

/** 仅供测试：清掉进程级缓存，让改 env LAWER_KNOWLEDGE_DIR 后的调用重新解析目录 */
export function __resetForTest(): void {
  knowledgeDir = null;
  packIndex = null;
  contentCache.clear();
  aliasCache = null; // 别名缓存也要清——不清的话测试里换表根本不生效，而它不报错
}
