// app/src/lib/llm/providers/anthropic.ts
// Anthropic Messages API 原生 SSE 客户端（POST /v1/messages, stream:true）。
// 不走 OpenAI 兼容层：Anthropic 的消息是内容块数组、system 是顶层字段、工具结果回喂在 user 轮，
// 与另外三家结构性不同，兼容层套不上。对外仍是统一的 Provider 形态，转换全在本文件内闭合。
//
// 不实现 chatJSON：小型 JSON 调用属 bulk 档，按 routing.config.ts 三套餐 bulk 恒不走 Claude。
// 并发闸与连接期重试走 providers/gate.ts（四家共用）。**流开始后不重试**：
// 断流一律原样抛出，重复跑一遍会重复计费也会给用户重复正文。

import type {
  ChatMessage,
  ChatStreamResult,
  FinishReason,
  Provider,
  ProviderOptions,
  TokenUsage,
  ToolCall,
  ToolDef,
  UsageCallback,
  UsageReport,
} from '../types';
import { emptyUsage } from '../types';
import { acquireSlot, connectWithRetry } from './gate';
import { createStreamTimers, httpError, sseData } from './sse';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
/** Messages API 的 max_tokens 是必填字段（与 OpenAI 兼容侧「不传就不限制」不同），给个够用的默认值 */
const DEFAULT_MAX_TOKENS = 4096;

// ── Anthropic 线上格式（只声明本文件用得到的字段）──

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
interface AnthropicToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string }
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** stop_reason → 统一 FinishReason 词表（types.ts）。表里没有的值原样透出，
 *  不篡改成 'stop'——新出现的结束原因（如新的安全类别）必须让上层看见。 */
const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'refusal',
  pause_turn: 'pause_turn',
};

/** 统一消息（OpenAI 形态）→ Anthropic 请求体的 {system, messages}。
 *  三处结构差异在这里抹平：
 *  1. system 轮不进 messages，提到顶层 system 字段（多条按出现顺序拼接）；
 *  2. assistant 的 tool_calls 变成 tool_use 内容块，arguments 字符串要 parse 成对象；
 *  3. role:'tool' 轮变成 user 轮里的 tool_result 块，且**连续多条必须并进同一个 user 轮**——
 *     一次 assistant 轮发起的多个工具调用，其结果被拆到多个 user 轮会被 API 拒绝。 */
export function toAnthropicRequest(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const systems: string[] = [];
  const out: AnthropicMessage[] = [];
  let pendingResults: AnthropicToolResultBlock[] = [];

  const flushResults = () => {
    if (pendingResults.length) {
      out.push({ role: 'user', content: pendingResults });
      pendingResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === 'system') {
      flushResults();
      if (m.content) systems.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      if (!m.tool_call_id) throw new Error('anthropic: role=tool 的消息缺 tool_call_id，无法对应 tool_use 块');
      pendingResults.push({ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content });
      continue;
    }
    flushResults();
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    // assistant
    const blocks: AnthropicBlock[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    for (const tc of m.tool_calls ?? []) {
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseToolArguments(tc) });
    }
    // 既无正文又无工具调用的 assistant 轮在 Anthropic 侧非法（content 不能为空数组），直接丢弃
    if (blocks.length) out.push({ role: 'assistant', content: blocks });
  }
  flushResults();

  return { system: systems.length ? systems.join('\n\n') : undefined, messages: out };
}

/** tool_calls 里的 arguments 是 JSON 字符串（流式拼出来的），Anthropic 的 input 要对象。
 *  解析失败就地报错并带上工具名——比把畸形 JSON 塞给 API 换一个含糊的 400 强。 */
function parseToolArguments(tc: ToolCall): unknown {
  const raw = tc.function.arguments?.trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`anthropic: 工具 ${tc.function.name} 的 arguments 不是合法 JSON，无法转成 tool_use.input`);
  }
}

/** ToolDef（OpenAI function schema）→ Anthropic 工具定义。字段名不同，schema 本体通用。 */
export function toAnthropicTools(tools: ToolDef[]) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

