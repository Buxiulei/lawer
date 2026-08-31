// app/src/lib/db/modelRates.ts
// model_rates 表封装：模型 token 费率的唯一读写入口。
// 表只追加不修改——改价 = 写一条更晚 effective_at 的新行，历史行保留以便按当时费率复算旧账。
// 档位变体编码进 model 字符串（qwen-plus:think / gpt-5.6-terra:long / …），本层只当字符串用。
// 预编译语句按 db 实例缓存（同一 db 只 prepare 一次；:memory: 单测各自独立 db 不互相污染）。
import type Database from 'better-sqlite3';
import { DEFAULT_RATES, GONGDAO_PER_YUAN_TOKEN_COST, USD_CNY_RATE, type TokenRates } from '../billing/pricing';

/** model_rates.token_kind 取值（与表 CHECK 约束一一对应）。 */
export type TokenKind = 'in' | 'out' | 'cache_read' | 'cache_write';

/** token_kind → TokenRates 字段名。 */
const KIND_TO_FIELD: Record<TokenKind, keyof TokenRates> = {
  in: 'in',
  out: 'out',
  cache_read: 'cacheRead',
  cache_write: 'cacheWrite',
};

/**
 * 每档取 effective_at ≤ now 的最新一行。
 * SQLite 特例：聚合查询里只用 MAX() 一个聚合函数时，同 SELECT 的裸列取自 MAX 所在那行——
 * 故一次分组即可拿到「每档最新生效行」的费率，无需相关子查询。
 */
const SQL_LATEST_RATES = `
  SELECT token_kind, gongdao_per_token, MAX(effective_at) AS eff
    FROM model_rates
   WHERE model = ? AND effective_at <= datetime('now')
   GROUP BY token_kind
`;

// effective_at 统一经 datetime() 归一（既接受 'YYYY-MM-DD HH:MM:SS' 也接受 ISO 串），
// 否则字符串比较会把 '2026-01-01T00:00:00Z' 排到 '2026-01-01 00:00:00' 之后，取错生效行。
const RATE_COLUMNS = `(model, token_kind, gongdao_per_token, effective_at, meta_json)
  VALUES (?, ?, ?, COALESCE(datetime(?), datetime('now')), ?)`;
const SQL_INSERT_RATE = `INSERT INTO model_rates ${RATE_COLUMNS}`;
/** 种子专用：命中 uq_model_rates 即跳过，反复播种不重复落行。 */
const SQL_SEED_RATE = `INSERT OR IGNORE INTO model_rates ${RATE_COLUMNS}`;

interface Stmts {
  latest: Database.Statement;
  insert: Database.Statement;
  seed: Database.Statement;
}

const CACHE = new WeakMap<Database.Database, Stmts>();

function stmts(db: Database.Database): Stmts {
  let s = CACHE.get(db);
  if (!s) {
    s = {
      latest: db.prepare(SQL_LATEST_RATES),
      insert: db.prepare(SQL_INSERT_RATE),
      seed: db.prepare(SQL_SEED_RATE),
    };
    CACHE.set(db, s);
  }
  return s;
}

/**
 * 取某模型当前生效的四档费率（单位 公道值/token）。
 * 任一档缺行（含整个模型没配过费率）时，该档回落 DEFAULT_RATES——
 * 宁可按兜底草案计费，也不让没配费率的模型白跑不记账。
 */
export function getRatesForModel(db: Database.Database, model: string): TokenRates {
  const rows = stmts(db).latest.all(model) as { token_kind: string; gongdao_per_token: number }[];
  const rates: TokenRates = { ...DEFAULT_RATES };
  for (const r of rows) {
    const field = KIND_TO_FIELD[r.token_kind as TokenKind];
    if (field) rates[field] = r.gongdao_per_token;
  }
  return rates;
}

/**
 * 追加一条费率（改价即追加，绝不 UPDATE 既有行）。
 * effectiveAt 省略即刻生效；同 (model, token_kind, effective_at) 重复写入由唯一索引抛错——
 * 这是有意的：同一时点两个不同费率无法判定用哪个，必须由调用方给出不同生效时间。
 */
