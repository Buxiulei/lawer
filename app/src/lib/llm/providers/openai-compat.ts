// app/src/lib/llm/providers/openai-compat.ts
// OpenAI 兼容端点的共用实现（移植自六爻 dashscope.ts，删去六爻业务残留）。
// DashScope / OpenAI / DeepSeek 三家的差异只有 baseUrl + key + 模型名 + 少量厂商私有字段，
// 所以正文只写一份，三个 provider 文件是薄包装。厂商私有字段现在统一由 variant 参数
// （routing.config.VARIANT_REQUEST_PARAMS）经 ProviderOptions.extraBody 传进来，
// 不再由各 provider 文件硬编码——那样才能保证计费键与实际下发参数是一致的。
//
// 六爻原文件有 chatStream / chatToolsStream 两个解析器（历史上为了不破坏既有纯文本调用而分家），
// 这里是新写的，合成一个：有没有 tools 只影响请求体，SSE 增量语义完全一致。

import type {
  ChatStreamResult,
  Provider,
  ProviderName,
  ProviderOptions,
  TokenUsage,
  UsageCallback,
  UsageReport,
} from '../types';
import { emptyUsage } from '../types';
import { acquireSlot, connectWithRetry } from './gate';
import { createStreamTimers, httpError, sseData } from './sse';

/** OpenAI 兼容响应里的 usage 形状（各家都是这套字段名，缓存项各有各的加法）。 */
interface CompatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** OpenAI：缓存命中的输入 token */
  prompt_tokens_details?: { cached_tokens?: number };
  /** DeepSeek：上下文硬盘缓存命中 */
  prompt_cache_hit_tokens?: number;
}

export interface OpenAICompatOptions extends ProviderOptions {
  name: ProviderName;
  defaultBaseUrl: string;
}

/** usage → 四桶。拿不到的桶一律 null，绝不用 0 冒充（见 TokenUsage 注释）。
 *  归一化的关键一步：三家的 prompt_tokens **含**缓存命中量，而四桶要求互斥，
 *  所以 prompt 桶要减掉缓存命中，否则 billing 按桶相乘会把缓存 token 按全价算两遍。
 *  三家都没有「缓存写入」这个计价档（那是 Anthropic 特有），cachedWrite 恒 null。 */
function toTokenUsage(u: CompatUsage): TokenUsage {
  const rawPrompt = u.prompt_tokens ?? null;
  const cachedRead = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? null;
  return {
    prompt: rawPrompt === null ? null : rawPrompt - (cachedRead ?? 0),
    completion: u.completion_tokens ?? null,
    cachedRead,
    cachedWrite: null,
  };
}

