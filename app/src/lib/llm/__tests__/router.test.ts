// app/src/lib/llm/__tests__/router.test.ts
// 路由矩阵是钱的开关：走错档要么让高配用户吃 DeepSeek，要么让入门用户烧 Claude。
// 三套餐 × 三档位九格全部逐格断言，不用循环糊过去——改表时必须有人逐格看一遍。
// 另外三条性质各有专门用例：降级只能向下；qwen 目标必须钉 variant；计费键锁 dated 串。
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { route, getProvider } from '../router';
import { DEGRADE_CHAIN, MODELS, ROUTING_TABLE, VARIANT_REQUEST_PARAMS, billingKey, degradeChain, domesticEquivalent, isOverseasTarget, relayDomesticEnabled, routingTable } from '../routing.config';
import type { Plan, RouteTarget, TaskClass } from '../routing.config';
import type { ProviderName } from '../types';

// Claude 两档挂在 relay 而非 anthropic：2026-08-31 生产实测 api.anthropic.com 回 403
// 「Request not allowed」，直连不是慢而是**走不通**，中转是唯一通路（见 routing.config 注释）。
const OPUS: RouteTarget = { provider: 'relay', model: MODELS.CLAUDE_OPUS };
const SONNET: RouteTarget = { provider: 'relay', model: MODELS.CLAUDE_SONNET };
const DS_PRO: RouteTarget = { provider: 'deepseek', model: MODELS.DEEPSEEK_PRO };
const DS_FLASH: RouteTarget = { provider: 'deepseek', model: MODELS.DEEPSEEK_FLASH };
const QWEN_MAX: RouteTarget = { provider: 'dashscope', model: MODELS.QWEN_MAX, variant: 'nothink' };
const QWEN_FLASH: RouteTarget = { provider: 'dashscope', model: MODELS.QWEN_FLASH, variant: 'nothink' };

/**
 * **本文件绝大多数用例说的是「表长什么样」，那是已开启境外模型的用户看到的表。**
 * 境外闸（协议五.5（2）：默认关，关着时 Claude 两档换成境内最高档）另有专门一组用例，
 * 见文末「境外模型闸」。两组分开是有意的：混在一起的话，改闸门的人会分不清
 * 某条用例红了是"表变了"还是"闸变了"。
 */