export function setModelRate(
  db: Database.Database,
  model: string,
  kind: TokenKind,
  gongdaoPerToken: number,
  effectiveAt?: string,
  meta?: Record<string, unknown>,
): void {
  stmts(db).insert.run(model, kind, gongdaoPerToken, effectiveAt ?? null, meta ? JSON.stringify(meta) : null);
}

// ───────────────────────────── C01 费率种子 ─────────────────────────────
// 数据源唯一：research/raw/C01-模型定价核定.md（2026-08-19 核定，逐条抄官方页）。
// C01 方法论声明：搜索/摘要工具会捏造价格数字——本表任何数字都只许从 C01 抄，
// 不许凭记忆写、不许上网查。改价请先更新 C01，再照抄过来。

/** C01 核定日；同时作为全部种子行的 effective_at（固定值 = 反复播种幂等的前提）。 */
const C01_VERIFIED_ON = '2026-08-19';
const SEED_EFFECTIVE_AT = `${C01_VERIFIED_ON} 00:00:00`;

const SRC = {
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  openai: 'https://developers.openai.com/api/docs/pricing',
  deepseek: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  bailian: 'https://help.aliyun.com/zh/model-studio/model-pricing',
} as const;

/** 一条种子费率。price 恒为「每百万 token 的官方标价」，币种见 currency。 */
interface SeedRate {
  model: string;
  kind: TokenKind;
  price: number;
  currency: 'USD' | 'CNY';
  source: string;
  /** 非空 = 本行的数字是**占位值不是定价**，写明凭什么占这个位。
   *  占位行照样入库（否则 getRatesForModel 会静默回落 DEFAULT_RATES，连"待定"这件事都看不见），
   *  但 meta_json 里带「待定价」标记，且 routing 侧有守卫钉住它不许被入门档卖给用户。 */
  pending?: string;
}

const usd = (model: string, kind: TokenKind, price: number): SeedRate =>
  ({ model, kind, price, currency: 'USD', source: '' }) as SeedRate;

/** 官方标价（每百万 token）→ 公道值/token。USD 先按 USD_CNY_RATE 折人民币。 */
function toGongdaoPerToken(price: number, currency: 'USD' | 'CNY'): number {
  const cnyPerMTok = currency === 'USD' ? price * USD_CNY_RATE : price;
  return (cnyPerMTok / 1_000_000) * GONGDAO_PER_YUAN_TOKEN_COST;
}

/**
 * 收录范围＝我们会真用到的组合，逐行注释附 C01 里的官方原价。未收录的档位一律走变体后补，
 * 不在此处臆造：
 *   - Anthropic 1h 缓存写（2× 输入价）→ 按 `<model>:cache1h` 变体后补；
 *   - OpenAI Long context 档（输入约 2×、输出 1.5×）→ 按 `<model>:long` 变体后补；
 *   - DeepSeek 错峰价（高峰半价）→ 按 `<model>:offpeak` 变体后补；
 *   - qwen-plus / qwen-flash 的 128K 以上阶梯 → 按 `<model>:128k` 等变体后补；
 *   - qwen 系缓存档（C01 待复核项①：百炼 125%/10% 官方原文是「例如」，未逐模型证实）→ 不录；
 *   - paraformer-v2 按音频秒数计价、不按 token → 不进本表，成本换算归 lib/llm 的 asr 层。
 */
