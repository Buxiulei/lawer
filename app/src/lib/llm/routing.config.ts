// app/src/lib/llm/routing.config.ts
//
// ⚠️ 契约文件：本文件的路由策略、型号选择与计费键直接决定成本与公道值费率（spec §9），
// 属 manager 审批范围。改这里等于改定价，必须走 manager 审 + docs/CHANGELOG.md 记录，
// 不得由实现窗口自行调整。router.ts 只做查表，策略全在本文件。
//
// 依据 spec §2 D3 与 §9，价格依据 research/raw/C01-模型定价核定.md（2026-08-19 核定）：
//   入门 ¥19.9  全 DeepSeek/Qwen
//   中配 ¥59    critical 走 Claude
//   高配 ¥199   standard 及以上走 Claude（高配主力 sonnet-5，critical 留 opus-5）
// 三档的 bulk 恒不走 Claude——bulk 是分类/摘要/抽取这类高频小调用，用 Claude 会把毛利吃光。
//
// ── 为什么每个型号有 api / priced 两个串（重要，别合并）──
// manager 要求「一律锁 dated 版本号，不留浮动别名」。这条在**计费侧**能做到，在**API 侧做不到**，
// 2026-08-19 实测（真 key 直调）：
//   deepseek-v4-pro-0813 / DeepSeek-V4-Pro-0813  → 400，官方错误原文
//     "The supported API model names are deepseek-v4-pro or deepseek-v4-flash"
//     ——C01 里的 DeepSeek-V4-Pro-0813 是**定价页产品名**，不是 API model 参数。
//   qwen3.6-flash-2026-04-16 / qwen3.7-max-2026-06-08 → 403 Model.AccessDenied
//     ——dated 快照本账号无权限，只有别名可调。
//   Anthropic 的 model id 本身就不带日期（官方明确「never append date suffixes」），
//     写成 claude-sonnet-5-2026xxxx 会 400。
// 所以：`api` 是必须用别名的调用串，`priced` 是锁死的计费键（model_rates.model 用它）。
// 残留风险：别名日后被厂商重新指向新快照时，priced 会与实际计费口径脱节。这一层 API 侧
// 堵不住，只能靠对账发现——流式响应会回显实际 model，billing 侧建议存下来与 api 串比对。

import type { ProviderName } from './types';

/** 任务档位（spec §8 llm 路由）：
 *  - critical：错了会伤到用户的判断——签不签字、诉求金额、时效期限、文书定稿；
 *  - standard：日常陪跑对话、问诊追问、情绪回应；
 *  - bulk：分类、摘要、关键词抽取、OCR 文本清洗等高频小调用。 */
export type TaskClass = 'critical' | 'standard' | 'bulk';

/** 套餐档（spec §9 月卡）：entry=入门 / mid=中配 / high=高配 */
export type Plan = 'entry' | 'mid' | 'high';

/** 计费维度变体：同一型号下**计费口径不同**的调用形态（manager 2026-08-19 裁决）。
 *  C01 记载百炼「思考输出与非思考输出价不同」（如 qwen-plus 非思考 2 元 / 思考 8 元），
 *  所以思考开关是计费维度而非普通参数，必须进计费键。 */
export type Variant = 'think' | 'nothink';

export interface ModelSpec {
  /** 发给 API 的 model 参数——**只能是别名**，理由见文件头实测 */
  api: string;
  /** 计费锁定串，写进 model_rates.model。能锁 dated 就锁 dated */
  priced: string;
}

/** 型号常量。api 串均为 2026-08-19 真 key 直调验证可用；priced 串取自 C01 定价页。 */
export const MODELS = {
  /** C01：$5/$25，缓存读 0.1×、5m 写 1.25×。高配 critical 主力 */
  CLAUDE_OPUS: { api: 'claude-opus-5', priced: 'claude-opus-5' },
  /** C01：$2/$10（首发价已转正，9 月不涨）。高配 standard 主力、中配 critical */
  CLAUDE_SONNET: { api: 'claude-sonnet-5', priced: 'claude-sonnet-5' },
  /** C01：CNY 高峰 4.5/13.5 元，错峰半价。入门/中配的 critical 与 standard */
  DEEPSEEK_PRO: { api: 'deepseek-v4-pro', priced: 'DeepSeek-V4-Pro-0813' },
  /** C01：CNY 高峰 3.0/9.0 元，错峰半价（1.5/4.5）。三档 bulk 主力 */
  DEEPSEEK_FLASH: { api: 'deepseek-v4-flash', priced: 'DeepSeek-V4-Flash-0731' },
  /** C01 未单列 qwen3.7-max 价（同代 qwen3.8-max 为 12/36 元）。仅作 critical/standard 末位兜底 */
  QWEN_MAX: { api: 'qwen3.7-max', priced: 'qwen3.7-max' },
  /** C01：1.2/7.2 元（≤256K 档）。仅作 bulk 兜底 */
  QWEN_FLASH: { api: 'qwen3.6-flash', priced: 'qwen3.6-flash' },
} as const;

