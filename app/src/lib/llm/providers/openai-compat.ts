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
import { assertTruncatedNotEmpty, createStreamTimers, httpError, sseData } from './sse';

/** 缓存写入档的字段名。中转（new-api 系）两种写法都出现过，且既可能挂在
 *  prompt_tokens_details 下、也可能是顶层裸字段——两处都认，代价是两个 ?? 项。 */
interface CacheWriteFields {
  /** 中转归一化后的缓存写入量 */
  cache_write_tokens?: number;
  /** 中转透传 Anthropic 的 5 分钟缓存创建量（与上一个实测同值） */
  claude_cache_creation_5_m_tokens?: number;
}

/** OpenAI 兼容响应里的 usage 形状（各家都是这套字段名，缓存项各有各的加法）。 */
interface CompatUsage extends CacheWriteFields {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** OpenAI：缓存命中的输入 token。中转还会在这里塞缓存写入档，见 CacheWriteFields */
  prompt_tokens_details?: { cached_tokens?: number } & CacheWriteFields;
  /** DeepSeek：上下文硬盘缓存命中 */
  prompt_cache_hit_tokens?: number;
}

export interface OpenAICompatOptions extends ProviderOptions {
  name: ProviderName;
  defaultBaseUrl: string;
}

/** usage → 四桶。拿不到的桶一律 null，绝不用 0 冒充（见 TokenUsage 注释）。
 *  归一化的关键一步：各家的 prompt_tokens **含**缓存命中/写入量，而四桶要求互斥，
 *  所以 prompt 桶要把缓存两档都减掉，否则 billing 按桶相乘会把缓存 token 算两遍。
 *
 *  ── 为什么 cachedWrite 不再恒 null（2026-08-31 生产实测改）──
 *  直连三家（DashScope/OpenAI/DeepSeek）确实没有缓存写入计价档，但**经中转的 Claude 有**，
 *  两个独立样本算术自洽地证明 `prompt_tokens = cached_read + cache_write + 新鲜输入`：
 *    opus   非流式 prompt=813 cached=757 cache_write=54 （757+54+2 = 813）
 *    sonnet 非流式 prompt=75  cached=33  cache_write=30 （33+30+12 = 75）
 *  旧写法把 cache_write 并进 prompt 桶按 1.0× 输入价记账，而它实际是 1.25× 档——
 *  那是**低卖**（我们少收钱、用户不吃亏），方向上不伤用户但会在最贵的型号上持续渗漏：
 *  实测流式 opus 一次就有 1202 个 cache_write token 被当普通输入记。所以要认这两个字段。
 *
 *  ── 缺字段时的方向：一律偏「用户不吃亏」，且不伪装成已知 ──
 *  某档没回报就是 null，billing 侧按 0 计入（orchestrator 只在**四桶全 null** 时才跳过记账）。
 *  于是缺 cachedWrite → 那些 token 落进 prompt 桶按 1.0× 记 → 我们少收；
 *  缺 cachedRead     → 全部输入按 1.0× 记 → 用户多付。后者是唯一会让用户吃亏的方向，
 *  实测中转对 claude/gpt/qwen 都稳定回报 cached_tokens，暂未出现；真出现时
 *  该行的计费键带 relay/ 前缀（见 routing.config.billingKey），对账时可整批摘出来复算，
 *  不会静默混进直连的账里。 */
function toTokenUsage(u: CompatUsage): TokenUsage {
  const rawPrompt = u.prompt_tokens ?? null;
  const d = u.prompt_tokens_details;
  const cachedRead = d?.cached_tokens ?? u.prompt_cache_hit_tokens ?? null;
  const cachedWrite =
    d?.cache_write_tokens ??
    d?.claude_cache_creation_5_m_tokens ??
    u.cache_write_tokens ??
    u.claude_cache_creation_5_m_tokens ??
    null;
  return {
    // 夹到 0：实测中转的 deepseek 会回报「命中量大于总输入量」（prompt_tokens=62 而
    // prompt_cache_hit_tokens=128）这种自相矛盾的 usage。负数桶会让本轮成本算成负的，
    // 等于倒贴公道值给用户——宁可记 0 也不能让账本出现负成本。
    prompt: rawPrompt === null ? null : Math.max(0, rawPrompt - (cachedRead ?? 0) - (cachedWrite ?? 0)),
    completion: u.completion_tokens ?? null,
    cachedRead,
    cachedWrite,
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
      // 序列化在取闸位之前、在 attempt 闭包之外：请求体每次重试都一样，重复序列化是白烧 CPU；
      // 更要紧的是序列化异常（extraBody 里塞进循环引用一类）不是「上游不给力」，
      // 落在闭包里会被当成连接失败重试三次，落在取闸位之前则连闸位都不会碰。
      const payload = JSON.stringify(body);

      // 闸位先拿再起计时器：排队时长不该算进空闲/总时长超时（那两个量的是上游的响应速度）。
      const release = await acquireSlot(o.name);
      const timers = createStreamTimers(opts);
      // 兜底归还：generator 被**抛弃**（客户端断流后消费方 emit 抛错，既不再 next() 也不 return()）时，
      // sseData 的 finally 永远等不到，下面的 done 就永不执行——每漏一路少一个闸位，
      // 攒够 MAX_CONCURRENT_PER_PROVIDER 次该 provider 全局死锁。计时器只在正常收尾时被 clear，
      // 所以被抛弃的那路一定会走到空闲/总时长超时的 abort，让它承重一次 release（幂等，见 gate.ts）。
      timers.signal.addEventListener('abort', release, { once: true });

      const res = await connectWithRetry(
        () =>
          doFetch(`${base}/chat/completions`, {
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
      return parseCompatStream(res.body, tag, timers.resetIdle, done, report, opts.onUsage, opts.onReasoning);
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
  tag: string,
  onChunk: () => void,
  onDone: () => void,
  report: (usage: TokenUsage) => UsageReport,
  onUsage?: UsageCallback,
  onReasoning?: (totalChars: number) => void,
): AsyncGenerator<string, ChatStreamResult, void> {
  let finishReason: string | null = null;
  let usage: UsageReport = report(emptyUsage());
  let reasoningChars = 0;
  /** 本条流是否产出过**非空白**正文。逐片判即可：整条流有非空白字符 ⟺ 某一片有。 */
  let sawText = false;
  // 按 index 落槽累积工具调用分片（稀疏；末尾压实为密集 ToolCall[]）
  const acc: { id: string; name: string; args: string }[] = [];
  // 两个 return 出口（[DONE] 与流末）都经这里，所以「截断到空」的判据放在这一处就够
  const finalize = (): ChatStreamResult => {
    const toolCalls = acc
      .filter((t) => t && (t.id || t.name || t.args))
      .map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.args } }));
    assertTruncatedNotEmpty(tag, finishReason, sawText, toolCalls.length);
    return { finishReason, toolCalls, usage };
  };

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
    if (delta) {
      if (delta.trim()) sawText = true;
      yield delta;
    }
  }
  // 流末无 [DONE]（连接自然关闭）也交出已拼好的工具调用与计量
  return finalize();
}