const SEED_RATES: SeedRate[] = [
  // ── Anthropic（USD/百万 token，C01 §一）。cache_write 取 5m 档 = 1.25× 输入价。──
  ...([
    ['claude-opus-5', 5, 25, 0.5, 6.25],      // C01：$5 / $25 / 读 $0.50 / 5m 写 $6.25
    ['claude-sonnet-5', 2, 10, 0.2, 2.5],     // C01：$2 / $10 / 读 $0.20 / 5m 写 $2.50（首发价已转正，9 月不涨）
    ['claude-haiku-4-5', 1, 5, 0.1, 1.25],    // C01：$1 / $5 / 读 $0.10 / 5m 写 $1.25
  ] as const).flatMap(([model, i, o, cr, cw]) => [
    usd(model, 'in', i), usd(model, 'out', o), usd(model, 'cache_read', cr), usd(model, 'cache_write', cw),
  ]).map((r) => ({ ...r, source: SRC.anthropic })),

  // ── OpenAI（USD/百万 token，C01 §二 主会话抽查表）：Standard 档 · Short context。──
  ...([
    ['gpt-5.6-terra', 2.0, 12.0, 0.2, 2.5],    // C01：$2.00 / $12.00 / 缓存读 $0.20 / 缓存写 $2.50
    ['gpt-5.6-luna', 0.2, 1.2, 0.02, 0.25],    // C01：$0.20 / $1.20 / 缓存读 $0.02 / 缓存写 $0.25
  ] as const).flatMap(([model, i, o, cr, cw]) => [
    usd(model, 'in', i), usd(model, 'out', o), usd(model, 'cache_read', cr), usd(model, 'cache_write', cw),
  ]).map((r) => ({ ...r, source: SRC.openai })),

  // ── DeepSeek（CNY/百万 token，C01 §三 人民币表 · 高峰时段）。官方无缓存写档，故无 cache_write 行。
  //    型号用 dated 全名：C01 明示 deepseek-chat / deepseek-reasoner 别名已废弃。──
  { model: 'DeepSeek-V4-Flash-0731', kind: 'in', price: 3.0, currency: 'CNY', source: SRC.deepseek },        // C01：缓存未命中 3.0 元（高峰）
  { model: 'DeepSeek-V4-Flash-0731', kind: 'out', price: 9.0, currency: 'CNY', source: SRC.deepseek },       // C01：输出 9.0 元（高峰）
  { model: 'DeepSeek-V4-Flash-0731', kind: 'cache_read', price: 0.1, currency: 'CNY', source: SRC.deepseek },// C01：缓存命中 0.10 元（高峰）
  { model: 'DeepSeek-V4-Pro-0813', kind: 'in', price: 9.0, currency: 'CNY', source: SRC.deepseek },          // C01：缓存未命中 9.0 元（高峰）
  { model: 'DeepSeek-V4-Pro-0813', kind: 'out', price: 27.0, currency: 'CNY', source: SRC.deepseek },        // C01：输出 27.0 元（高峰）
  { model: 'DeepSeek-V4-Pro-0813', kind: 'cache_read', price: 0.3, currency: 'CNY', source: SRC.deepseek },  // C01：缓存命中 0.30 元（高峰）

  // ── 阿里云百炼（CNY/百万 token，华北2北京，C01 §四）。──
  { model: 'qwen-max', kind: 'in', price: 2.4, currency: 'CNY', source: SRC.bailian },                       // C01：输入 2.4 元（无阶梯）
  { model: 'qwen-max', kind: 'out', price: 9.6, currency: 'CNY', source: SRC.bailian },                      // C01：输出 9.6 元（仅非思考模式）
  { model: 'qwen-plus:think', kind: 'in', price: 0.8, currency: 'CNY', source: SRC.bailian },                // C01：第一阶梯 0<Token≤128K 输入 0.8 元
  { model: 'qwen-plus:think', kind: 'out', price: 8, currency: 'CNY', source: SRC.bailian },                 // C01：同阶梯 思考模式输出 8 元（含思维链）
  { model: 'qwen-plus:nothink', kind: 'in', price: 0.8, currency: 'CNY', source: SRC.bailian },              // C01：第一阶梯 输入 0.8 元
  { model: 'qwen-plus:nothink', kind: 'out', price: 2, currency: 'CNY', source: SRC.bailian },               // C01：同阶梯 非思考输出 2 元
  // qwen-vl-ocr 必须锁 dated 版本号：C01 警告 2025-11-20 版 0.3/0.5 元，更早版本 5/5 元，差 10 倍以上。
  { model: 'qwen-vl-ocr-2025-11-20', kind: 'in', price: 0.3, currency: 'CNY', source: SRC.bailian },         // C01：输入 0.3 元
  { model: 'qwen-vl-ocr-2025-11-20', kind: 'out', price: 0.5, currency: 'CNY', source: SRC.bailian },        // C01：输出 0.5 元
  { model: 'text-embedding-v4', kind: 'in', price: 0.5, currency: 'CNY', source: SRC.bailian },              // C01：输入 0.5 元（输出不计费，故只有 in 档）

  // ── 路由表实际会产生、但此前没有费率行的计费键（2026-08-31 结构守卫抓出）。──
  // 这三个键一直在 DEGRADE_CHAIN 上，查不到费率就静默按 DEFAULT_RATES（DeepSeek-Flash 地板价）
  // 记账，账面全绿而计价口径是错的。守卫见 llm/__tests__/billing-key-coverage.test.ts。
  //
  // qwen3.6-flash:nothink —— C01 §四有价，照抄即可（≤256K 档）。variant 后缀是计费键的一部分：
  // 路由表里这个型号恒钉 nothink，所以只补 nothink 这一支，think 支没人会路由到、不臆造。
  { model: 'qwen3.6-flash:nothink', kind: 'in', price: 1.2, currency: 'CNY', source: SRC.bailian },          // C01：输入 1.2 元（≤256K 档）
  { model: 'qwen3.6-flash:nothink', kind: 'out', price: 7.2, currency: 'CNY', source: SRC.bailian },         // C01：输出 7.2 元（≤256K 档）

  // qwen3.7-max:nothink —— ⚠ C01 **未单列**本型号价（同代 qwen3.8-max 为 12/36 元，不是它）。
  // 拿同代价来顶会往高里错（用户多付），拿 qwen-max 的 2.4/9.6 来顶则是另一个型号的价——
  // 两种都是编数字。所以这里落 DEFAULT_RATES 兜底草案的同一组数（= pricing.ts 里
  // DeepSeek-V4-Flash 高峰价 3.0/9.0/0.1，cache_write 取 in 价），标「待定价」：
  // 数值上等价于没配费率时的回落，但**这件事在库里看得见**，而不是靠谁记得。
  // 它只出现在 critical/standard 的降级链末位（应急腿），不在任何套餐的默认路由上。
  ...([['in', 3.0], ['out', 9.0], ['cache_read', 0.1], ['cache_write', 3.0]] as const).map(
    ([kind, price]): SeedRate => ({
      model: 'qwen3.7-max:nothink',
      kind,
      price,
      currency: 'CNY',
      source: SRC.bailian,
      pending: 'C01 未单列 qwen3.7-max 价，本行数值取 pricing.ts 的 DEFAULT_RATES 兜底草案占位，上线前必须过 manager',
    }),
  ),

  // ── 中转（第三方转售）费率。计费键带 relay/ 前缀，与直连分属两个命名空间。──
  // ⚠ 全部标「待定价」：中转的最终单价 = 上游官方价 × model_ratio × group_ratio，
  // 后两个系数只在中转控制台里（2026-08-31 实测 /dashboard/billing/* 只回 1 亿占位值，
  // /user/self 无权限，API 侧查不到），且 x-routing-group 实测在 default / vip 之间浮动。
  // 占位值一律取**上游官方标价**（即与直连同数）：转售价只会 ≥ 官方价，所以这个占位
  // 只会让我们少收（低卖），不会让用户多付——缺信息时的错误方向要偏向用户不吃亏。
  ...([
    ['relay/claude-opus-5', 5, 25, 0.5, 6.25],   // 上游 C01：$5 / $25 / 读 $0.50 / 5m 写 $6.25
    ['relay/claude-sonnet-5', 2, 10, 0.2, 2.5],  // 上游 C01：$2 / $10 / 读 $0.20 / 5m 写 $2.50
  ] as const).flatMap(([model, i, o, cr, cw]) => [
    usd(model, 'in', i), usd(model, 'out', o), usd(model, 'cache_read', cr), usd(model, 'cache_write', cw),
  ]).map((r) => ({
    ...r,
    source: SRC.anthropic,
    pending: '中转转售单价 = 官方价 × model_ratio × group_ratio，两系数需登中转控制台核定；本行按上游官方价占位（只会低估），上线前必须过 manager',
  })),

  // 境内两家经中转的费率：仅当 RELAY_ROUTE_DOMESTIC 开关打开时才会产生这些键（默认直连）。
  // 先备好行，免得应急切换当天才发现没费率、整批按地板价记账。
  ...([
    ['relay/DeepSeek-V4-Pro-0813', 9.0, 27.0, 0.3],    // 上游 C01：缓存未命中 9.0 / 输出 27.0 / 缓存命中 0.30 元（高峰）
    ['relay/DeepSeek-V4-Flash-0731', 3.0, 9.0, 0.1],   // 上游 C01：缓存未命中 3.0 / 输出 9.0 / 缓存命中 0.10 元（高峰）
  ] as const).flatMap(([model, i, o, cr]): SeedRate[] => [
    { model, kind: 'in', price: i, currency: 'CNY', source: SRC.deepseek },
    { model, kind: 'out', price: o, currency: 'CNY', source: SRC.deepseek },
    { model, kind: 'cache_read', price: cr, currency: 'CNY', source: SRC.deepseek },
  ]).map((r) => ({
    ...r,
    pending: '中转转售单价需登控制台核定；本行按上游官方价占位（只会低估）。另：实测中转回的 deepseek usage 算术不自洽，这批行不可直接进对账口径，上线前必须过 manager',
  })),

  // relay/qwen3.7-max:nothink —— 双重待定：型号本身 C01 无价，中转倍率又未知。取兜底草案占位。
  ...([['in', 3.0], ['out', 9.0], ['cache_read', 0.1], ['cache_write', 3.0]] as const).map(
    ([kind, price]): SeedRate => ({
      model: 'relay/qwen3.7-max:nothink',
      kind,
      price,
      currency: 'CNY',
      source: SRC.bailian,
      pending: '双重待定：C01 未单列 qwen3.7-max 价，中转倍率亦未知；本行取 DEFAULT_RATES 兜底草案占位，上线前必须过 manager',
    }),
  ),
];

