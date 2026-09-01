// app/src/lib/llm/providers/sse.ts
// 四家供应商共用的流式底座：双超时控制 + SSE 行解析。
// OpenAI 兼容侧与 Anthropic 侧的事件语义完全不同，但「怎么把字节流切成一条条 data: 负载」
// 和「怎么在空闲时掐断」是同一件事，只写一份。

import type { ChatStreamOptions, FinishReason } from '../types';

const DEFAULT_IDLE_MS = 90_000;
const DEFAULT_MAX_MS = 900_000;

export interface StreamTimers {
  signal: AbortSignal;
  /** 每收到任意网络 chunk 调用一次，重置空闲计时器 */
  resetIdle: () => void;
  /** 流正常/异常结束都要调用，清掉两个计时器 */
  clear: () => void;
}

/** 空闲超时（每 chunk 重置）+ 总时长硬上限。取代「一刀切总超时」——
 *  思考模型的长输出会超过任何合理总超时，只要还在产 chunk 就不该切断；
 *  真正的挂起表现为「长时间无任何 chunk」，由空闲超时兜底。 */
export function createStreamTimers(opts: Pick<ChatStreamOptions, 'idleTimeoutMs' | 'maxDurationMs'> = {}): StreamTimers {
  const ac = new AbortController();
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  let idleTimer = setTimeout(() => ac.abort(), idleMs);
  const maxTimer = setTimeout(() => ac.abort(), opts.maxDurationMs ?? DEFAULT_MAX_MS);
  return {
    signal: ac.signal,
    resetIdle: () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ac.abort(), idleMs);
    },
    clear: () => {
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
    },
  };
}

/** 逐行切分 SSE 字节流，产出每条 `data:` 的负载字符串（已 trim）。
 *  `event:` 行不产出：两家的 data 负载里都自带 type 字段，按 data 判型即可，少一层状态。
 *  onChunk 在每个网络 chunk 上触发（供重置空闲计时器）；onDone 成败均触发（供清理计时器）。 */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
  onChunk?: () => void,
  onDone?: () => void,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
    onDone?.();
  }
}

/** 错误报文保留的头部/尾部字符数。
 *  为什么必须**保头保尾**而不是只保头：2026-08-31 实测中转的 503 报文长这样——
 *    {"error":{"message":"分组 default、限时体验、纯AZ、官转、…〔三十余个分组名〕…
 *      下模型 claude-opus-9-nonexistent 无可用渠道（distributor） (request id: …)"}}
 *  是哪个模型没了、以及「无可用渠道」这个判据，全都在报文**末尾**；开头几百字节是
 *  一份对所有 503 都一模一样的分组名清单。只保头的话每条 503 日志长得完全相同，
 *  既认不出是哪个模型掉了，也分不清该换腿还是该重试——等于没记。 */
const BODY_HEAD_CHARS = 200;
const BODY_TAIL_CHARS = 300;

/** 非 2xx / 无响应体时用的错误对象，带状态码与响应体片段（保头保尾，避免把长报文灌进日志）。
 *  返回 Error 而不是直接抛：调用点写成 `throw await httpError(...)`，TS 才认得那行之后不可达。 */
export async function httpError(tag: string, res: Response): Promise<Error> {
  const body = await res.text().catch(() => '');
  const brief =
    body.length <= BODY_HEAD_CHARS + BODY_TAIL_CHARS
      ? body
      : `${body.slice(0, BODY_HEAD_CHARS)}…〔略 ${body.length - BODY_HEAD_CHARS - BODY_TAIL_CHARS} 字〕…${body.slice(-BODY_TAIL_CHARS)}`;
  return new Error(`${tag} HTTP ${res.status}: ${brief}`);
}

/** 「截断到空」判据，两个解析器在交出结果前各调一次（判断只写这一份，见文件头）。
 *
 *  形态：上游报 finish_reason=length（Anthropic 的 max_tokens 已在 provider 内映射过来），
 *  却一个非空白正文字符都没产出、也没拼出任何工具调用。
 *
 *  为什么必须抛而不是照常交出：空正文对用户就是一次失败——他等了几分钟拿到一片空白，
 *  而静默 return 会让上层把这一轮当作**正常收尾**：落库、计费、进下一轮上下文，
 *  失败既不可见也无从重试。抛出来才进得了上层既有的失败通路（chat 路由的 error 帧）。
 *
 *  为什么只认 length、且要求没有工具调用：
 *   · refusal 也常是空正文，但那是模型**决定**不答（types.ts 有言在先），重来一次还是同一个答案，
 *     报成故障只会让用户白等一轮；length 是被 max_tokens 从半路切断，重来是有意义的。
 *   · 带工具调用的 length 轮对用户不是空回复——tool-loop 还要往下走，拦在这里等于把正常一轮打断。 */
export function assertTruncatedNotEmpty(
  tag: string,
  finishReason: FinishReason,
  sawText: boolean,
  toolCallCount: number,
): void {
  if (finishReason !== 'length' || sawText || toolCallCount > 0) return;
  throw new Error(
    `缺：${tag} 本轮的回复正文——上游报 finish_reason=length（输出被 max_tokens 截断），` +
      `却没有产出任何正文或工具调用。` +
      `原因：token 预算在正文出字之前就用尽（思考链吃满预算，或 max_tokens 给得过小）。` +
      `怎么办：这一轮对用户等同失败，按错误处理——重试或换更长的输出预算，不要把空白当正常回复下发。`,
  );
}
