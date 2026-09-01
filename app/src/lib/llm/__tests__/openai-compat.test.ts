// app/src/lib/llm/__tests__/openai-compat.test.ts
// OpenAI 兼容三家（DashScope/DeepSeek/OpenAI）共用实现的 SSE 解析与计量归一化。
// 计量是计费的输入，所以「拿不到就是 null」「缓存 token 不重复计」这两条比正文拼接更要紧。
import { describe, test, expect } from 'vitest';
import { createDashScope } from '../providers/dashscope';
import { createDeepSeek } from '../providers/deepseek';
import { createOpenAI } from '../providers/openai';
import { drain, mockFetch, sseResponse } from './mock-fetch';

const dataLine = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const textDelta = (s: string) => dataLine({ choices: [{ index: 0, delta: { content: s } }] });

describe('chatStream 正文与结束原因', () => {
  test('分片跨行也能原样拼回正文，[DONE] 收尾', async () => {
    const sse =
      textDelta('您好，') +
      ': keep-alive\n\n' + // SSE 注释行，按规范跳过
      textDelta('这是一份《被迫解除通知》') +
      textDelta('的草稿。') +
      dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      dataLine({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540 } }) +
      'data: [DONE]\n\n';
    const [fetchImpl] = mockFetch(() => sseResponse(sse, 5));
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', billingModel: 'DeepSeek-V4-Pro-0813', fetchImpl });

    const { text, result } = await drain(await p.chatStream([{ role: 'user', content: '帮我写份通知' }]));
    expect(text).toBe('您好，这是一份《被迫解除通知》的草稿。');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({
      model: 'DeepSeek-V4-Pro-0813',
      usage: { prompt: 1200, completion: 340, cachedRead: null, cachedWrite: null },
    });
  });

  test('流末无 [DONE]（对端直接关连接）也交出已解析的结果', async () => {
    const sse = textDelta('半句话') + dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createOpenAI({ apiKey: 'k', model: 'gpt-5', fetchImpl });

    const { text, result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(text).toBe('半句话');
    expect(result.finishReason).toBe('length');
  });

  test('reasoning_content 不进正文，只累计字符数回调', async () => {
    const sse =
      dataLine({ choices: [{ index: 0, delta: { reasoning_content: '先看时效' } }] }) +
      dataLine({ choices: [{ index: 0, delta: { reasoning_content: '再算金额' } }] }) +
      textDelta('结论：') +
      'data: [DONE]\n\n';
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createDashScope({ apiKey: 'k', model: 'qwen3.7-max', fetchImpl });

    const seen: number[] = [];
    const { text } = await drain(
      await p.chatStream([{ role: 'user', content: 'x' }], { onReasoning: (n) => seen.push(n) }),
    );
    expect(text).toBe('结论：');
    expect(seen).toEqual([4, 8]);
  });
});

describe('token 计量', () => {
  test('onUsage 回调与 return.usage 内容一致', async () => {
    const sse =
      textDelta('a') +
      dataLine({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) +
      'data: [DONE]\n\n';
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });

    const got: unknown[] = [];
    const { result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }], { onUsage: (u) => got.push(u) }));
    expect(got).toEqual([result.usage]);
  });

  test('缓存命中量从 promptTokens 里扣除，四项互斥不重复计费', async () => {
    // DeepSeek 口径：prompt_tokens = hit + miss，直接照抄会把 900 个缓存 token 按全价再算一遍
    const sse =
      textDelta('a') +
      dataLine({
        choices: [],
        usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_cache_hit_tokens: 900 },
      }) +
      'data: [DONE]\n\n';
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });

    const { result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(result.usage.usage).toEqual({ prompt: 100, completion: 50, cachedRead: 900, cachedWrite: null });
  });

  test('OpenAI 的 prompt_tokens_details.cached_tokens 同样扣除', async () => {
    const sse =
      dataLine({
        choices: [],
        usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520, prompt_tokens_details: { cached_tokens: 384 } },
      }) + 'data: [DONE]\n\n';
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createOpenAI({ apiKey: 'k', model: 'gpt-5', fetchImpl });

    const { result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(result.usage.usage.prompt).toBe(116);
    expect(result.usage.usage.cachedRead).toBe(384);
  });

  test('整条流没有 usage → 五项全 null，绝不用 0 冒充', async () => {
    const sse = textDelta('a') + 'data: [DONE]\n\n';
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });

    const seen: unknown[] = [];
    const { result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }], { onUsage: (u) => seen.push(u) }));
    expect(result.usage.usage).toEqual({ prompt: null, completion: null, cachedRead: null, cachedWrite: null });
    expect(seen).toEqual([]); // 没有 usage 就不该触发回调
  });
});

