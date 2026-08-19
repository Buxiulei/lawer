// app/src/lib/llm/__tests__/router.test.ts
// 路由矩阵是钱的开关：走错档要么让高配用户吃 DeepSeek，要么让入门用户烧 Claude。
// 三套餐 × 三档位九格全部逐格断言，不用循环糊过去——改表时必须有人逐格看一遍。
// 另外三条性质各有专门用例：降级只能向下；qwen 目标必须钉 variant；计费键锁 dated 串。
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { route, getProvider } from '../router';
import { DEGRADE_CHAIN, MODELS, ROUTING_TABLE, VARIANT_REQUEST_PARAMS, billingKey } from '../routing.config';
import type { Plan, RouteTarget, TaskClass } from '../routing.config';
import type { ProviderName } from '../types';

const OPUS: RouteTarget = { provider: 'anthropic', model: MODELS.CLAUDE_OPUS };
const SONNET: RouteTarget = { provider: 'anthropic', model: MODELS.CLAUDE_SONNET };
const DS_PRO: RouteTarget = { provider: 'deepseek', model: MODELS.DEEPSEEK_PRO };
const DS_FLASH: RouteTarget = { provider: 'deepseek', model: MODELS.DEEPSEEK_FLASH };
const QWEN_MAX: RouteTarget = { provider: 'dashscope', model: MODELS.QWEN_MAX, variant: 'nothink' };
const QWEN_FLASH: RouteTarget = { provider: 'dashscope', model: MODELS.QWEN_FLASH, variant: 'nothink' };

/** 矩阵用例要的是「表长什么样」，与本机有没有 key 无关，所以把可用性钉死为全可用。 */
const allUp = { isAvailable: () => true };
/** 只有列出的 provider 有 key */
const only = (...ups: ProviderName[]) => ({ isAvailable: (p: ProviderName) => ups.includes(p) });

/** 遍历路由表与降级链上的全部目标 */
function allTargets(): { where: string; target: RouteTarget }[] {
  const out: { where: string; target: RouteTarget }[] = [];
  for (const [plan, byClass] of Object.entries(ROUTING_TABLE)) {
    for (const [tc, target] of Object.entries(byClass)) out.push({ where: `ROUTING_TABLE.${plan}.${tc}`, target });
  }
  for (const [tc, chain] of Object.entries(DEGRADE_CHAIN)) {
    chain.forEach((target, i) => out.push({ where: `DEGRADE_CHAIN.${tc}[${i}]`, target }));
  }
  return out;
}

describe('route 三套餐 × 三档位矩阵（spec D3 / §9）', () => {
  test('入门：全 DeepSeek，一分 Claude 不用', () => {
    expect(route('critical', 'entry', allUp)).toEqual({ ...DS_PRO, degraded: false });
    expect(route('standard', 'entry', allUp)).toEqual({ ...DS_PRO, degraded: false });
    expect(route('bulk', 'entry', allUp)).toEqual({ ...DS_FLASH, degraded: false });
  });

  test('中配：只有 critical 升 Claude，且只升到 Sonnet 档', () => {
    expect(route('critical', 'standard', allUp)).toEqual({ ...SONNET, degraded: false });
    expect(route('standard', 'standard', allUp)).toEqual({ ...DS_PRO, degraded: false });
    expect(route('bulk', 'standard', allUp)).toEqual({ ...DS_FLASH, degraded: false });
  });

  test('高配：standard 走 Sonnet 主力，critical 再升一档到 Opus', () => {
    expect(route('critical', 'pro', allUp)).toEqual({ ...OPUS, degraded: false });
    expect(route('standard', 'pro', allUp)).toEqual({ ...SONNET, degraded: false });
    expect(route('bulk', 'pro', allUp)).toEqual({ ...DS_FLASH, degraded: false });
  });

  test('bulk 三档恒不走 Claude（毛利红线）', () => {
    for (const plan of ['entry', 'standard', 'pro'] as Plan[]) {
      expect(route('bulk', plan, allUp).provider).not.toBe('anthropic');
    }
  });

  test('Claude 用量随套餐单调不减，且 Opus 只出现在高配 critical', () => {
    const claudeCount = (plan: Plan) =>
      (['critical', 'standard', 'bulk'] as TaskClass[]).filter((tc) => route(tc, plan, allUp).provider === 'anthropic').length;
    expect(claudeCount('entry')).toBe(0);
    expect(claudeCount('standard')).toBe(1);
    expect(claudeCount('pro')).toBe(2);

    const opusCells = (['entry', 'standard', 'pro'] as Plan[]).flatMap((plan) =>
      (['critical', 'standard', 'bulk'] as TaskClass[])
        .filter((tc) => route(tc, plan, allUp).model.api === MODELS.CLAUDE_OPUS.api)
        .map((tc) => `${plan}/${tc}`),
    );
    expect(opusCells).toEqual(['pro/critical']);
  });

  test('未知套餐/档位报错，不静默落默认档', () => {
    expect(() => route('critical', 'vip' as Plan, allUp)).toThrow(/未知套餐档 plan=vip/);
    expect(() => route('urgent' as TaskClass, 'pro', allUp)).toThrow(/未知任务档 task_class=urgent/);
  });
});