export function createOpenAICompatProvider(o: OpenAICompatOptions): Provider {
  const base = o.baseUrl ?? o.defaultBaseUrl;
  const doFetch = o.fetchImpl ?? fetch;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` };
  const billingModel = o.billingModel ?? o.model;
  const tag = `${o.name}(${o.model})`;
  const report = (usage: TokenUsage): UsageReport => ({ model: billingModel, usage });

  return {
    name: o.name,
    model: o.model,
    billingModel,

    async chatStream(messages, opts = {}) {
      // 闸位先拿再起计时器：排队时长不该算进空闲/总时长超时（那两个量的是上游的响应速度）。
      const release = await acquireSlot(o.name);
      const timers = createStreamTimers(opts);
      const body: Record<string, unknown> = {
        model: o.model,
        messages,
        stream: true,
        // 请求流末 usage chunk，供 onUsage 与 return.usage 记账
        stream_options: { include_usage: true },
        ...o.extraBody,
      };
      if (opts.tools?.length) body.tools = opts.tools;
      // temperature / max_tokens 不传就不下发：部分新模型不接受 temperature，硬塞会 400；
      // 输出长度默认不在模型侧设限（沿用六爻做法）。
      if (opts.temperature !== undefined) body.temperature = opts.temperature;
      if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

      const res = await connectWithRetry(
        () =>
          doFetch(`${base}/chat/completions`, {
            method: 'POST',
            headers,
            signal: timers.signal,
            body: JSON.stringify(body),
          }),
        timers.signal,
      ).catch((e) => {
        timers.clear();
        release();
        throw e;
      });
      if (!res.ok || !res.body) {
        timers.clear();
        release();
        throw await httpError(`${tag} chatStream`, res);
      }
      // 闸位一直持到流读完（含异常终止）：占住上游连接的是流，不是那次 fetch
      const done = () => {
        timers.clear();
        release();
      };
      return parseCompatStream(res.body, timers.resetIdle, done, report, opts.onUsage, opts.onReasoning);
    },

    async chatJSON(messages, opts = {}) {
      // 同一个闸：这条也是一次真实的上游调用，不算进在途数就等于闸漏了一半。
      // 不加重试——重试语义是按「首字节前」定义的（见 gate.ts），非流式调用没有那个分界点，
      // 且分类调用失败由调用方降级处理，不值得占着闸位退避。
      // ⚠️ 别在 chatStream 的 tool 执行过程里同 provider 调 chatJSON：闸位是不可重入的，
      // 闸满时内层会排队 30s 后 503（外层正握着闸位不放）。
      const release = await acquireSlot(o.name);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 8000);
      try {
        const res = await doFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers,
          signal: ac.signal,
          body: JSON.stringify({
            model: o.model,
            messages,
            stream: false,
            // 分类/抽取要可重复，温度钉 0。不下发 response_format：不是每家每个型号都支持，
            // 靠调用方 system prompt 的「只输出 JSON」约束 + 下方剥围栏兜底。
            temperature: 0,
            ...o.extraBody,
          }),
        });
        if (!res.ok) throw await httpError(`${tag} chatJSON`, res);
        const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: CompatUsage | null };
        let content = j.choices?.[0]?.message?.content;
        if (!content) throw new Error(`${tag} chatJSON 空响应`);
        if (opts.onUsage && j.usage != null) opts.onUsage(report(toTokenUsage(j.usage)));
        // 降级解析：剥三引号代码围栏（```json… 或 ```…），再截取首 { 到末 }
        content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
        const first = content.indexOf('{');
        const last = content.lastIndexOf('}');
        if (first >= 0 && last > first) content = content.slice(first, last + 1);
        return content;
      } finally {
        clearTimeout(timer);
        release();
      }
    },
  };
}

/** 解析 OpenAI 兼容 SSE：yield delta.content 增量；按 index 累积 delta.tool_calls
 *  （arguments 分片拼成完整 JSON 字符串）；[DONE] 或流末交出 {finishReason, toolCalls, usage}。
 *  无法 JSON 解析的行是注释/保活行，按 SSE 规范跳过（非错误）。 */
async function* parseCompatStream(
  body: ReadableStream<Uint8Array>,
  onChunk: () => void,
  onDone: () => void,
  report: (usage: TokenUsage) => UsageReport,
  onUsage?: UsageCallback,
  onReasoning?: (totalChars: number) => void,
): AsyncGenerator<string, ChatStreamResult, void> {
  let finishReason: string | null = null;
  let usage: UsageReport = report(emptyUsage());
  let reasoningChars = 0;
  // 按 index 落槽累积工具调用分片（稀疏；末尾压实为密集 ToolCall[]）
  const acc: { id: string; name: string; args: string }[] = [];
  const finalize = (): ChatStreamResult => ({
    finishReason,
    toolCalls: acc
      .filter((t) => t && (t.id || t.name || t.args))
      .map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.args } })),
    usage,
  });

  for await (const payload of sseData(body, onChunk, onDone)) {
    if (payload === '[DONE]') return finalize();
    let j: {
      choices?: {
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
        finish_reason?: string | null;
      }[];
      usage?: CompatUsage | null;
    };
    try {
      j = JSON.parse(payload);
    } catch {
      continue; // SSE 注释/保活行
    }
    if (j.usage != null) {
      usage = report(toTokenUsage(j.usage));
      onUsage?.(usage);
    }
    const choice = j.choices?.[0];
    if (!choice) continue; // usage-only chunk：choices 为空
    const reasoning = choice.delta?.reasoning_content;
    if (reasoning && onReasoning) {
      reasoningChars += reasoning.length;
      onReasoning(reasoningChars);
    }
    // name/id 于首片给出；防碎片化仍按追加处理
    for (const tc of choice.delta?.tool_calls ?? []) {
      const slot = acc[tc.index] ?? (acc[tc.index] = { id: '', name: '', args: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta?.content;
    if (delta) yield delta;
  }
  // 流末无 [DONE]（连接自然关闭）也交出已拼好的工具调用与计量
  return finalize();
}
