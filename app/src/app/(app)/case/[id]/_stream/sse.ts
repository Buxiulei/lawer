/**
 * text/event-stream 解析：fetch + ReadableStream 逐 event 收帧。
 * 不用 EventSource——它只支持 GET，我们的对话是 POST 带 Authorization。
 */

import { toFrame, type StreamFrame } from './frames';

/** 一个事件块（空行分隔）→ 帧。注释行、id/retry 字段直接跳过。 */
function parseEventBlock(block: string): StreamFrame | null | undefined {
  let event: string | null = null;
  const dataLines: string[] = [];

  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return undefined;

  let data: unknown;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    console.warn('[chat-sse] data 不是合法 JSON，已丢弃', { event });
    return undefined;
  }

  const frame = toFrame(event, data);
  if (!frame) {
    console.warn('[chat-sse] 未知帧类型，已忽略', { event, data });
    return undefined;
  }
  return frame;
}

export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        const frame = parseEventBlock(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
        if (frame) yield frame;
        at = buffer.indexOf('\n\n');
      }
    }
    // 末尾没有空行收尾的残块也收一次，免得丢 done
    const tail = parseEventBlock(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