describe('型号锁定与计费键（manager 2026-08-19 硬约束 1 & 2）', () => {
  test('路由表与降级链上的型号都来自 MODELS 常量，不许散落字面量', () => {
    const allowed = new Set<string>(Object.values(MODELS).map((m) => m.api));
    for (const { where, target } of allTargets()) {
      expect(allowed.has(target.model.api), `${where} 用了表外型号`).toBe(true);
    }
  });

  test('DeepSeek 计费键锁 C01 的 dated 产品名，而 API 串是别名（实测 dated 串会 400）', () => {
    expect(MODELS.DEEPSEEK_PRO).toEqual({ api: 'deepseek-v4-pro', priced: 'DeepSeek-V4-Pro-0813' });
    expect(MODELS.DEEPSEEK_FLASH).toEqual({ api: 'deepseek-v4-flash', priced: 'DeepSeek-V4-Flash-0731' });
    expect(billingKey(DS_PRO)).toBe('DeepSeek-V4-Pro-0813');
  });

  test('Anthropic 的 id 本就不带日期，api 与 priced 相同（加日期后缀会 400）', () => {
    expect(MODELS.CLAUDE_OPUS.api).toBe(MODELS.CLAUDE_OPUS.priced);
    expect(MODELS.CLAUDE_SONNET.api).toBe(MODELS.CLAUDE_SONNET.priced);
    expect(MODELS.CLAUDE_OPUS.api).not.toMatch(/\d{8}|\d{4}-\d{2}-\d{2}/);
  });

  test('带 variant 的目标，计费键拼成 model:variant', () => {
    expect(billingKey(QWEN_FLASH)).toBe('qwen3.6-flash:nothink');
    expect(billingKey(QWEN_MAX)).toBe('qwen3.7-max:nothink');
  });

  test('不带 variant 的目标，计费键就是 priced 串', () => {
    expect(billingKey(SONNET)).toBe('claude-sonnet-5');
    expect(billingKey(DS_FLASH)).toBe('DeepSeek-V4-Flash-0731');
  });

  test('每个 dashscope 目标都必须钉 variant，否则会退回 qwen 默认开思考的两百倍价', () => {
    for (const { where, target } of allTargets()) {
      if (target.provider === 'dashscope') {
        expect(target.variant, `${where} 的 qwen 目标没钉 variant`).toBeDefined();
      }
    }
  });

  test('标了 variant 就必须在 VARIANT_REQUEST_PARAMS 里有映射', () => {
    for (const { where, target } of allTargets()) {
      if (!target.variant) continue;
      const key = `${target.provider}:${target.variant}`;
      expect(VARIANT_REQUEST_PARAMS[key], `${where} 的 ${key} 没注册请求参数`).toBeDefined();
    }
  });

  test('只注册实际用得到的组合，加新组合必须是有意识的改动', () => {
    // DeepSeek V4 虽支持思考/非思考但 C01 两者同价、我们也不下发该参数；
    // Anthropic 思考 token 按普通输出计价，都不构成独立计费维度，故都不注册。
    expect(Object.keys(VARIANT_REQUEST_PARAMS).sort()).toEqual(['dashscope:nothink', 'dashscope:think']);
    expect(VARIANT_REQUEST_PARAMS['dashscope:nothink']).toEqual({ enable_thinking: false });
  });
});

describe('DEGRADE_CHAIN 不变式', () => {
  test('每个路由表格子的首选都在对应档位的降级链上（否则定位不到降级方向）', () => {
    for (const [plan, byClass] of Object.entries(ROUTING_TABLE)) {
      for (const [taskClass, target] of Object.entries(byClass)) {
        const onChain = DEGRADE_CHAIN[taskClass as TaskClass].some(
          (t) => t.provider === target.provider && t.model.api === target.model.api,
        );
        expect(onChain, `${plan}/${taskClass} 的首选不在降级链上`).toBe(true);
      }
    }
  });
});

