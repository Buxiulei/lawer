// app/src/lib/billing/pricing.ts
// 公道值计费——全部可调常量集中此处（这是钱的地基，改价只改这一处）。
//
// ⚠ 本文件全部数值均为草案值，待 M3 接入真实模型与支付时核定。逐条注释标注了定标依据，
//   核定时对着依据改数、不要改结构。
//
// 记账口径：账本以整数「公道值」记账，不出现小数。
//   成本口径（spec §9）：1 元模型成本 = 300 公道值。它决定「一次任务扣多少公道值」。
//   零售口径：散充 1 元 = 100 公道值。它决定「花多少钱得多少公道值」。
// 两套口径通过 GONGDAO_PER_YUAN_TOKEN_COST 锚定。

/** 成本锚（spec §9）：1 元 token 成本 = 300 公道值。草案值，待 M3 核定。 */
export const GONGDAO_PER_YUAN_TOKEN_COST = 300;

/**
 * 美元换人民币汇率——Anthropic / OpenAI 官方只有美元价（C01 §汇率口径），换算由计费层自定。
 * 汇率草案待 M3 核定。种子行的 meta_json 会记下入库时用的汇率与核定日，日后改汇率
 * 只影响新写入的费率行，历史账单仍按当时汇率复算。
 */
export const USD_CNY_RATE = 7.20;

// ───────────────────────────── 零售：散充 ─────────────────────────────
/** 散充换算：1 元 = 100 公道值。草案值，待 M3 核定。 */
export const RECHARGE_GONGDAO_PER_YUAN = 100;
/** 散充金额上下限（元，整数）。 */
export const RECHARGE_YUAN_MIN = 1;
export const RECHARGE_YUAN_MAX = 9999;
/** 给定散充金额（元）应入账的公道值。 */
export function rechargeGongdao(yuan: number): number {
  return Math.round(yuan * RECHARGE_GONGDAO_PER_YUAN);
}

// ───────────────────────────── 零售：三档月卡 ─────────────────────────────
// 三档差异主要在 llm 路由策略，不在公道值币价——三档都是「1 元换多少公道值」同一条线，
// 买高档买的是「同样一次任务由更强的模型来做」：
//   入门：全程 DeepSeek；
//   中配：critical 环节（文书起草/风险判断）走 Claude，其余 DeepSeek；
//   高配：standard 以上环节一律走 Claude。
// gongdao=购买立即入账的公道值；days=会员有效天数（无自动续费，到期再购）。
// 全部草案值（manager 已批档位结构），待 M3 核定。
export const MEMBERSHIP = {
  entry: { priceYuan: 19.9, days: 30, gongdao: 3000 },
  standard: { priceYuan: 59, days: 30, gongdao: 9000 },
  pro: { priceYuan: 199, days: 30, gongdao: 30000 },
} as const;
export type MembershipPlan = keyof typeof MEMBERSHIP; // 'entry' | 'standard' | 'pro'

// ───────────────────────────── 守望监控订阅（三档 · spec v3 §2.2） ─────────────────────────────
// 守望按 tier 分档、按主体按月计费（不按次）：
//   daily=圈1 每日巡检   199 公道值/月/主体
//   weekly=圈2 每周巡检   60 公道值/月/主体
//   archive=圈3 存档      0（本就不监控，收费即欺诈）——archive 一律不扣、不落 ledger 行。
// 不分档会出量级冲突：圈1+圈2 典型 5~8 主体全按 199 = 995~1592 公道值/月，入门月卡只给 3000，
// 盯 8 个主体只够 1.9 个月。分档后典型分布（2 圈1 + 4 圈2 + 2 圈3）= 638 公道值/月，与月卡量级相称。
// 全部草案值（manager 已批档位结构），待 M3 核定；改价只改此处。
export const WATCH_TIER_GONGDAO = {
  daily: 199,
  weekly: 60,
  archive: 0,
} as const;
export type WatchTier = keyof typeof WATCH_TIER_GONGDAO; // 'daily' | 'weekly' | 'archive'

/** 某 tier 的月度公道值定价；未知 tier 回落 0（宁可不扣，不凭空扣一个猜的价）。 */
export function watchTierGongdao(tier: string): number {
  return (WATCH_TIER_GONGDAO as Record<string, number>)[tier] ?? 0;
}

// ───────────────────────────── 注册赠送 / 门槛 ─────────────────────────────
/**
 * 注册赠送（定额）：1000 公道值。草案值。
 * spec 口径：赠送额以「能完整走完一次首诊」为准——上线前用真实首诊链路实测标定，
 * 实测值高于本常量时必须提额，否则纯新用户第一步就被 gate 拦死。
 */
export const REGISTER_GRANT_GONGDAO = 1000;

