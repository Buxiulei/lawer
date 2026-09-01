// app/src/lib/llm/__tests__/relay.test.ts
// 中转 provider 的接线与计量。
//
// 【报文来源】本文件里的 usage / 错误报文**不是编的**，是 2026-08-31 在生产机上
// 对中转真实调用抓下来的原文（见交接的实测报告）。计量归一化这类事，靠读代码推断
// 「厂商大概会回什么字段」是最容易自我说服的地方——所以判据一律取原件。
import { describe, test, expect, afterEach } from 'vitest';
import { createRelay } from '../providers/relay';
import { httpError } from '../providers/sse';
import { createProvider } from '../providers';
import { MODELS } from '../routing.config';
import { drain, mockFetch, sseResponse } from './mock-fetch';

const dataLine = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const DONE = 'data: [DONE]\n\n';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('端点与凭据全走 env（代码里只有变量名）', () => {
  test('baseUrl 取自 RELAY_BASE_URL，key 取自 Authorization', async () => {
    process.env.RELAY_BASE_URL = 'https://relay.example/v1';
    const [fetchImpl, calls] = mockFetch(() => sseResponse(DONE));
    const p = createRelay({ apiKey: 'sk-relay-test', model: 'claude-sonnet-5', fetchImpl });
    await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(calls[0].url).toBe('https://relay.example/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer sk-relay-test');
    expect(calls[0].body.stream_options).toEqual({ include_usage: true });
  });

  test('端点末尾多带斜杠会被归一（运维粘贴时的常见手滑）', async () => {
    process.env.RELAY_BASE_URL = 'https://relay.example/v1//';
    const [fetchImpl, calls] = mockFetch(() => sseResponse(DONE));
    await drain(await createRelay({ apiKey: 'k', model: 'm', fetchImpl }).chatStream([{ role: 'user', content: 'x' }]));
    expect(calls[0].url).toBe('https://relay.example/v1/chat/completions');
  });

  test('端点缺失 → 三段式错（缺什么/为什么缺/怎么办），不是一句 fetch failed', () => {
    delete process.env.RELAY_BASE_URL;
    expect(() => createRelay({ apiKey: 'k', model: 'm' })).toThrow(/RELAY_BASE_URL 未配置/);
    expect(() => createRelay({ apiKey: 'k', model: 'm' })).toThrow(/代码里只有变量名/);
    expect(() => createRelay({ apiKey: 'k', model: 'm' })).toThrow(/RELAY_BASE_URL=<中转的 OpenAI 兼容根地址/);
  });

  test('显式传 baseUrl 时不读 env（单测桩不该被迫先配环境变量）', async () => {
    delete process.env.RELAY_BASE_URL;
    const [fetchImpl, calls] = mockFetch(() => sseResponse(DONE));
    const p = createRelay({ apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1:9/v1', fetchImpl });
    await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(calls[0].url).toBe('http://127.0.0.1:9/v1/chat/completions');
  });
});

describe('usage 四桶：中转的 claude 有缓存写入档', () => {
  /** 2026-08-31 实测 opus 非流式原文：prompt 813 = cached_read 757 + cache_write 54 + 新鲜 2 */
  test('opus 真实样本：cache_write 单独成桶，不并进 prompt 按 1.0× 少收', async () => {
    const sse =
      dataLine({
        choices: [],
        usage: {
          prompt_tokens: 813,
          completion_tokens: 6,
          prompt_tokens_details: { cached_tokens: 757, cache_write_tokens: 54, claude_cache_creation_5_m_tokens: 54 },
        },
      }) + DONE;
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createRelay({ apiKey: 'k', model: 'claude-opus-5', baseUrl: 'http://x/v1', fetchImpl });
    const { result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    // 三桶相加必须还原回中转报的 prompt_tokens——这是「四桶互斥」的算术定义
    const u = result.usage.usage;
    expect(u).toEqual({ prompt: 2, completion: 6, cachedRead: 757, cachedWrite: 54 });
    expect((u.prompt ?? 0) + (u.cachedRead ?? 0) + (u.cachedWrite ?? 0)).toBe(813);
  });

  /** 2026-08-31 实测 sonnet 非流式原文：75 = 33 + 30 + 12 */
  test('sonnet 真实样本：另一组独立数字，算术同样自洽', async () => {
    const sse =
      dataLine({
        choices: [],
        usage: {
          prompt_tokens: 75,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 33, cache_write_tokens: 30 },
        },
      }) + DONE;
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createRelay({ apiKey: 'k', model: 'claude-sonnet-5', baseUrl: 'http://x/v1', fetchImpl });
    const { result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(result.usage.usage).toEqual({ prompt: 12, completion: 3, cachedRead: 33, cachedWrite: 30 });
  });

  test('cache_write 挂在顶层裸字段（而非 prompt_tokens_details 下）也认', async () => {
    // 中转两种写法都出现过；只认一处的话另一处就会被静默当成普通输入。
    const sse =
      dataLine({
        choices: [],
        usage: { prompt_tokens: 1204, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 0 }, cache_write_tokens: 1202 },
      }) + DONE;
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createRelay({ apiKey: 'k', model: 'claude-opus-5', baseUrl: 'http://x/v1', fetchImpl });
    const { result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(result.usage.usage).toEqual({ prompt: 2, completion: 9, cachedRead: 0, cachedWrite: 1202 });
  });

  test('没有缓存写入档时 cachedWrite 仍是 null，不用 0 冒充', async () => {
    // 直连三家结构性没有这个档。null 与 0 的区别是「厂商没有这一档」与「这一档真的是零」，
    // 记账侧对两者的处理不同（见 TokenUsage 铁律），不能在这里抹平。
    const sse = dataLine({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } }) + DONE;
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createRelay({ apiKey: 'k', model: 'gpt-4o-mini', baseUrl: 'http://x/v1', fetchImpl });
    const { result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(result.usage.usage).toEqual({ prompt: 100, completion: 5, cachedRead: null, cachedWrite: null });
  });

  /** 2026-08-31 实测 deepseek 经中转的 usage：prompt_tokens=62 而 prompt_cache_hit_tokens=128，
   *  「命中量大于总输入量」。这批数字对不上账，但它绝不能把 prompt 桶算成负数。 */
  test('中转的 deepseek 自相矛盾 usage：prompt 夹到 0，账本不出现负成本', async () => {
    const sse =
      dataLine({
        choices: [],
        usage: { prompt_tokens: 62, completion_tokens: 12, prompt_cache_hit_tokens: 128, prompt_tokens_details: { cached_tokens: 128 } },
      }) + DONE;
    const [fetchImpl] = mockFetch(() => sseResponse(sse));
    const p = createRelay({ apiKey: 'k', model: 'deepseek-v4-pro', baseUrl: 'http://x/v1', fetchImpl });
    const { result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    // 负数桶乘以费率就是负成本 = 倒贴公道值给用户。宁可记 0。
    expect(result.usage.usage.prompt).toBe(0);
    expect(result.usage.usage.prompt).toBeGreaterThanOrEqual(0);
  });

  test('四桶全 null 只在整条流没回 usage 时出现（该情形由记账侧兜底，不在这里假装有数）', async () => {
    const [fetchImpl] = mockFetch(() => sseResponse(dataLine({ choices: [{ index: 0, delta: { content: 'a' } }] }) + DONE));
    const p = createRelay({ apiKey: 'k', model: 'claude-sonnet-5', baseUrl: 'http://x/v1', fetchImpl });
    const { result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(result.usage.usage).toEqual({ prompt: null, completion: null, cachedRead: null, cachedWrite: null });
  });
});

describe('SSE 与 tool_calls：中转报文形态与现有解析器兼容', () => {
  /** 实测：中转经 AWS Bedrock 渠道的 opus 会把首个 tool_call 的 index 报成 1 而不是 0。
   *  累积数组因此是稀疏的（0 号是洞），压实逻辑必须跳洞而不是产出一条空调用。 */
  test('tool_call 的 index 从 1 起（非 0）也能拼出一条合法调用', async () => {
    const sse =
      dataLine({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'toolu_bdrk_01', function: { name: 'knowledge_search', arguments: '{"q":' } }] } }],
      }) +
      dataLine({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"违法解除"}' } }] } }] }) +
      dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      DONE;
    const [fetchImpl] = mockFetch(() => sseResponse(sse, 5));
    const p = createRelay({ apiKey: 'k', model: 'claude-opus-5', baseUrl: 'http://x/v1', fetchImpl });
    const { result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toHaveLength(1); // 0 号的洞不能变成一条空调用
    expect(result.toolCalls[0].id).toBe('toolu_bdrk_01');
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ q: '违法解除' });
  });

  test('末帧 usage（choices 为空）不会被当成正文帧丢弃或报错', async () => {
    const sse =
      dataLine({ choices: [{ index: 0, delta: { content: '好' } }] }) +
      dataLine({ choices: [], usage: { prompt_tokens: 75, completion_tokens: 1 } }) +
      DONE;
    const [fetchImpl] = mockFetch(() => sseResponse(sse, 5));
    const p = createRelay({ apiKey: 'k', model: 'claude-sonnet-5', baseUrl: 'http://x/v1', fetchImpl });
    const { text, result } = await drain(await p.chatStream([{ role: 'user', content: 'x' }]));
    expect(text).toBe('好');
    expect(result.usage.usage.completion).toBe(1);
  });

  /** 中转的 claude 思考链恒开，最容易出现「预算全烧在思考上、正文一个字没出来」。
   *  这一轮对用户就是失败，不能当正常收尾交出去（判据见 sse.assertTruncatedNotEmpty）。 */
  test('🔑 length 截断且正文为空 → 抛错，中转这条腿也不放过', async () => {
    const sse = dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) + DONE;
    const [fetchImpl] = mockFetch(() => sseResponse(sse, 5));
    const p = createRelay({ apiKey: 'k', model: 'claude-opus-5', baseUrl: 'http://x/v1', fetchImpl });
    await expect(drain(await p.chatStream([{ role: 'user', content: 'x' }]))).rejects.toThrow(
      /relay\(claude-opus-5\)[\s\S]*finish_reason=length/,
    );
  });
});