export interface RouteTarget {
  provider: ProviderName;
  model: ModelSpec;
  /** 计费维度变体。只在该型号确有多种计费口径时标注，标了就必须在 VARIANT_REQUEST_PARAMS 里有映射 */
  variant?: Variant;
}

/** variant → 厂商请求参数，按 `${provider}:${variant}` 索引。
 *  **只注册路由表实际用到的组合**：没用到的组合写了也无从验证，还会让人误以为支持。
 *
 *  当前只有 DashScope 有条目——2026-08-19 实测 qwen3.6-flash 同一条 trivial 提问，
 *  关思考 completion=1、开思考 completion=211（其中 reasoning=206），两百倍差价。
 *  bulk 档不该为思考链付这个钱，所以路由表里的 qwen 目标一律钉 nothink。
 *  DeepSeek V4 虽也支持思考/非思考，但 C01 价目表两者同价、我们也不下发该参数，故不注册；
 *  Anthropic 的思考 token 按普通输出计价，不构成独立计费维度，同样不注册。 */
export const VARIANT_REQUEST_PARAMS: Record<string, Record<string, unknown>> = {
  'dashscope:nothink': { enable_thinking: false },
  'dashscope:think': { enable_thinking: true },
};

/** 计费键：priced 串 [+ `:variant`]。UsageReport.model 与 model_rates.model 都用它。 */
export function billingKey(target: RouteTarget): string {
  return target.variant ? `${target.model.priced}:${target.variant}` : target.model.priced;
}

/** 三套餐 × 三档位路由表。查表是 router.route 的全部职责。
 *  OpenAI 侧（providers/openai.ts）已实现但默认表里没有——spec D3 把 GPT 列为「支持」，
 *  它是 manager 随时可切进本表的备选，不是默认成本结构的一部分。 */
export const ROUTING_TABLE: Record<Plan, Record<TaskClass, RouteTarget>> = {
  // 入门：全 DeepSeek/Qwen，一分 Claude 不用
  entry: {
    critical: { provider: 'deepseek', model: MODELS.DEEPSEEK_PRO },
    standard: { provider: 'deepseek', model: MODELS.DEEPSEEK_PRO },
    bulk: { provider: 'deepseek', model: MODELS.DEEPSEEK_FLASH },
  },
  // 中配：只有 critical 升到 Claude（Sonnet 档），其余与入门一致
  mid: {
    critical: { provider: 'anthropic', model: MODELS.CLAUDE_SONNET },
    standard: { provider: 'deepseek', model: MODELS.DEEPSEEK_PRO },
    bulk: { provider: 'deepseek', model: MODELS.DEEPSEEK_FLASH },
  },
  // 高配：standard 走 Sonnet 主力，critical 再升一档到 Opus，bulk 仍留在便宜档
  high: {
    critical: { provider: 'anthropic', model: MODELS.CLAUDE_OPUS },
    standard: { provider: 'anthropic', model: MODELS.CLAUDE_SONNET },
    bulk: { provider: 'deepseek', model: MODELS.DEEPSEEK_FLASH },
  },
};

/** 缺 key 降级序列：每个档位从优到次的完整模型偏好序（manager 2026-08-19 追加裁决）。
 *
 *  为什么按档位而不按套餐：降级要回答的是「这类活儿退而求其次该用谁」，与用户买了哪档无关。
 *  route() 先在链上定位当前套餐的首选，**只向后走**——绝不向前。这条方向性是硬约束：
 *  向前走意味着入门用户因为 DeepSeek 缺 key 就被升到 Claude，那是白送钱。
 *
 *  不变式（router.test.ts 逐条守）：
 *   1. ROUTING_TABLE 每个格子的目标都必须出现在对应档位的链上，否则定位不到降级方向；
 *   2. 链上每个 dashscope 目标都必须带 variant，否则会退回 qwen 默认开思考的两百倍价。 */
export const DEGRADE_CHAIN: Record<TaskClass, RouteTarget[]> = {
  critical: [
    { provider: 'anthropic', model: MODELS.CLAUDE_OPUS },
    { provider: 'anthropic', model: MODELS.CLAUDE_SONNET },
    { provider: 'deepseek', model: MODELS.DEEPSEEK_PRO },
    { provider: 'dashscope', model: MODELS.QWEN_MAX, variant: 'nothink' },
  ],
  standard: [
    { provider: 'anthropic', model: MODELS.CLAUDE_SONNET },
    { provider: 'deepseek', model: MODELS.DEEPSEEK_PRO },
    { provider: 'dashscope', model: MODELS.QWEN_MAX, variant: 'nothink' },
  ],
  bulk: [
    { provider: 'deepseek', model: MODELS.DEEPSEEK_FLASH },
    { provider: 'dashscope', model: MODELS.QWEN_FLASH, variant: 'nothink' },
  ],
};

/** 各 provider 的 API key 环境变量名（凭据只进 .env.local，绝不入仓库，spec D11）。 */
export const API_KEY_ENV: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
};