/** 计费门槛：公道值余额 ≥ 此值即可发起计费行为（负余额自然被拦）。 */
export const GONGDAO_GATE_MIN = 1;

/** gongdao_ledger.type 取值（集中此处，防拼写漂移）。 */
export const GONGDAO_LEDGER_TYPE = {
  membership: '会员额度',
  recharge: '充值',
  redemption: '兑换',
  consume: '消耗',
  register: '注册赠送',
  admin: '管理员调整',
  writeoff: '失败核销',
  refund: '退款',
} as const;
export type GongdaoLedgerType = (typeof GONGDAO_LEDGER_TYPE)[keyof typeof GONGDAO_LEDGER_TYPE];

// ───────────────────────────── token 计价 ─────────────────────────────
// 单价不写死在代码里：每个模型的三档费率存 model_rates 表（只追加不修改），
// 由 db/modelRates.ts 的 getRatesForModel 按 effective_at 取当时生效那条。
// 本文件只提供「给定费率如何算钱」与「查不到费率时的兜底」。

/**
 * 一次调用的 token 用量（各项可缺省为 0）。四个桶互不相交，调用方必须先按厂商口径拆好再传：
 * 多数厂商的 prompt_tokens 是「含缓存」的总输入，直接透传会把缓存读按全价重算一遍。
 */
export interface UsageTokens {
  /** 未命中缓存的输入 token（已扣除 cacheReadTokens）。 */
  promptTokens?: number;
  completionTokens?: number;
  /** 命中缓存的输入 token，按 cacheRead 档（Anthropic/OpenAI 均为输入价 0.1×）。 */
  cacheReadTokens?: number;
  /** 写入缓存的 token，按 cacheWrite 档（比标准输入贵，Anthropic/OpenAI 5m 档 1.25×）。 */
  cacheWriteTokens?: number;
  embedTokens?: number;
}

/** 某模型的四档费率，单位 公道值/token。 */
export interface TokenRates {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * model_rates 无该模型（该档）行时的兜底费率。兜底草案待 M3 核定。
 * 取 C01 里最便宜的在售自有模型 DeepSeek-V4-Flash-0731 的 CNY 高峰价（元/百万 tokens
 * ÷ 1e6 × GONGDAO_PER_YUAN_TOKEN_COST）：输入未命中 3.0 元、输出 9.0 元、缓存命中 0.10 元。
 * DeepSeek 官方无缓存写费，故 cacheWrite 兜底取 in 价（宁可按未命中算，不白记 0）。
 * embed 无独立档，按 in 档计。
 * 口径：兜底只是「没配费率也要记账」的下限，不是定价——真实计价一律走 model_rates 种子行。
 */
export const DEFAULT_RATES: TokenRates = {
  in: (3.0 / 1_000_000) * GONGDAO_PER_YUAN_TOKEN_COST,
  out: (9.0 / 1_000_000) * GONGDAO_PER_YUAN_TOKEN_COST,
  cacheRead: (0.1 / 1_000_000) * GONGDAO_PER_YUAN_TOKEN_COST,
  cacheWrite: (3.0 / 1_000_000) * GONGDAO_PER_YUAN_TOKEN_COST,
};

/** 本次用量的精确公道值成本（未取整，可含小数）。 */
export function exactGongdaoOfUsage(u: UsageTokens, rates: TokenRates): number {
  return (
    (u.promptTokens ?? 0) * rates.in +
    (u.completionTokens ?? 0) * rates.out +
    (u.cacheReadTokens ?? 0) * rates.cacheRead +
    (u.cacheWriteTokens ?? 0) * rates.cacheWrite +
    (u.embedTokens ?? 0) * rates.in
  );
}

/** 结算公道值（向上取整，整数入账）——账本实扣额。 */
export function costOfUsage(u: UsageTokens, rates: TokenRates): number {
  return Math.ceil(exactGongdaoOfUsage(u, rates));
}

/** token_usage.cost_li 精度刻度：1 公道值 = 1000 厘（0.001 公道值/厘）。 */
export const GONGDAO_LI_SCALE = 1000;

/** 本次用量的精确成本，单位 0.001 公道值（token_usage.cost_li 存这个整数，避免小数累积丢精度）。 */
export function costLiOfUsage(u: UsageTokens, rates: TokenRates): number {
  return Math.round(exactGongdaoOfUsage(u, rates) * GONGDAO_LI_SCALE);
}

// ───────────────────────────── 文案 ─────────────────────────────
/** 全站公道值文案（劳动者语境：说人话，不玄学）。 */
export const GONGDAO_COPY = {
  recharge: '充值公道值',
  balance: '剩余公道值',
  insufficient: '公道值不足，请充值或开通套餐',
} as const;
