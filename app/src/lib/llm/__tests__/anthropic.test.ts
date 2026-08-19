// app/src/lib/llm/__tests__/anthropic.test.ts
// Anthropic Messages API 原生 SSE。本机没有 ANTHROPIC_API_KEY，全部 mock，不做真调用。
// 两块重点：①统一消息形态 → Anthropic 请求体的转换（system 提顶层、工具结果并轮）；
// ②事件流解析与计量（input 在流首、output 在流末，缓存量单列）。
import { describe, test, expect } from 'vitest';
import { createAnthropic, toAnthropicRequest, toAnthropicTools } from '../providers/anthropic';
import { drain, mockFetch, sseResponse } from './mock-fetch';

const ev = (o: unknown) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}\n\n`;

/** 一条最小的完整流：message_start → 文本块 → message_delta → message_stop */
function textStream(texts: string[], stopReason = 'end_turn') {
  return (
    ev({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 2100, output_tokens: 1 } } }) +
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    texts.map((t) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })).join('') +
    ev({ type: 'content_block_stop', index: 0 }) +
    ev({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 512 } }) +
    ev({ type: 'message_stop' })
  );
}

describe('toAnthropicRequest 消息形态转换', () => {
  test('system 轮提到顶层字段，多条按序拼接', () => {
    const r = toAnthropicRequest([
      { role: 'system', content: '你是劳动仲裁陪跑助手。' },
      { role: 'system', content: '默认北京朝阳口径。' },
      { role: 'user', content: '公司让我签自愿离职' },
    ]);
    expect(r.system).toBe('你是劳动仲裁陪跑助手。\n\n默认北京朝阳口径。');
    expect(r.messages).toEqual([{ role: 'user', content: '公司让我签自愿离职' }]);
  });

  test('assistant 的 tool_calls 变成 tool_use 块，arguments 由字符串 parse 成对象', () => {
    const r = toAnthropicRequest([
      { role: 'user', content: '算 2N' },
      {
        role: 'assistant',
        content: '我来算。',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'claim_calc', arguments: '{"kind":"2N"}' } }],
      },
    ]);
    expect(r.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: '我来算。' },
        { type: 'tool_use', id: 'toolu_1', name: 'claim_calc', input: { kind: '2N' } },
      ],
    });
  });

  test('连续多条 tool 结果并进同一个 user 轮（拆开会被 API 拒）', () => {
    const r = toAnthropicRequest([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'toolu_2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: '结果A' },
      { role: 'tool', tool_call_id: 'toolu_2', content: '结果B' },
      { role: 'user', content: '继续' },
    ]);
    expect(r.messages).toHaveLength(4); // user / assistant(2 tool_use) / user(2 tool_result) / user
    expect(r.messages[1].content).toHaveLength(2); // 纯工具轮无正文块
    expect(r.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '结果A' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: '结果B' },
      ],
    });
    expect(r.messages[3]).toEqual({ role: 'user', content: '继续' });
  });

  test('空 arguments 转成 {}；畸形 arguments 就地报错并点名工具', () => {
    const mk = (args: string) => [
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'x', type: 'function' as const, function: { name: 'deadline_list', arguments: args } }] },
    ];
    expect(toAnthropicRequest(mk('')).messages[0].content).toEqual([
      { type: 'tool_use', id: 'x', name: 'deadline_list', input: {} },
    ]);
    expect(() => toAnthropicRequest(mk('{"a":'))).toThrow(/deadline_list.*不是合法 JSON/);
  });

  test('role=tool 缺 tool_call_id 直接报错，不静默丢结果', () => {
    expect(() => toAnthropicRequest([{ role: 'tool', content: '结果' }])).toThrow(/缺 tool_call_id/);
  });

  test('ToolDef → Anthropic 工具定义（parameters 即 input_schema）', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    expect(toAnthropicTools([{ type: 'function', function: { name: 'knowledge_search', description: '检索法条', parameters: schema } }])).toEqual([
      { name: 'knowledge_search', description: '检索法条', input_schema: schema },
    ]);
  });
});

describe('chatStream 事件流解析', () => {
  test('text_delta 拼成正文，stop_reason 映射到统一词表，计量取自流首+流末', async () => {
    const [fetchImpl, calls] = mockFetch(() => sseResponse(textStream(['根据《劳动合同法》', '第八十七条，'], 'end_turn'), 9));
    const p = createAnthropic({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', billingModel: 'claude-sonnet-5', fetchImpl });

    const seen: unknown[] = [];
    const { text, result } = await drain(
      await p.chatStream([{ role: 'system', content: 'S' }, { role: 'user', content: '违法解除赔多少' }], {
        onUsage: (u) => seen.push(u),
      }),
    );

    expect(text).toBe('根据《劳动合同法》第八十七条，');
    expect(result.finishReason).toBe('stop'); // end_turn → stop
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({
      model: 'claude-sonnet-5',
      usage: {
        prompt: 2100,
        completion: 512, // message_delta 的最终值，覆盖 message_start 里的 1
        cachedRead: null,
        cachedWrite: null,
      },
    });
    expect(seen).toEqual([result.usage]);

    // 请求体：system 走顶层、max_tokens 必填有默认、thinking 显式开
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers['x-api-key']).toBe('sk-ant-test');
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].body.system).toBe('S');
    expect(calls[0].body.max_tokens).toBe(4096);
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(calls[0].body).not.toHaveProperty('temperature'); // Claude 5 系传采样参数会 400
  });

  test('缓存读写分列两桶，prompt 桶不含缓存部分', async () => {
    const sse =
      ev({
        type: 'message_start',
        message: { usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 8000, cache_creation_input_tokens: 1500 } },
      }) +
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 300 } }) +
      ev({ type: 'message_stop' });
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createAnthropic({ apiKey: 'k', model: 'claude-sonnet-5', fetchImpl });

    const { result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    // Anthropic 的 input_tokens 天然不含缓存读写，四桶直接对上，无需减法
    expect(result.usage.usage).toEqual({ prompt: 120, completion: 300, cachedRead: 8000, cachedWrite: 1500 });
  });

  test('thinking_delta 不进正文，走 onReasoning 累计', async () => {
    const sse =
      ev({ type: 'message_start', message: { usage: { input_tokens: 10 } } }) +
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }) +
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先查时效' } }) +
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } }) +
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }) +
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '结论' } }) +
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) +
      ev({ type: 'message_stop' });
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createAnthropic({ apiKey: 'k', model: 'claude-sonnet-5', fetchImpl });

    const seen: number[] = [];
    const { text } = await drain(await p.chatStream([{ role: 'user', content: 'x' }], { onReasoning: (n) => seen.push(n) }));
    expect(text).toBe('结论');
    expect(seen).toEqual([4]);
  });

  test('tool_use 块：id/name 在 content_block_start，input_json_delta 分片拼成 arguments', async () => {
    const sse =
      ev({ type: 'message_start', message: { usage: { input_tokens: 50 } } }) +
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我查一下。' } }) +
      ev({ type: 'content_block_stop', index: 0 }) +
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'knowledge_search' } }) +
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } }) +
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"竞业限制补偿"}' } }) +
      ev({ type: 'content_block_stop', index: 1 }) +
      ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 88 } }) +
      ev({ type: 'message_stop' });
    const [fetchImpl, calls] = mockFetch(() => sseResponse(sse, 13));
    const p = createAnthropic({ apiKey: 'k', model: 'claude-sonnet-5', fetchImpl });

    const { text, result } = await drain(
      await p.chatStream([{ role: 'user', content: '竞业补偿怎么算' }], {
        tools: [{ type: 'function', function: { name: 'knowledge_search', parameters: { type: 'object' } } }],
      }),
    );

    expect(text).toBe('我查一下。');
    expect(result.finishReason).toBe('tool_calls'); // tool_use → tool_calls
    expect(result.toolCalls).toEqual([
      { id: 'toolu_01', type: 'function', function: { name: 'knowledge_search', arguments: '{"q":"竞业限制补偿"}' } },
    ]);
    expect(calls[0].body.tools).toEqual([{ name: 'knowledge_search', description: undefined, input_schema: { type: 'object' } }]);
  });

  test('stop_reason 映射表：max_tokens→length，refusal 原样透出', async () => {
    for (const [raw, mapped] of [
      ['max_tokens', 'length'],
      ['stop_sequence', 'stop'],
      ['refusal', 'refusal'],
      ['某个还没见过的原因', '某个还没见过的原因'],
    ] as const) {
      const [fetchImpl] = mockFetch(() => sseResponse(textStream(['x'], raw)));
      const p = createAnthropic({ apiKey: 'k', model: 'claude-sonnet-5', fetchImpl });
      const { result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
      expect(result.finishReason).toBe(mapped);
    }
  });

  test('流内 error 事件抛错（HTTP 已 200，错误藏在流里）', async () => {
    const sse =
      ev({ type: 'message_start', message: { usage: { input_tokens: 10 } } }) +
      ev({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createAnthropic({ apiKey: 'k', model: 'claude-sonnet-5', fetchImpl });

    const gen = await p.chatStream([{ role: 'user', content: 'x' }]);
    await expect(drain(gen)).rejects.toThrow(/overloaded_error.*Overloaded/);
  });

  test('非 2xx 在 await 时抛，带状态码与响应体片段', async () => {
    const [fetchImpl] = mockFetch(
      () => new Response('{"type":"error","error":{"type":"authentication_error"}}', { status: 401 }),
    );
    const p = createAnthropic({ apiKey: 'bad', model: 'claude-sonnet-5', fetchImpl });
    await expect(p.chatStream([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 401[\s\S]*authentication_error/);
  });

  test('maxTokens 可覆盖默认 4096', async () => {
    const [fetchImpl, calls] = mockFetch(() => sseResponse(textStream(['x'])));
    const p = createAnthropic({ apiKey: 'k', model: 'claude-sonnet-5', fetchImpl });
    await drain(await p.chatStream([{ role: 'user', content: 'x' }], { maxTokens: 32000 }));
    expect(calls[0].body.max_tokens).toBe(32000);
  });

  test('刻意不提供 chatJSON（bulk 档恒不走 Claude，实现了就是死代码）', () => {
    const [fetchImpl] = mockFetch(() => sseResponse(''));
    expect(createAnthropic({ apiKey: 'k', model: 'claude-sonnet-5', fetchImpl }).chatJSON).toBeUndefined();
  });
});