describe('错误报文：503 必须还认得出是哪个模型没了', () => {
  /** 实测 503 原文的形状：前面一大段是对**所有** 503 都一模一样的分组名清单，
   *  真正的判据（哪个模型 + 无可用渠道）在末尾。只保头的话每条 503 长得完全相同。 */
  const longBody = (model: string) =>
    `{"error":{"message":"分组 ${Array.from({ length: 120 }, (_, i) => `分组名${i}`).join('、')} ` +
    `下模型 ${model} 无可用渠道（distributor） (request id: 2026083101)"}}`;

  test('超长报文保头保尾：模型名与「无可用渠道」判据都留得住', async () => {
    const body = longBody('claude-opus-5');
    expect(body.length).toBeGreaterThan(500); // 前提：这条确实触发截断
    const msg = (await httpError('relay(claude-opus-5) chatStream', new Response(body, { status: 503 }))).message;
    expect(msg).toMatch(/HTTP 503/);
    expect(msg).toContain('claude-opus-5'); // 是哪个模型掉了
    expect(msg).toContain('无可用渠道'); // 该换腿，还是该重试
    expect(msg).toContain('分组 分组名0'); // 头部也还在
    expect(msg).toMatch(/略 \d+ 字/); // 中间确实截了，没把整段灌进日志
  });

  test('只保头会让两个不同模型的 503 变成同一条日志——本用例钉住这不再发生', async () => {
    // 这是旧写法（body.slice(0,200)）的实际后果：截出来的全是分组名，两条完全相同。
    const a = (await httpError('t', new Response(longBody('claude-opus-5'), { status: 503 }))).message;
    const b = (await httpError('t', new Response(longBody('claude-sonnet-5'), { status: 503 }))).message;
    expect(a).not.toBe(b);
    expect(a.slice(0, 200)).toBe(b.slice(0, 200)); // 头部确实一样，可分辨性全靠尾部
  });

  test('实测那条 503（分组名多为中文，约 280 字）整条都留得住', async () => {
    // 保头 200 + 保尾 300 = 500 字。实测报文 746 **字节**、中文占多数，折合约 280 字，
    // 落在阈值内 → 一个字都不截。这条钉的是「阈值对真实报文够用」，不是截断逻辑本身。
    const body =
      '{"error":{"message":"分组 default、限时体验、纯AZ、官转、MJ慢速、官转克劳德2、官转OpenAI、直连克劳德、限时特价、' +
      '官转克劳德3、优质gemini、官转gemini、优质官转OpenAI、Claude Code专属、Codex专属、official_Claude、企业级高可用大模型 ' +
      '下模型 claude-opus-9-nonexistent 无可用渠道（distributor） (request id: 2026083101)"}}';
    const msg = (await httpError('t', new Response(body, { status: 503 }))).message;
    expect(msg).toContain(body);
    expect(msg).not.toMatch(/略 \d+ 字/);
  });

  test(
    '端到端：中转 503 经闸的两次重试后，抛出的错仍带得出模型名与判据',
    async () => {
      // 503 在 gate.ts 里是可重试状态（1s + 4s 退避），所以这条要等满退避才拿到最终错误。
      // 值得等：它证明「重试用光之后上抛的那条错」——也就是运维真正会看到的那条——是可分类的。
      const [fetchImpl, calls] = mockFetch(() => new Response(longBody('claude-opus-5'), { status: 503 }));
      const p = createRelay({ apiKey: 'k', model: 'claude-opus-5', baseUrl: 'http://x/v1', fetchImpl });
      const err = await p.chatStream([{ role: 'user', content: 'x' }]).catch((e: Error) => e);
      expect(calls).toHaveLength(3); // 1 次 + 2 次重试
      expect((err as Error).message).toContain('无可用渠道');
      expect((err as Error).message).toContain('claude-opus-5');
    },
    15_000,
  );

  test('短报文原样保留，不会被截断标记污染', async () => {
    // 401 不可重试，立刻上抛（实测中转坏 key 就是这条：{"error":{"message":"无效的令牌 …"}}）
    const [fetchImpl] = mockFetch(() => new Response('{"error":{"message":"无效的令牌"}}', { status: 401 }));
    const p = createRelay({ apiKey: 'k', model: 'm', baseUrl: 'http://x/v1', fetchImpl });
    const err = await p.chatStream([{ role: 'user', content: 'x' }]).catch((e: Error) => e);
    expect((err as Error).message).toContain('无效的令牌');
    expect((err as Error).message).not.toMatch(/略 \d+ 字/);
  });
});