export function createAnthropic(o: ProviderOptions): Provider {
  const base = o.baseUrl ?? ANTHROPIC_BASE_URL;
  const doFetch = o.fetchImpl ?? fetch;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': o.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  const billingModel = o.billingModel ?? o.model;
  const tag = `anthropic(${o.model})`;
  const report = (usage: TokenUsage): UsageReport => ({ model: billingModel, usage });

  return {
    name: 'anthropic',
    model: o.model,
    billingModel,

    async chatStream(messages, opts = {}) {
      // 消息转换（可能抛：缺 tool_call_id / 畸形 arguments）挪到取闸位之前，
      // 否则那条抛错路径会把闸位和计时器一起漏掉。
      const { system, messages: anthMessages } = toAnthropicRequest(messages);
      const body: Record<string, unknown> = {
        model: o.model,
        messages: anthMessages,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        // Claude 5 系思考链恒开、无 budget_tokens；显式写出来是为了让 display 生效，
        // 也让日后换成非默认开思考的型号时行为不变。display:'summarized' 才会产出
        // thinking_delta 文本（默认 'omitted' 是空串），这是 onReasoning 的数据源。
        thinking: { type: 'adaptive', display: 'summarized' },
        ...o.extraBody,
      };
      if (system) body.system = system;
      if (opts.tools?.length) body.tools = toAnthropicTools(opts.tools);
      // 注意：Claude 5 系（含 claude-sonnet-5）已移除采样参数，传 temperature 会 400。
      // 这里只在调用方显式指定时才下发，默认不传。
      if (opts.temperature !== undefined) body.temperature = opts.temperature;
      // 序列化在取闸位之前、在 attempt 闭包之外（同 openai-compat）：请求体每次重试都一样，
      // 且序列化异常不是「上游不给力」，不该被当成连接失败重试三次，也不该碰到闸位。
      const payload = JSON.stringify(body);

      // 与 openai-compat 同一道闸（见 providers/gate.ts）：闸位按 provider 分桶，
      // 只闸三家不闸 anthropic 等于给最贵的那条路留了个不设防的口子。
      // 闸位先拿再起计时器：排队时长不该算进空闲/总时长超时。
      const release = await acquireSlot('anthropic');
      const timers = createStreamTimers(opts);
      // 兜底归还：generator 被**抛弃**（客户端断流后消费方 emit 抛错，既不再 next() 也不 return()）时，
      // sseData 的 finally 永远等不到，下面的 done 就永不执行——攒够 MAX_CONCURRENT_PER_PROVIDER 次
      // 该 provider 全局死锁。计时器只在正常收尾时被 clear，被抛弃的那路一定会走到超时 abort，
      // 让它承重一次 release（幂等，见 gate.ts）。
      timers.signal.addEventListener('abort', release, { once: true });

      const res = await connectWithRetry(
        () =>
          doFetch(`${base}/messages`, {
            method: 'POST',
            headers,
            signal: timers.signal,
            body: payload,
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
      return parseAnthropicStream(res.body, timers.resetIdle, done, report, opts.onUsage, opts.onReasoning);
    },
  };
}

/** 解析 Anthropic Messages SSE。事件语义与 OpenAI 兼容侧完全不同，故独立解析器：
 *  - message_start           带 usage.input_tokens 与缓存读写量（输入侧计量只在这里出现一次）
 *  - content_block_start     text / tool_use / thinking 三种块开场；tool_use 在此拿到 id 与 name
 *  - content_block_delta     text_delta → 正文增量；input_json_delta → 工具参数分片；
 *                            thinking_delta → 思考链（不进正文，走 onReasoning）
 *  - message_delta           带 stop_reason 与最终 usage.output_tokens
 *  - message_stop            流结束
 *  - error                   API 中途报错（HTTP 已 200，错误在流里），抛出
 *  按 index 落槽累积 tool_use 块，流末压实为 ToolCall[]，与 OpenAI 侧同形。 */
async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
  onChunk: () => void,
  onDone: () => void,
  report: (usage: TokenUsage) => UsageReport,
  onUsage?: UsageCallback,
  onReasoning?: (totalChars: number) => void,
): AsyncGenerator<string, ChatStreamResult, void> {
  let finishReason: FinishReason = null;
  const usage: TokenUsage = emptyUsage();
  let sawUsage = false;
  let reasoningChars = 0;
  const acc: { id: string; name: string; args: string }[] = [];
  const finalize = (): ChatStreamResult => ({
    finishReason,
    toolCalls: acc
      .filter((t) => t && (t.id || t.name || t.args))
      .map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.args } })),
    usage: report(usage),
  });
  /** input/output 分别在流首、流末给出，两处都要并进同一份计量。
   *  Anthropic 的 input_tokens 天然不含缓存读写量，四桶直接对上，无需像兼容层那样做减法。 */
  const mergeUsage = (u: AnthropicUsage) => {
    if (u.input_tokens !== undefined) usage.prompt = u.input_tokens;
    if (u.output_tokens !== undefined) usage.completion = u.output_tokens;
    if (u.cache_read_input_tokens !== undefined) usage.cachedRead = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens !== undefined) usage.cachedWrite = u.cache_creation_input_tokens;
    sawUsage = true;
  };

  for await (const payload of sseData(body, onChunk, onDone)) {
    let ev: {
      type?: string;
      index?: number;
      message?: { usage?: AnthropicUsage };
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; stop_reason?: string | null };
      usage?: AnthropicUsage;
      error?: { type?: string; message?: string };
    };
    try {
      ev = JSON.parse(payload);
    } catch {
      continue; // SSE 注释/保活行
    }
    switch (ev.type) {
      case 'message_start':
        if (ev.message?.usage) mergeUsage(ev.message.usage);
        break;
      case 'content_block_start':
        if (ev.content_block?.type === 'tool_use' && ev.index !== undefined) {
          acc[ev.index] = { id: ev.content_block.id ?? '', name: ev.content_block.name ?? '', args: '' };
        }
        break;
      case 'content_block_delta': {
        const d = ev.delta;
        if (d?.type === 'text_delta' && d.text) {
          yield d.text;
        } else if (d?.type === 'input_json_delta' && d.partial_json && ev.index !== undefined) {
          const slot = acc[ev.index] ?? (acc[ev.index] = { id: '', name: '', args: '' });
          slot.args += d.partial_json;
        } else if (d?.type === 'thinking_delta' && d.thinking && onReasoning) {
          reasoningChars += d.thinking.length;
          onReasoning(reasoningChars);
        }
        break;
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) {
          finishReason = STOP_REASON_MAP[ev.delta.stop_reason] ?? ev.delta.stop_reason;
        }
        if (ev.usage) mergeUsage(ev.usage);
        break;
      case 'message_stop':
        if (sawUsage) onUsage?.(report(usage));
        return finalize();
      case 'error':
        throw new Error(`anthropic 流内错误 ${ev.error?.type ?? 'unknown'}: ${ev.error?.message ?? ''}`);
      default:
        break; // ping / content_block_stop 等无需处理
    }
  }
  // 流末无 message_stop（连接自然关闭）也交出已拼好的工具调用与计量
  if (sawUsage) onUsage?.(report(usage));
  return finalize();
}
