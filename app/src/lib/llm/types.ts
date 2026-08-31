// app/src/lib/llm/types.ts
// 多供应商统一 Provider 接口（spec §8 llm 路由）。消息/工具类型沿用 OpenAI 兼容形态——
// 四家里有三家（DashScope/OpenAI/DeepSeek）原生就是这个形状，只有 Anthropic 需要在
// providers/anthropic.ts 里做一层进出转换，反向选型会让三家都背转换成本。
//
// 铁律：SSE 流式是对话的唯一形态（spec §3.5「LLM 响应一律 SSE 流式」）。
// 非流式只保留 chatJSON 这一个小型 JSON 分类调用口子，见下方注释。

/** OpenAI 兼容 chat 消息（移植自六爻 dashscope.ts）：
 *  - assistant 轮可携 tool_calls（模型请求调用工具；纯工具轮 content 传空串 ''）；
 *  - role:'tool' 轮回喂单次工具执行结果，须带 tool_call_id 对应 assistant 的某个 tool_call。
 *  content 保持非空 string（不放宽为 null）：tool-loop 回喂的 assistant 正文本就是累计增量字符串。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** 工具定义（OpenAI 兼容 function schema）。parameters 为 JSON Schema 对象。 */
export interface ToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

/** 模型发起的一次工具调用。arguments 为 JSON 字符串（流式分片拼接后所得），由调用方 JSON.parse。
 *  注意：各家对 arguments 的转义风格不同（Claude 会额外转义 Unicode / 斜杠），
 *  调用方一律 JSON.parse，禁止对原始字符串做匹配。 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** token 四桶计量（manager 2026-08-19 裁决）。**这是计费的输入**
 *  （spec §7 token_usage / model_rates，§9 公道值按实结算）。
 *
 *  四桶对应 model_rates 的四种计价维度，**两两互斥、可直接分桶相乘求和**：
 *    公道值 = prompt×in + cachedRead×cache_read + cachedWrite×cache_write + completion×out
 *
 *  互斥需要各 provider 归一化，因为线上口径本来不一致：Anthropic 的 input_tokens 天然不含
 *  缓存读写量；OpenAI/DeepSeek/DashScope 的 prompt_tokens 是**含**缓存命中的总输入，
 *  所以兼容层会减掉缓存部分再填 prompt。照抄原始 usage 字段会把缓存 token 算两遍。
 *
 *  每个字段都是「数字或显式 null」——null 表示本次流没有回报该项，绝不用 0 冒充。
 *  billing 侧遇到 null 必须按「待补计量」处理，不能当 0 结算。
 *  cachedWrite 只有 Anthropic 有（C01：5m 写 1.25×、1h 写 2×）；OpenAI 兼容三家恒 null。
 *
 *  注：不再回报「总量」字段。四桶是计费口径的全部，多给一个总量只会让人拿它当结算依据，
 *  而各家自报总量的口径（含不含缓存）本来就不一致。要总量的自己把四桶相加。 */
export interface TokenUsage {
  prompt: number | null;
  completion: number | null;
  cachedRead: number | null;
  cachedWrite: number | null;
}

/** 全 null 的四桶（流末没拿到 usage 时的返回值）。 */
export function emptyUsage(): TokenUsage {
  return { prompt: null, completion: null, cachedRead: null, cachedWrite: null };
}

/** 一次调用的计量上报。model 是**计费键**而不是 API 调用串——
 *  见 routing.config.ts：两者是不同的命名空间，API 只认别名，计费要锁 dated 版本。
 *  含计费维度变体时形如 `qwen3.6-flash:nothink`（manager 2026-08-19 裁决）。
 *  billing 侧拿 model 直接查 model_rates，不需要再认识 provider。 */
export interface UsageReport {
  model: string;
  usage: TokenUsage;
}

/** 流末计量回调。与 chatStream 的 return.usage 内容一致，回调用于「边流边记账」，
 *  return 值用于「流结束后一次性入账」，两者取其一即可，重复记账由 billing 侧幂等键兜。 */
export type UsageCallback = (report: UsageReport) => void;

/** 统一的结束原因词表（OpenAI 词表为准，Anthropic 的 stop_reason 在 provider 内映射过来）。
 *  跨供应商必须只有一套词表，否则调用方得按 provider 分支判断，路由就白做了。
 *  - 'stop'       正常收尾
 *  - 'tool_calls' 模型请求调用工具 ⇒ 执行 toolCalls 后回喂续轮
 *  - 'length'     触到 max_tokens 被截断
 *  - 'refusal'    模型安全拒答（Claude 5 系会以此结束，正文可能为空，调用方须先判本字段再读正文）
 *  - 'content_filter' 内容被过滤
 *  - null         流被对端关闭且未给出结束原因
 *  类型故意是宽 string 而非字面量联合：各家随时可能加新值，收窄会逼 provider 层
 *  把没见过的值篡改成 'stop'，那是拿计费和 tool-loop 语义换类型好看。 */