describe('缺 key 降级（manager 2026-08-19 裁决）', () => {
  test('高配 critical 缺 ANTHROPIC_API_KEY → 跳过整个 Claude 段落降到 DeepSeek', () => {
    expect(route('critical', 'pro', only('deepseek', 'dashscope'))).toEqual({
      ...DS_PRO,
      degraded: true,
      degradedFrom: OPUS,
    });
  });

  test('Claude 与 DeepSeek 都缺 → 继续退到 Qwen（带 variant），degradedFrom 仍是最初的首选', () => {
    expect(route('standard', 'pro', only('dashscope'))).toEqual({
      ...QWEN_MAX,
      degraded: true,
      degradedFrom: SONNET,
    });
  });

  test('bulk 缺 DEEPSEEK → 退到 Qwen 便宜档', () => {
    expect(route('bulk', 'standard', only('dashscope'))).toEqual({
      ...QWEN_FLASH,
      degraded: true,
      degradedFrom: DS_FLASH,
    });
  });

  test('降级只向下：中配 critical 缺 Claude 时退到 DeepSeek，绝不升到 Opus', () => {
    const r = route('critical', 'standard', only('deepseek', 'dashscope'));
    expect(r).toEqual({ ...DS_PRO, degraded: true, degradedFrom: SONNET });
    expect(r.model.api).not.toBe(MODELS.CLAUDE_OPUS.api);
  });

  test('降级只向下：入门用户缺 DeepSeek 时退到 Qwen，绝不因为 Claude 有 key 就升上去', () => {
    const r = route('critical', 'entry', only('anthropic', 'dashscope'));
    expect(r).toEqual({ ...QWEN_MAX, degraded: true, degradedFrom: DS_PRO });
    expect(r.provider).not.toBe('anthropic');
  });

  test('首选可用时不降级，且不带 degradedFrom', () => {
    const r = route('critical', 'pro', allUp);
    expect(r.degraded).toBe(false);
    expect(r).not.toHaveProperty('degradedFrom');
  });

  test('降级链全缺 → 明确报错并点名每个环境变量，不返回一个假目标', () => {
    expect(() => route('critical', 'pro', only())).toThrow(
      /pro\/critical 无可用模型[\s\S]*ANTHROPIC_API_KEY\(claude-opus-5\)[\s\S]*DEEPSEEK_API_KEY[\s\S]*DASHSCOPE_API_KEY/,
    );
    expect(() => route('bulk', 'entry', only())).toThrow(/entry\/bulk 无可用模型[\s\S]*DEEPSEEK_API_KEY[\s\S]*DASHSCOPE_API_KEY/);
  });

  test('报错只列首选及其之后的链段（前面更贵的本来就不该考虑）', () => {
    expect(() => route('critical', 'entry', only())).toThrow(/DEEPSEEK_API_KEY[\s\S]*DASHSCOPE_API_KEY/);
    expect(() => route('critical', 'entry', only())).not.toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('默认可用性判据走环境变量', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    process.env.DEEPSEEK_API_KEY = 'sk-ds-x';
    process.env.DASHSCOPE_API_KEY = 'sk-dash-x';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  test('不传 isAvailable 时按环境变量判断', () => {
    expect(route('critical', 'pro').degraded).toBe(false);
    delete process.env.ANTHROPIC_API_KEY;
    expect(route('critical', 'pro')).toMatchObject({ ...DS_PRO, degraded: true, degradedFrom: OPUS });
  });

  test('空串 key 当作未配置（半配置比没配置更容易让人误判）', () => {
    process.env.ANTHROPIC_API_KEY = '';
    expect(route('critical', 'pro').degraded).toBe(true);
  });

  test('ANTHROPIC_API_KEY 当前缺失就是真实场景：联调不该被阻塞', () => {
    delete process.env.ANTHROPIC_API_KEY;
    for (const plan of ['entry', 'standard', 'pro'] as Plan[]) {
      for (const tc of ['critical', 'standard', 'bulk'] as TaskClass[]) {
        expect(() => route(tc, plan)).not.toThrow();
      }
    }
  });
});

describe('getProvider', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    process.env.DEEPSEEK_API_KEY = 'sk-ds-x';
    process.env.DASHSCOPE_API_KEY = 'sk-dash-x';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  test('客户端拿到的是 api 串，计费键是 priced 串——两者不能混用', () => {
    const { client } = getProvider('critical', 'entry');
    expect(client.model).toBe('deepseek-v4-pro');
    expect(client.billingModel).toBe('DeepSeek-V4-Pro-0813');
  });

  test('高配三档分别落到 Opus / Sonnet / DeepSeek-Flash', () => {
    expect(getProvider('critical', 'pro').client).toMatchObject({ name: 'anthropic', model: 'claude-opus-5' });
    expect(getProvider('standard', 'pro').client).toMatchObject({ name: 'anthropic', model: 'claude-sonnet-5' });
    expect(getProvider('bulk', 'pro').client).toMatchObject({ name: 'deepseek', model: 'deepseek-v4-flash' });
  });

  test('降级到 qwen 时 variant 参数与计费键同源下发', () => {
    for (const k of ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY']) delete process.env[k];
    const { client, route: r } = getProvider('bulk', 'pro');
    expect(r).toMatchObject({ degraded: true, variant: 'nothink' });
    expect(client.billingModel).toBe('qwen3.6-flash:nothink');
  });

  test('降级时客户端与 route 结果一致，degraded 可透传到响应头', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { client, route: r } = getProvider('critical', 'pro');
    expect(r).toMatchObject({ degraded: true, degradedFrom: OPUS });
    expect(client.name).toBe(r.provider);
    expect(client.model).toBe(r.model.api);
  });

  test('自带 apiKey 时按首选走，不因环境变量没配而降级', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { client, route: r } = getProvider('critical', 'pro', { apiKey: 'injected' });
    expect(r.degraded).toBe(false);
    expect(client.name).toBe('anthropic');
  });

  test('降级链全缺时仍然报错，不返回半成品客户端', () => {
    for (const k of ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY']) delete process.env[k];
    expect(() => getProvider('critical', 'pro')).toThrow(/无可用模型/);
  });
});