const OVERSEAS_ON = { overseasAllowed: true } as const;
/** 矩阵用例要的是「表长什么样」，与本机有没有 key 无关，所以把可用性钉死为全可用。 */
const allUp = { isAvailable: () => true, ...OVERSEAS_ON };
/** 只有列出的 provider 有 key */
const only = (...ups: ProviderName[]) => ({
  isAvailable: (p: ProviderName) => ups.includes(p),
  ...OVERSEAS_ON,
});

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
    // 判据钉在**型号**上而不是 provider 上：Claude 改经中转后，
    // 「provider 不是 anthropic」这句话对每一格都恒真，会把这条红线测成一句空话。
    const CLAUDE_APIS = [MODELS.CLAUDE_OPUS.api, MODELS.CLAUDE_SONNET.api];
    for (const plan of ['entry', 'standard', 'pro'] as Plan[]) {
      expect(CLAUDE_APIS).not.toContain(route('bulk', plan, allUp).model.api);
    }
  });

  test('Claude 用量随套餐单调不减，且 Opus 只出现在高配 critical', () => {
    // 按型号数而不是按 provider 数：Claude 现在挂在 relay 上，而 relay 也可能承载别的型号
    // （RELAY_ROUTE_DOMESTIC 开着时境内两家也走它），拿 provider 当「是不是 Claude」的判据会数错。
    const isClaude = (m: string) => m === MODELS.CLAUDE_OPUS.api || m === MODELS.CLAUDE_SONNET.api;
    const claudeCount = (plan: Plan) =>
      (['critical', 'standard', 'bulk'] as TaskClass[]).filter((tc) => isClaude(route(tc, plan, allUp).model.api)).length;
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

  test('不带 variant 的直连目标，计费键就是 priced 串', () => {
    expect(billingKey(DS_PRO)).toBe('DeepSeek-V4-Pro-0813');
    expect(billingKey(DS_FLASH)).toBe('DeepSeek-V4-Flash-0731');
  });

  test('中转目标的计费键带 relay/ 前缀——同一型号经中转与直连不是同一个价', () => {
    // 中转最终单价 = 上游官方价 × model_ratio × group_ratio，后两个系数只在中转控制台里。
    // 两边共用一个计费键就等于拿官方价去扣代理价的账。
    expect(billingKey(SONNET)).toBe('relay/claude-sonnet-5');
    expect(billingKey(OPUS)).toBe('relay/claude-opus-5');
    // 前缀与 variant 后缀能同时挂上（境内两家被 env 开关改挂中转时就是这个形状）
    expect(billingKey({ provider: 'relay', model: MODELS.QWEN_MAX, variant: 'nothink' })).toBe(
      'relay/qwen3.7-max:nothink',
    );
    // 直连的同一个型号必须仍是不带前缀的那个键
    expect(billingKey({ provider: 'anthropic', model: MODELS.CLAUDE_SONNET })).toBe('claude-sonnet-5');
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
    // relay:nothink 是给 RELAY_ROUTE_DOMESTIC 开关映射出来的 qwen 目标用的；
    // 不注册 relay:think——没有任何路由目标要开思考，注册了也无从验证。
    expect(Object.keys(VARIANT_REQUEST_PARAMS).sort()).toEqual([
      'dashscope:nothink',
      'dashscope:think',
      'relay:nothink',
    ]);
    expect(VARIANT_REQUEST_PARAMS['dashscope:nothink']).toEqual({ enable_thinking: false });
    // 2026-08-31 实测：这个参数经中转仍然穿透到上游（qwen3.7-max completion 1 vs 42），
    // 所以中转侧下发的必须是同一个字段，照抄直连那份。
    expect(VARIANT_REQUEST_PARAMS['relay:nothink']).toEqual(VARIANT_REQUEST_PARAMS['dashscope:nothink']);
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
  test('高配 critical 缺中转凭据 → 跳过整个 Claude 段落降到 DeepSeek', () => {
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
    // 中转有凭据（= Claude 可用）也不许把入门用户升上去——那是白送钱。
    const r = route('critical', 'entry', only('relay', 'dashscope'));
    expect(r).toEqual({ ...QWEN_MAX, degraded: true, degradedFrom: DS_PRO });
    expect(r.provider).not.toBe('relay');
  });

  test('首选可用时不降级，且不带 degradedFrom', () => {
    const r = route('critical', 'pro', allUp);
    expect(r.degraded).toBe(false);
    expect(r).not.toHaveProperty('degradedFrom');
  });

  test('降级链全缺 → 明确报错并点名每个环境变量，不返回一个假目标', () => {
    // 中转那条腿要把 key 与端点**两个**变量都点出来：只报一半会让人补完还是不通。
    expect(() => route('critical', 'pro', only())).toThrow(
      /pro\/critical 无可用模型[\s\S]*RELAY_API_KEY\+RELAY_BASE_URL\(claude-opus-5\)[\s\S]*DEEPSEEK_API_KEY[\s\S]*DASHSCOPE_API_KEY/,
    );
    expect(() => route('bulk', 'entry', only())).toThrow(/entry\/bulk 无可用模型[\s\S]*DEEPSEEK_API_KEY[\s\S]*DASHSCOPE_API_KEY/);
  });

  test('报错只列首选及其之后的链段（前面更贵的本来就不该考虑）', () => {
    expect(() => route('critical', 'entry', only())).toThrow(/DEEPSEEK_API_KEY[\s\S]*DASHSCOPE_API_KEY/);
    expect(() => route('critical', 'entry', only())).not.toThrow(/RELAY_API_KEY/);
  });
});

describe('默认可用性判据走环境变量', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.RELAY_API_KEY = 'sk-relay-x';
    process.env.RELAY_BASE_URL = 'https://relay.example/v1';
    process.env.DEEPSEEK_API_KEY = 'sk-ds-x';
    process.env.DASHSCOPE_API_KEY = 'sk-dash-x';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  test('不传 isAvailable 时按环境变量判断', () => {
    expect(route('critical', 'pro', OVERSEAS_ON).degraded).toBe(false);
    delete process.env.RELAY_API_KEY;
    expect(route('critical', 'pro', OVERSEAS_ON)).toMatchObject({ ...DS_PRO, degraded: true, degradedFrom: OPUS });
  });

  test('中转缺端点与缺 key 同样算不可用——端点也是凭据', () => {
    // 只判 key 的话这里会判可用、选中中转，然后在 createProvider 里炸掉，
    // 而降级链上明明还有 DeepSeek 那条腿没试。可用性判据必须与「能不能真建出来」同口径。
    delete process.env.RELAY_BASE_URL;
    expect(route('critical', 'pro', OVERSEAS_ON)).toMatchObject({ ...DS_PRO, degraded: true, degradedFrom: OPUS });
  });

  test('空串 key 当作未配置（半配置比没配置更容易让人误判）', () => {
    process.env.RELAY_API_KEY = '';
    expect(route('critical', 'pro', OVERSEAS_ON).degraded).toBe(true);
  });

  test('中转凭据缺失就是真实场景（本机常态）：联调不该被阻塞', () => {
    delete process.env.RELAY_API_KEY;
    delete process.env.RELAY_BASE_URL;
    for (const plan of ['entry', 'standard', 'pro'] as Plan[]) {
      for (const tc of ['critical', 'standard', 'bulk'] as TaskClass[]) {
        expect(() => route(tc, plan)).not.toThrow();
      }
    }
  });

  test('RELAY_ROUTE_DOMESTIC=1 把境内两家改挂中转，但已知走不通的 qwen3.6-flash 留在直连', () => {
    // 开关是运维层面的应急腿。默认关着——实测中转比直连慢 4~20 倍（deepseek-flash +4.10s），
    // 而 BOARD 的墙序里上游延迟是第一道墙。
    process.env.RELAY_ROUTE_DOMESTIC = '1';
    expect(route('critical', 'entry')).toMatchObject({ provider: 'relay', model: MODELS.DEEPSEEK_PRO });
    expect(route('bulk', 'entry')).toMatchObject({ provider: 'relay', model: MODELS.DEEPSEEK_FLASH });
    // qwen3.6-flash 实测中转 429 持续 3/3（同机直连同型号 200 / TTFB 0.28s）：
    // 若连它也改挂，bulk 两条腿会同时落在中转上，中转一饱和 bulk 就没有任何可用降级腿了。
    // 所以开关打开后 bulk 链必须仍是「中转一条腿 + 直连一条腿」。
    expect(degradeChain().bulk.map((t) => t.provider)).toEqual(['relay', 'dashscope']);
    // 中转整体不可用时，bulk 确实还退得到那条直连腿
    delete process.env.RELAY_API_KEY;
    expect(route('bulk', 'entry')).toMatchObject({ ...QWEN_FLASH, degraded: true });

    delete process.env.RELAY_ROUTE_DOMESTIC;
    expect(route('critical', 'entry')).toMatchObject({ provider: 'deepseek' });
  });

  test('开关只认精确字符串 1：其它任何 truthy 值（true/yes/0/01/带空格的 1）一律当关', () => {
    // routing.config 与 .env.example 都承诺「只认字符串 1，含 false/0/no 在内的其它值都当关」。
    // JS 里所有非空串都 truthy，所以判据一旦退化成 !!process.env[...]，运维写
    // RELAY_ROUTE_DOMESTIC=false 反而会把境内两家推上中转（实测慢 4~20 倍）。本用例钉死这道防线：
    // 逐个非精确值都必须判关，routingTable 的 entry.critical 仍停在直连的 deepseek。
    for (const v of ['true', 'yes', '0', '01', ' 1 ', 'false', 'no', '11', 'on', 'TRUE']) {
      process.env.RELAY_ROUTE_DOMESTIC = v;
      expect(relayDomesticEnabled(), `值 ${JSON.stringify(v)} 不应把开关判成开`).toBe(false);
      expect(routingTable().entry.critical.provider, `值 ${JSON.stringify(v)} 时 entry.critical 仍应直连`).toBe('deepseek');
    }
    // 只有精确 '1' 才开：判关全绿之后再验开，确保上面不是「恒判关」蒙混过去
    process.env.RELAY_ROUTE_DOMESTIC = '1';
    expect(relayDomesticEnabled()).toBe(true);
    expect(routingTable().entry.critical.provider).toBe('relay');
  });
});

describe('getProvider', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.RELAY_API_KEY = 'sk-relay-x';
    process.env.RELAY_BASE_URL = 'https://relay.example/v1';
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

  test('高配三档分别落到 Opus / Sonnet / DeepSeek-Flash（Claude 两档经中转）', () => {
    // 发给上游的 model 参数仍是官方别名——中转认的就是这个串（实测 543 个模型里逐字在册），
    // 换的只是端点与计费键，不是型号名。
    expect(getProvider('critical', 'pro', OVERSEAS_ON).client).toMatchObject({ name: 'relay', model: 'claude-opus-5' });
    expect(getProvider('standard', 'pro', OVERSEAS_ON).client).toMatchObject({ name: 'relay', model: 'claude-sonnet-5' });
    expect(getProvider('bulk', 'pro').client).toMatchObject({ name: 'deepseek', model: 'deepseek-v4-flash' });
    expect(getProvider('critical', 'pro', OVERSEAS_ON).client.billingModel).toBe('relay/claude-opus-5');
  });

  test('降级到 qwen 时 variant 参数与计费键同源下发', () => {
    for (const k of ['RELAY_API_KEY', 'DEEPSEEK_API_KEY']) delete process.env[k];
    const { client, route: r } = getProvider('bulk', 'pro');
    expect(r).toMatchObject({ degraded: true, variant: 'nothink' });
    expect(client.billingModel).toBe('qwen3.6-flash:nothink');
  });

  test('降级时客户端与 route 结果一致，degraded 可透传到响应头', () => {
    delete process.env.RELAY_API_KEY;
    const { client, route: r } = getProvider('critical', 'pro', OVERSEAS_ON);
    expect(r).toMatchObject({ degraded: true, degradedFrom: OPUS });
    expect(client.name).toBe(r.provider);
    expect(client.model).toBe(r.model.api);
  });

  test('自带 apiKey 时按首选走，不因环境变量没配而降级', () => {
    delete process.env.RELAY_API_KEY;
    const { client, route: r } = getProvider('critical', 'pro', { apiKey: 'injected', ...OVERSEAS_ON });
    expect(r.degraded).toBe(false);
    expect(client.name).toBe('relay');
  });

  test('中转端点缺失时给的是能自己说清楚的错，不是一句 fetch failed', () => {
    // 自带 apiKey 会绕过可用性判据直取首选，此时端点缺失只能在建实例时才发现。
    // 这条错必须说清「缺什么 / 为什么缺 / 怎么办」——裸报网络错会让人去查中转有没有挂。
    delete process.env.RELAY_BASE_URL;
    expect(() => getProvider('critical', 'pro', { apiKey: 'injected', ...OVERSEAS_ON })).toThrow(
      /RELAY_BASE_URL 未配置[\s\S]*只有变量名[\s\S]*RELAY_BASE_URL=/,
    );
  });

  test('降级链全缺时仍然报错，不返回半成品客户端', () => {
    for (const k of ['RELAY_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY']) delete process.env[k];
    expect(() => getProvider('critical', 'pro')).toThrow(/无可用模型/);
  });
});

