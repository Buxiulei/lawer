// app/src/lib/llm/__tests__/mock-fetch.ts
// 单测用的假 fetch：把若干字符串分片喂成 SSE 响应体。
// 分片边界故意可以切在一行 JSON 中间——解析器的行缓冲要是写错了，这里就会露馅。

export interface MockCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

/** 把整段 SSE 文本按固定长度切碎，制造「一行被切成两半」的真实网络情形 */
export function chop(text: string, size = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** 返回 [fetchImpl, calls]：calls 累计每次请求的 url / 解析后的 body / headers，供断言请求体。 */
export function mockFetch(res: () => Response): [typeof fetch, MockCall[]] {
  const calls: MockCall[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      init,
      body: init.body ? JSON.parse(init.body as string) : {},
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return res();
  }) as unknown as typeof fetch;
  return [impl, calls];
}

/** 200 + SSE 流 */
export function sseResponse(sse: string, chunkSize = 7): Response {
  return new Response(streamOf(chop(sse, chunkSize)), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** 收干一个 chatStream generator：返回拼好的正文与 return 值 */
export async function drain<T>(gen: AsyncGenerator<string, T, void>): Promise<{ text: string; result: T }> {
  let text = '';
  for (;;) {
    const step = await gen.next();
    if (step.done) return { text, result: step.value };
    text += step.value;
  }
}