/**
 * 幂等种入 C01 核定的模型费率。
 * 幂等靠 (model, token_kind, effective_at) 唯一索引 + INSERT OR IGNORE：
 * 全部种子行共用固定 effective_at（= C01 核定日），故反复播种行数不变。
 * 日后改价请写新的 effective_at 行，不要改本函数里的历史数字。
 * @returns 本次真实写入的行数（首次播种 = 全量，重复播种 = 0）。
 */
export function seedModelRates(db: Database.Database): number {
  const seed = stmts(db).seed;
  return db.transaction(() => {
    let inserted = 0;
    for (const r of SEED_RATES) {
      const meta = {
        源URL: r.source,
        官方原价: r.price, // 单位恒为「每百万 token」，币种见下
        币种: r.currency,
        汇率: r.currency === 'USD' ? USD_CNY_RATE : null,
        核定日: C01_VERIFIED_ON,
        // 只有占位行才有这个键——查账时 meta_json 里出现「待定价」就说明这行的数字不是定价
        ...(r.pending ? { 待定价: r.pending } : {}),
      };
      const res = seed.run(
        r.model,
        r.kind,
        toGongdaoPerToken(r.price, r.currency),
        SEED_EFFECTIVE_AT,
        JSON.stringify(meta),
      );
      inserted += res.changes;
    }
    return inserted;
  })();
}

/** 种子收录的全部模型串（供选型/测试遍历；含 :think 这类变体串）。 */
export const SEEDED_MODELS: readonly string[] = [...new Set(SEED_RATES.map((r) => r.model))];

/** 费率仍是占位值、未经 manager 定价的模型串。
 *  routing 侧据此守住「待定价的模型不许出现在卖给用户的默认路由上」——
 *  见 llm/__tests__/billing-key-coverage.test.ts。 */
export const PENDING_PRICE_MODELS: ReadonlySet<string> = new Set(
  SEED_RATES.filter((r) => r.pending).map((r) => r.model),
);