// ─────────────────────────── 境外模型闸 ───────────────────────────
//
// 协议 五.5（2）/ 附一 #6：境外模型**默认关闭**；没同意的人，Claude 那两档换成
// 降级链上的**境内最高档**，功能不缺。
//
// 【判据分四层，缺一层就漏掉对应的失效形态】
//  ① 全矩阵：关着时选中的目标**一个都不是**境外目标（九格逐格数，不是抽查）；
//  ② 缺省即拒：不传这一位与显式传 false 结果逐格相同——新调用方忘了传也不会出境；
//  ③ 降级不绕闸：relay 有 key 时也不许被"缺 key 降级"这条路径把人送回 Claude；
//  ④ 换到的是**境内最高档**、不是随便一个境内档（降到会编条号的便宜模型是最像正常的失败）。
//
// 【变异矩阵】2026-09-07 逐条实跑（改 router.ts / routing.config.ts、跑本文件、再改回），
// 结果如实照抄，包括**没抓住的那一条**：
//  · N-1 route() 里 `o.overseasAllowed ? tabled : domesticEquivalent(...)` 改成恒取 tabled
//        （＝闸整个失效）                                      ⇒ 5 失败 / 40 通过。
//  · N-3 缺省改成放行（`(o.overseasAllowed ?? true)`）         ⇒ 2 失败 / 43 通过。
//  · N-4 domesticEquivalent 取链上**最后**一个境内目标而非第一个（＝降到最便宜那档）
//        ⇒ 3 失败 / 42 通过。
//  · N-2 删掉降级循环里那句 `if (!o.overseasAllowed && isOverseasTarget(target)) continue;`
//        ⇒ **45 全绿，本组一条都没抓住。** 如实记在这里，别把它读成"守住了"：
//        今天的 DEGRADE_CHAIN 里境外目标全排在境内目标**之前**（Claude → Claude →
//        DeepSeek → Qwen），而 domesticEquivalent 已经先把首选换成了链上第一个境内目标，
//        它之后的每一格都是境内的——那句 continue 因此**当前不可达**，是留给
//        "将来链上境内档后面又出现境外档"的前置守卫。要给它配判据，得能往 route() 里
//        注入一条自造的链（今天注不进去）。改动那句时不要指望本组会变红。
describe('境外模型闸：没同意的人，一格都不许落到境外目标', () => {
  const PLANS: Plan[] = ['entry', 'standard', 'pro'];
  const CLASSES: TaskClass[] = ['critical', 'standard', 'bulk'];
  /** 凭据全可用——这条判据说的是「表怎么选」，与本机有没有 key 无关 */
  const allAvailable = { isAvailable: () => true };

  test('① 九格全扫：关着境外时，选中的目标一个都不是境外的', () => {
    const overseas: string[] = [];
    for (const plan of PLANS) {
      for (const taskClass of CLASSES) {
        const r = route(taskClass, plan, { ...allAvailable, overseasAllowed: false });
        if (isOverseasTarget(r)) overseas.push(`${plan}/${taskClass} → ${r.model.api}`);
      }
    }
    expect(overseas, '这些格子把没同意出境的用户送到了境外接收方').toEqual([]);
  });

  test('② 缺省就是拒：不传这一位与显式 false 逐格相同（新调用方忘了传也不会出境）', () => {
    // 【方向不能反】默认放行时"忘了传"的代价是那条路上所有人的对话都出境，
    // 而回包一切正常、没有任何一处报错。默认拒绝时的代价只是都用境内模型。
    for (const plan of PLANS) {
      for (const taskClass of CLASSES) {
        const omitted = route(taskClass, plan, { ...allAvailable });
        const explicit = route(taskClass, plan, { ...allAvailable, overseasAllowed: false });
        expect(omitted, `${plan}/${taskClass}：不传与传 false 必须同一个结果`).toEqual(explicit);
      }
    }
  });

  test('③ Claude 两档换成 DeepSeek-Pro，且**不算降级**（是这个人本来就该走的档）', () => {
    // relay 的 key 是有的——换档的理由是"他没同意出境"，不是"中转挂了"。
    const pro = route('critical', 'pro', { ...allAvailable, overseasAllowed: false });
    expect(pro).toMatchObject({ ...DS_PRO });
    const std = route('standard', 'pro', { ...allAvailable, overseasAllowed: false });
    expect(std).toMatchObject({ ...DS_PRO });
    const mid = route('critical', 'standard', { ...allAvailable, overseasAllowed: false });
    expect(mid).toMatchObject({ ...DS_PRO });
  });

  test('④ 换到的是链上**第一个**境内目标（境内最高档），不是最便宜那档', () => {
    // 【为什么这条要单独设防】降到 Qwen-Flash 这类便宜档的形态是：输出照常生成、
    // 格式完全正常，只有条号是编的。它比"报错"难发现得多。
    const r = route('critical', 'pro', { ...allAvailable, overseasAllowed: false });
    const firstDomestic = DEGRADE_CHAIN.critical.find((t) => !isOverseasTarget(t))!;
    expect(r.model.api).toBe(firstDomestic.model.api);
    expect(r.model.api).not.toBe(MODELS.QWEN_MAX.api);
  });

  test('⑤ 零 relay 调用（计数）：整张矩阵建成客户端，落在中转上的一个都没有', () => {
    // 【为什么这条要真的把客户端建出来】前面几条量的是 route() 的返回值；
    // 这条量的是**真正会被拿去发请求的那个对象**。两者之间还隔着 createProvider，
    // 而"路由算对了、客户端却建成了另一个"正是最难从返回值上看出来的失效形态。
    const saved = { ...process.env };
    process.env.RELAY_API_KEY = 'sk-relay-x';
    process.env.RELAY_BASE_URL = 'https://relay.example/v1';
    process.env.DEEPSEEK_API_KEY = 'sk-ds-x';
    process.env.DASHSCOPE_API_KEY = 'sk-dash-x';
    // 中转转发境内型号的开关必须关着，否则 name==='relay' 不再等价于"出境"
    delete process.env.RELAY_ROUTE_DOMESTIC;
    try {
      expect(relayDomesticEnabled(), '前提自检：这条判据要求中转境内转发是关的').toBe(false);
      const relayCalls: string[] = [];
      for (const plan of PLANS) {
        for (const taskClass of CLASSES) {
          const { client } = getProvider(taskClass, plan, { overseasAllowed: false });
          if (client.name === 'relay' || client.name === 'anthropic') {
            relayCalls.push(`${plan}/${taskClass} → ${client.name}/${client.model}`);
          }
        }
      }
      expect(relayCalls, '没同意出境的用户，这些格子仍然会把请求发往境外通路').toEqual([]);
    } finally {
      process.env = { ...saved };
    }
  });

  test('⑥ 自带 apiKey 不放宽境外闸（那把 key 是谁的，与他同不同意出境是两件事）', () => {
    const saved = { ...process.env };
    process.env.DEEPSEEK_API_KEY = 'sk-ds-x';
    try {
      const { client, route: r } = getProvider('critical', 'pro', { apiKey: 'injected' });
      expect(r.model.api).toBe(MODELS.DEEPSEEK_PRO.api);
      expect(client.name).not.toBe('relay');
    } finally {
      process.env = { ...saved };
    }
  });

  test('⑦ 对照臂：同意了就照常走 Claude（闸不是"永远不给用"）', () => {
    // 只有这一臂能挡住"把闸写成恒拒"——那时上面六条全绿，而买了高配的人拿不到 Claude。
    expect(route('critical', 'pro', { ...allAvailable, overseasAllowed: true })).toMatchObject(OPUS);
    expect(route('standard', 'pro', { ...allAvailable, overseasAllowed: true })).toMatchObject(SONNET);
  });

  test('⑧ 链上一条境内腿都没有时**抛错**，绝不静默回落到境外', () => {
    // 那样会把这道闸变成一句只写在注释里的承诺：用户没同意，数据照样出境，而日志一切正常。
    const overseasOnly: RouteTarget[] = [OPUS, SONNET];
    expect(() => domesticEquivalent('critical', OPUS, overseasOnly)).toThrow(/没有境内目标/);
  });
});