export type FinishReason = string | null;

/** chatStream 的 generator return 值：本轮拼好的工具调用 + 结束原因 + 计量上报。 */
export interface ChatStreamResult {
  finishReason: FinishReason;
  /** 无工具调用时为空数组（不是 undefined），调用方 .length 判断即可 */
  toolCalls: ToolCall[];
  /** 见 TokenUsage 注释：桶为 null 表示本次流未回报，不可当 0 结算 */
  usage: UsageReport;
}

export interface ChatStreamOptions {
  /** 传了就走 native function calling；不传就是纯对话流 */
  tools?: ToolDef[];
  /** 不传则不下发该字段，由各家用自己的默认值（部分新模型不接受 temperature，硬塞会 400） */
  temperature?: number;
  /** 输出上限。Anthropic max_tokens 必填，缺省 4096（见 providers/anthropic.ts）；
   *  OpenAI 兼容侧不传则不限制（沿用六爻做法：不在模型侧限制输出长度）。 */
  maxTokens?: number;
  /** 空闲超时（默认 90s）：每收到任意网络 chunk 就重置。思考模型长输出会被总超时硬切，
   *  真正的挂起表现为「长时间无任何 chunk」，由空闲超时兜底。 */
  idleTimeoutMs?: number;
  /** 总时长硬上限（默认 900s） */
  maxDurationMs?: number;
  /** 流末拿到 usage 时触发 */
  onUsage?: UsageCallback;
  /** 每解析到思考链增量时触发，参数为累计字符数（不进正文；节流由调用方做） */
  onReasoning?: (totalChars: number) => void;
}

/** 'relay' = 第三方中转（OpenAI 兼容协议，端点与 key 全走 env，见 providers/relay.ts）。
 *  它是**独立的一家**而不是「anthropic 换个 baseUrl」：闸位桶、限流特征、计费口径
 *  （中转单价 = 上游官方价 × model_ratio × group_ratio）与直连都不是一回事，
 *  借用别人的身份会让三者搅在一起，观测和限流都分不开。 */
export type ProviderName = 'anthropic' | 'openai' | 'deepseek' | 'dashscope' | 'relay';

/** 统一供应商接口。路由拿到目标后经 createProvider 换成本接口的实例，
 *  上层（lib/agent）只认这个接口，不认具体厂商。 */
export interface Provider {
  readonly name: ProviderName;
  /** 实际发给 API 的 model 参数（别名，见 routing.config.ts 文件头） */
  readonly model: string;
  /** 计量上报用的计费键（dated 锁定串 [:variant]），与 UsageReport.model 一致 */
  readonly billingModel: string;
  /** 流式对话。连接期失败（fetch 异常 / 非 2xx）在 await 时抛错；429/502/503/网络错在**连接期**
   *  由 providers/gate.ts 重试≤2 次，流一旦开始就绝不重试（会重复计费与重复正文）。
   *  await 还会因为并发闸排队超时抛 LlmGateBusyError（503）。不做熔断/缓存。
   *  generator：yield 正文增量；return {finishReason, toolCalls, usage}。 */
  chatStream(messages: ChatMessage[], opts?: ChatStreamOptions): Promise<AsyncGenerator<string, ChatStreamResult, void>>;
  /** 小型 JSON 调用（问句分类、意图抽取一类），非流式，返回剥好围栏的 JSON 字符串。
   *  可选方法：只有 OpenAI 兼容三家实现（移植自六爻）。Anthropic 侧刻意不实现——
   *  这类调用属 bulk 档，按 routing.config.ts 的三套餐表 bulk 恒不走 Claude，
   *  给 anthropic.ts 加 chatJSON 就是写死代码。调用方须先判 `if (p.chatJSON)`。 */
  chatJSON?(messages: ChatMessage[], opts?: { timeoutMs?: number; onUsage?: UsageCallback }): Promise<string>;
}

export interface ProviderOptions {
  apiKey: string;
  /** 发给 API 的 model 参数 */
  model: string;
  /** 计量上报用的计费键；不传则退回 model（只应发生在单测里） */
  billingModel?: string;
  /** 计费维度变体对应的厂商请求参数，直接并进请求体（见 routing.config.VARIANT_REQUEST_PARAMS） */
  extraBody?: Record<string, unknown>;
  baseUrl?: string;
  /** 注入供单测 mock；不传用全局 fetch */
  fetchImpl?: typeof fetch;
}