describe('中转按出境处理', () => {
  test('经 createProvider 建的中转客户端，请求体里没有身份证明文', async () => {
    // 中转出口 IP 实测在境外，且它代理的 Claude/GPT 本就是境外模型。
    // 漏加 OUTBOUND_PROVIDERS 不会有任何类型错误或既有用例报警——只会静默把原文发出境。
    const [fetchImpl, calls] = mockFetch(() => sseResponse(DONE));
    const client = createProvider(
      { provider: 'relay', model: MODELS.CLAUDE_SONNET },
      { apiKey: 'sk-test', baseUrl: 'http://x/v1', fetchImpl },
    );
    await drain(await client.chatStream([{ role: 'user', content: '身份证110101199003078888' }]));
    expect(JSON.stringify(calls[0].body)).not.toContain('110101199003078888');
    expect(JSON.stringify(calls[0].body)).toContain('〔身份证#1〕');
  });

  test('计费键与直连分家，且 model 参数仍是中转认的官方别名', () => {
    const client = createProvider(
      { provider: 'relay', model: MODELS.CLAUDE_OPUS },
      { apiKey: 'sk-test', baseUrl: 'http://x/v1' },
    );
    expect(client.model).toBe('claude-opus-5');
    expect(client.billingModel).toBe('relay/claude-opus-5');
  });

  test('境内型号经中转时 enable_thinking:false 照常下发（两百倍价的防线不能因为换了路就丢）', async () => {
    // 实测该参数经中转仍穿透到上游：qwen3.7-max completion 1（nothink）vs 42（think）。
    const [fetchImpl, calls] = mockFetch(() => sseResponse(DONE));
    const client = createProvider(
      { provider: 'relay', model: MODELS.QWEN_MAX, variant: 'nothink' },
      { apiKey: 'sk-test', baseUrl: 'http://x/v1', fetchImpl },
    );
    await drain(await client.chatStream([{ role: 'user', content: 'x' }]));
    expect(calls[0].body.enable_thinking).toBe(false);
    expect(client.billingModel).toBe('relay/qwen3.7-max:nothink');
  });
});