describe('tool-calling', () => {
  test('arguments 分片按 index 拼成完整 JSON，finish_reason=tool_calls', async () => {
    const sse =
      dataLine({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'claim_calc', arguments: '' } }] },
          },
        ],
      }) +
      dataLine({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"kind":' } }] } }] }) +
      dataLine({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"2N","months":13}' } }] } }] }) +
      dataLine({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'knowledge_search', arguments: '{"q":"竞业"}' } }] } },
        ],
      }) +
      dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      'data: [DONE]\n\n';
    const [fetchImpl, calls] = mockFetch(() => sseResponse(sse, 11));
    const p = createDashScope({ apiKey: 'k', model: 'qwen3.7-max', fetchImpl });

    const tools = [
      { type: 'function' as const, function: { name: 'claim_calc', parameters: { type: 'object', properties: {} } } },
    ];
    const { result } = await drain(await p.chatStream([{ role: 'user', content: '算一下' }], { tools }));

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'claim_calc', arguments: '{"kind":"2N","months":13}' } },
      { id: 'call_2', type: 'function', function: { name: 'knowledge_search', arguments: '{"q":"竞业"}' } },
    ]);
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ kind: '2N', months: 13 });
    expect(calls[0].body.tools).toEqual(tools);
  });
});

describe('各家请求体差异', () => {
  test('variant 参数（extraBody）在流式/带工具/非流式三条路径上都下发', async () => {
    const sse = 'data: [DONE]\n\n';
    const [fetchImpl, calls] = mockFetch(() => sseResponse(sse));
    // nothink 变体的请求参数，正常由 createProvider 从 VARIANT_REQUEST_PARAMS 查表注入
    const p = createDashScope({ apiKey: 'k', model: 'qwen3.6-flash', extraBody: { enable_thinking: false }, fetchImpl });

    await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    await drain(
      await p.chatStream([{ role: 'user', content: 'x' }], {
        tools: [{ type: 'function', function: { name: 't', parameters: {} } }],
      }),
    );
    await p.chatJSON!([{ role: 'user', content: 'x' }]).catch(() => {});
    expect(calls.map((c) => c.body.enable_thinking)).toEqual([false, false, false]);
  });

  test('没有 variant 就不下发厂商私有字段', async () => {
    const [fetchImpl, calls] = mockFetch(() => sseResponse('data: [DONE]\n\n'));
    const p = createDashScope({ apiKey: 'k', model: 'qwen3.6-flash', fetchImpl });
    await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(calls[0].body).not.toHaveProperty('enable_thinking');
  });

  test('billingModel 缺省退回 api 串（只应发生在单测里）', async () => {
    const [fetchImpl] = mockFetch(() => sseResponse('data: [DONE]\n\n'));
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });
    expect(p.billingModel).toBe('deepseek-v4-pro');
  });

  test('三家端点与鉴权头正确，且 stream_options 一律要 usage', async () => {
    const sse = 'data: [DONE]\n\n';
    const cases = [
      [createDeepSeek, 'https://api.deepseek.com/v1/chat/completions'],
      [createOpenAI, 'https://api.openai.com/v1/chat/completions'],
      [createDashScope, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'],
    ] as const;
    for (const [make, url] of cases) {
      const [fetchImpl, calls] = mockFetch(() => sseResponse(sse));
      await drain(await make({ apiKey: 'sk-test', model: 'm', fetchImpl }).chatStream([{ role: 'user', content: 'x' }]));
      expect(calls[0].url).toBe(url);
      expect(calls[0].headers.authorization).toBe('Bearer sk-test');
      expect(calls[0].body.stream).toBe(true);
      expect(calls[0].body.stream_options).toEqual({ include_usage: true });
    }
  });

  test('baseUrl 可覆盖（自建网关/单测桩）', async () => {
    const [fetchImpl, calls] = mockFetch(() => sseResponse('data: [DONE]\n\n'));
    const p = createOpenAI({ apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1:9/v1', fetchImpl });
    await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(calls[0].url).toBe('http://127.0.0.1:9/v1/chat/completions');
  });

  test('temperature / maxTokens 不传就不下发（新模型收到会 400）', async () => {
    const [fetchImpl, calls] = mockFetch(() => sseResponse('data: [DONE]\n\n'));
    const p = createOpenAI({ apiKey: 'k', model: 'm', fetchImpl });
    await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    await drain(await p.chatStream([{ role: 'user', content: 'x' }], { temperature: 0.3, maxTokens: 512 }));
    expect(calls[0].body).not.toHaveProperty('temperature');
    expect(calls[0].body).not.toHaveProperty('max_tokens');
    expect(calls[1].body.temperature).toBe(0.3);
    expect(calls[1].body.max_tokens).toBe(512);
  });
});

describe('错误与非流式小调用', () => {
  test('非 2xx 在 await chatStream 时就抛，带状态码与响应体片段', async () => {
    const [fetchImpl] = mockFetch(() => new Response('{"error":{"message":"insufficient balance"}}', { status: 402 }));
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });
    await expect(p.chatStream([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 402[\s\S]*insufficient balance/);
  });

  test('chatJSON 剥掉 ```json 围栏并截取花括号，usage 照样回报', async () => {
    const [fetchImpl, calls] = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '```json\n{"intent":"仲裁时效"}\n```' } }],
            usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-flash', billingModel: 'DeepSeek-V4-Flash-0731', fetchImpl });

    let usage: { model: string; usage: { prompt: number | null } } | undefined;
    const raw = await p.chatJSON!([{ role: 'user', content: '分类' }], { onUsage: (u) => (usage = u) });
    expect(JSON.parse(raw)).toEqual({ intent: '仲裁时效' });
    expect(usage?.usage.prompt).toBe(30);
    expect(usage?.model).toBe('DeepSeek-V4-Flash-0731');
    expect(calls[0].body.stream).toBe(false);
    expect(calls[0].body.temperature).toBe(0);
  });

  test('chatJSON 空响应抛错，不返回空串让上层 JSON.parse 炸在别处', async () => {
    const [fetchImpl] = mockFetch(
      () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }),
    );
    const p = createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-flash', fetchImpl });
    await expect(p.chatJSON!([{ role: 'user', content: 'x' }])).rejects.toThrow(/空响应/);
  });
});

