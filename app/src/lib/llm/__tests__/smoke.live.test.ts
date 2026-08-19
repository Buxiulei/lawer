// app/src/lib/llm/__tests__/smoke.live.test.ts
// 真实供应商冒烟：验证「路由表里的 api 串真的能调通、usage 四桶真的有数」。
// mock 测得再全也证明不了型号名还在售、key 还有权限，这两件事只有真调一次才知道。
//
// **无 key 环境自动整段跳过**（CI、新克隆的机器、只配了部分 key 的开发机都不会红）。
// 跑之前要先把 .env.local 灌进环境：
//   set -a && . ./.env.local && set +a && npx vitest run src/lib/llm/__tests__/smoke.live.test.ts
// 单跑 `npm test` 不会加载 .env.local，所以默认就是跳过状态。
import { describe, test, expect } from 'vitest';
import { createProvider } from '../providers';
import { MODELS } from '../routing.config';
import type { RouteTarget } from '../routing.config';
import { drain } from './mock-fetch';

const has = (env: string) => !!process.env[env];

const CASES: { name: string; env: string; target: RouteTarget }[] = [
  { name: 'DeepSeek Pro（入门/中配 critical）', env: 'DEEPSEEK_API_KEY', target: { provider: 'deepseek', model: MODELS.DEEPSEEK_PRO } },
  { name: 'DeepSeek Flash（三档 bulk）', env: 'DEEPSEEK_API_KEY', target: { provider: 'deepseek', model: MODELS.DEEPSEEK_FLASH } },
  { name: 'Qwen Max（critical 末位兜底）', env: 'DASHSCOPE_API_KEY', target: { provider: 'dashscope', model: MODELS.QWEN_MAX, variant: 'nothink' } },
  { name: 'Qwen Flash（bulk 兜底）', env: 'DASHSCOPE_API_KEY', target: { provider: 'dashscope', model: MODELS.QWEN_FLASH, variant: 'nothink' } },
  { name: 'Claude Sonnet（中配 critical / 高配 standard）', env: 'ANTHROPIC_API_KEY', target: { provider: 'anthropic', model: MODELS.CLAUDE_SONNET } },
  { name: 'Claude Opus（高配 critical）', env: 'ANTHROPIC_API_KEY', target: { provider: 'anthropic', model: MODELS.CLAUDE_OPUS } },
];

for (const c of CASES) {
  describe.skipIf(!has(c.env))(c.name, () => {
    test(`${c.target.model.api} 流式可调通且四桶有数`, { timeout: 120_000 }, async () => {
      const p = createProvider(c.target);
      const seen: unknown[] = [];
      const { text, result } = await drain(
        await p.chatStream([{ role: 'user', content: '只回答两个字：收到' }], { onUsage: (u) => seen.push(u) }),
      );
      console.log(`[${c.target.model.api}] text=${JSON.stringify(text)} finish=${result.finishReason} usage=${JSON.stringify(result.usage)}`);
      expect(text.length).toBeGreaterThan(0);
      // 计量是计费的输入，冒烟的重点就是确认这两桶不是 null
      expect(result.usage.model).toBe(p.billingModel);
      expect(result.usage.usage.prompt).toBeGreaterThan(0);
      expect(result.usage.usage.completion).toBeGreaterThan(0);
      expect(seen).toEqual([result.usage]);
    });
  });
}

describe.skipIf(!has('DEEPSEEK_API_KEY'))('DeepSeek tool-calling 与 chatJSON', () => {
  test('真实 tool-calling：arguments 能拼成合法 JSON', { timeout: 120_000 }, async () => {
    const p = createProvider({ provider: 'deepseek', model: MODELS.DEEPSEEK_PRO });
    const { result } = await drain(
      await p.chatStream([{ role: 'user', content: '北京朝阳今天天气如何？用工具查。' }], {
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: '查询某地天气',
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            },
          },
        ],
      }),
    );
    console.log(`[tools] finish=${result.finishReason} calls=${JSON.stringify(result.toolCalls)}`);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toHaveLength(1);
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toHaveProperty('city');
  });

  test('真实 chatJSON：围栏剥离后是合法 JSON', { timeout: 60_000 }, async () => {
    const p = createProvider({ provider: 'deepseek', model: MODELS.DEEPSEEK_FLASH });
    const raw = await p.chatJSON!([
      { role: 'system', content: '只输出 JSON，形如 {"intent":"..."}，不要解释。' },
      { role: 'user', content: '公司让我签自愿离职协议，我该签吗' },
    ]);
    console.log(`[chatJSON] raw=${raw}`);
    expect(JSON.parse(raw)).toHaveProperty('intent');
  });
});

describe.skipIf(!has('DASHSCOPE_API_KEY'))('variant 的真实计费影响', () => {
  test('nothink 变体确实关掉了思考链（开思考实测多烧两百倍输出 token）', { timeout: 120_000 }, async () => {
    const nothink = createProvider({ provider: 'dashscope', model: MODELS.QWEN_FLASH, variant: 'nothink' });
    const think = createProvider({ provider: 'dashscope', model: MODELS.QWEN_FLASH, variant: 'think' });
    const msg = [{ role: 'user' as const, content: '只回答两个字：收到' }];
    const a = await drain(await nothink.chatStream(msg));
    const b = await drain(await think.chatStream(msg));
    console.log(`[variant] nothink completion=${a.result.usage.usage.completion} think completion=${b.result.usage.usage.completion}`);
    expect(a.result.usage.model).toBe('qwen3.6-flash:nothink');
    expect(b.result.usage.model).toBe('qwen3.6-flash:think');
    expect(a.result.usage.usage.completion!).toBeLessThan(b.result.usage.usage.completion!);
  });
});