// 上游把预算全烧在思考链上、正文一个字没出来时，解析器原先照常交出
// {finishReason:'length', 正文空}，上层当正常一轮收尾并落库计费——用户等了几分钟拿到一片空白，
// 系统却认为这次成功了。空回复对用户就是失败，必须是错误（判据见 sse.assertTruncatedNotEmpty）。
describe('流式空回：length 截断 + 空正文 = 失败，不是正常收尾', () => {
  const emptyLength = dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
  const deepseek = (fetchImpl: typeof fetch) => createDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl });
  /** 收干并交出错误（成功则为 null）——要断言错误正文，不能只判抛没抛 */
  const drainErr = async (p: ReturnType<typeof deepseek>) =>
    drain(await p.chatStream([{ role: 'user', content: 'x' }])).then(
      () => null,
      (e: unknown) => e as Error,
    );

  test('🔑 空正文 + finish_reason=length → 抛错，不静默返回空', async () => {
    const [fetchImpl] = mockFetch(() => sseResponse(emptyLength + 'data: [DONE]\n\n'));
    const err = await drainErr(deepseek(fetchImpl));
    // 三段式：缺什么（连同是哪家哪个型号）/ 为什么缺 / 怎么办
    expect(err?.message).toMatch(/^缺：deepseek\(deepseek-v4-pro\) 本轮的回复正文/);
    expect(err?.message).toMatch(/finish_reason=length/);
    expect(err?.message).toMatch(/原因：[\s\S]*预算/);
    expect(err?.message).toMatch(/怎么办：/);
  });

  test('🔑 思考链吃满预算（reasoning 有字、正文没字）—— 线上就是这个形态', async () => {
    const sse =
      dataLine({ choices: [{ index: 0, delta: { reasoning_content: '先看时效，再算 2N……' } }] }) +
      emptyLength +
      dataLine({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 8000 } }) +
      'data: [DONE]\n\n';
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    expect((await drainErr(deepseek(fetchImpl)))?.message).toMatch(/finish_reason=length/);
  });

  test('仅空白正文也算空（几个换行不是回复）', async () => {
    const sse = textDelta('  ') + textDelta('\n\n') + emptyLength + 'data: [DONE]\n\n';
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    expect((await drainErr(deepseek(fetchImpl)))?.message).toMatch(/finish_reason=length/);
  });

  test('流末无 [DONE] 的那条出口同样判（两个 return 出口都过判据）', async () => {
    const [fetchImpl] = mockFetch(() => sseResponse(emptyLength));
    expect((await drainErr(deepseek(fetchImpl)))?.message).toMatch(/finish_reason=length/);
  });

  // ── 以下三条是「不误伤」：长回复被截断、工具轮、模型自己决定不答，都不是本判据的对象 ──
  test('有正文的 length（长回复正常结束）照常交出，不误判为错', async () => {
    const [fetchImpl] = mockFetch(() => sseResponse(textDelta('半句话') + emptyLength + 'data: [DONE]\n\n'));
    const { text, result } = await drain(await deepseek(fetchImpl).chatStream([{ role: 'user', content: 'x' }]));
    expect(text).toBe('半句话');
    expect(result.finishReason).toBe('length');
  });

  test('正文空但拼出了工具调用 → 不抛：那一轮对用户不是空回复，tool-loop 还要往下走', async () => {
    const sse =
      dataLine({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'knowledge_search', arguments: '{"q":"时效"}' } }] } },
        ],
      }) +
      emptyLength +
      'data: [DONE]\n\n';
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const { result } = await drain(await deepseek(fetchImpl).chatStream([{ role: 'user', content: 'x' }]));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.finishReason).toBe('length');
  });

  test('空正文但结束原因不是 length（stop / refusal）→ 不抛：只有被截断才值得重来', async () => {
    for (const reason of ['stop', 'refusal']) {
      const sse = dataLine({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }) + 'data: [DONE]\n\n';
      const [fetchImpl] = mockFetch(() => sseResponse(sse));
      const { text, result } = await drain(await deepseek(fetchImpl).chatStream([{ role: 'user', content: 'x' }]));
      expect(text).toBe('');
      expect(result.finishReason).toBe(reason);
    }
  });
});
