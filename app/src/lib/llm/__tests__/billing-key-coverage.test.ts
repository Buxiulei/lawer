// app/src/lib/llm/__tests__/billing-key-coverage.test.ts
// 结构守卫：routing.config 能产生的**每一个**计费键，在 model_rates 种子里都要有对应费率行。
//
// 【为什么要有】计费键由 routing.config 算（priced 串 [+:variant]，中转再加 relay/ 前缀），
// 费率行由 db/modelRates 播种，两边各写各的、谁也不认识谁。加一个带 variant 的路由目标
// 只改前者，键就凭空多一个——getRatesForModel 查不到会**静默回落 DEFAULT_RATES**
// （DeepSeek-Flash 地板价），不报错、不告警，于是「按 qwen 的价记 qwen 的账」变成
// 「按 DeepSeek-Flash 的价记 qwen 的账」，账面照样是绿的。
// 这类漂移只能靠遍历两侧求交集抓，不可能靠人记得。
//
// 【为什么要枚举 env 开关的两个状态】RELAY_ROUTE_DOMESTIC 打开时境内两家会被改挂到中转，
// 计费键随之全部换成 relay/ 前缀的另一批。只测默认状态的话，开关是一条「打开当天才发现
// 整批按地板价记账」的暗雷——开关能到达的状态也是这份契约的一部分。
import { describe, test, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate';
import { PENDING_PRICE_MODELS } from '../../db/modelRates';
import {
  DEGRADE_CHAIN,
  RELAY_DOMESTIC_ENV,
  ROUTING_TABLE,
  billingKey,
  degradeChain,
  routingTable,
  type Plan,
  type RouteTarget,
  type TaskClass,
} from '../routing.config';

/** 路由表 + 降级链上的全部目标（带来源标签，报错时能点名是哪一格漏的）。
 *  传入访问器的返回值而不是常量：开关打开时两者不是同一张表。 */
function targetsOf(
  table: Record<Plan, Record<TaskClass, RouteTarget>>,
  chain: Record<TaskClass, RouteTarget[]>,
): { where: string; target: RouteTarget }[] {
  const out: { where: string; target: RouteTarget }[] = [];
  for (const [plan, byClass] of Object.entries(table)) {
    for (const [tc, target] of Object.entries(byClass)) out.push({ where: `ROUTING_TABLE.${plan}.${tc}`, target });
  }
  for (const [tc, legs] of Object.entries(chain)) {
    legs.forEach((target, i) => out.push({ where: `DEGRADE_CHAIN.${tc}[${i}]`, target }));
  }
  return out;
}

/** env 开关的两个状态各枚举一遍。开关是进程级读取，所以这里真的去改 process.env。 */
function eachSwitchState(fn: (label: string, targets: { where: string; target: RouteTarget }[]) => void): void {
  delete process.env[RELAY_DOMESTIC_ENV];
  fn('默认（境内直连）', targetsOf(routingTable(), degradeChain()));
  process.env[RELAY_DOMESTIC_ENV] = '1';
  fn(`${RELAY_DOMESTIC_ENV}=1（境内改走中转）`, targetsOf(routingTable(), degradeChain()));
  delete process.env[RELAY_DOMESTIC_ENV];
}

/** 真跑一遍迁移与种子，直接查表——断言的是**播种后的库**而不是种子数组，
 *  这样连「种子写了但没被播进去」也一并守住。 */
function seededRateKinds(): Map<string, Set<string>> {
  const db = new Database(':memory:');
  runMigrations(db);
  const rows = db.prepare('SELECT DISTINCT model, token_kind FROM model_rates').all() as {
    model: string;
    token_kind: string;
  }[];
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = m.get(r.model);
    if (!s) m.set(r.model, (s = new Set()));
    s.add(r.token_kind);
  }
  db.close();
  return m;
}

afterEach(() => {
  delete process.env[RELAY_DOMESTIC_ENV];
});

describe('计费键 × model_rates 种子覆盖', () => {
  test('两个开关状态下可能产生的每个计费键，种子里都有 in / out 两档费率行', () => {
    const seeded = seededRateKinds();
    const missing: string[] = [];
    eachSwitchState((label, targets) => {
      for (const { where, target } of targets) {
        const key = billingKey(target);
        const kinds = seeded.get(key);
        // in / out 是任何一次对话调用都必然产生的两档，缺任一档就是「这个模型没定过价」。
        // cache_read / cache_write 不强制：厂商确实可能没有该计价档（如 DeepSeek 官方无缓存写）。
        if (kinds?.has('in') && kinds?.has('out')) continue;
        missing.push(`[${label}] ${key} ← ${where}（已有档位：${kinds ? [...kinds].sort().join('/') : '整个模型一行都没有'}）`);
      }
    });
    expect(missing, `以下计费键会静默回落 DEFAULT_RATES 地板价计费：\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  test('中转目标的计费键与直连分家——同一型号经中转不是同一个价', () => {
    // 反向守卫：万一有人把 relay/ 前缀去掉图省事，中转调用就会去扣直连的费率。
    const keys = targetsOf(ROUTING_TABLE, DEGRADE_CHAIN)
      .filter(({ target }) => target.provider === 'relay')
      .map(({ target }) => billingKey(target));
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k, `${k} 没带中转前缀，会去扣直连费率`).toMatch(/^relay\//);
  });
});

describe('待定价模型的边界（上线前必须过 manager）', () => {
  /** 某套餐在给定开关状态下、经默认路由会选中的待定价计费键。 */
  const pendingOf = (plan: Plan): string[] =>
    (['critical', 'standard', 'bulk'] as TaskClass[])
      .map((tc) => ({ tc, key: billingKey(routingTable()[plan][tc]) }))
      .filter(({ key }) => PENDING_PRICE_MODELS.has(key))
      .map(({ tc, key }) => `${plan}/${tc} → ${key}`);

  test('默认路由（= 上线形态）下，入门档一个待定价模型都不许选中', () => {
    delete process.env[RELAY_DOMESTIC_ENV];
    // 入门是最便宜那档，它的毛利没有余量去吃一个「其实不知道多少钱」的模型。
    expect(pendingOf('entry'), '入门档路由到了没定过价的模型').toEqual([]);
  });

  test('默认状态下待定价模型的完整敞口清单——多一条少一条都要重新过 manager', () => {
    delete process.env[RELAY_DOMESTIC_ENV];
    // 这条不是「允许」，是**把敞口写下来**：待定价的键出现在链上并不等于会卖给用户，
    // 但「哪些位置是待定价的」必须钉死，否则会悄悄多出来几条谁也没审过的。
    // 当前两类，各有各的理由：
    //  · relay/claude-*：中转倍率未核定。但 Claude 档对用户可见的开放本就受
    //    「评测官批绿 + manager 放行」闸门约束，本次只接线不开闸，所以它进不了用户账单；
    //  · qwen3.7-max:nothink：C01 未单列该型号价，只做 critical/standard 的末位应急腿，
    //    且 route() 会把 degraded 标记透传到响应头与日志，用不上时它不产生任何账。
    const onChain = Object.entries(degradeChain()).flatMap(([tc, legs]) =>
      legs.map((t, i) => ({ where: `${tc}[${i}]`, key: billingKey(t) })).filter(({ key }) => PENDING_PRICE_MODELS.has(key)),
    );
    expect(onChain.map((x) => `${x.where} → ${x.key}`).sort()).toEqual([
      'critical[0] → relay/claude-opus-5',
      'critical[1] → relay/claude-sonnet-5',
      'critical[3] → qwen3.7-max:nothink',
      'standard[0] → relay/claude-sonnet-5',
      'standard[2] → qwen3.7-max:nothink',
    ]);
    // 路由表侧：待定价只允许落在 Claude 那三格（= 未开闸的那三格），
    // 一旦有人把待定价模型挪进任何一格已开放的 DeepSeek 位置，这里就红。
    expect([...(['entry', 'standard', 'pro'] as Plan[])].flatMap(pendingOf).sort()).toEqual([
      'pro/critical → relay/claude-opus-5',
      'pro/standard → relay/claude-sonnet-5',
      'standard/critical → relay/claude-sonnet-5',
    ]);
  });

  test(`${RELAY_DOMESTIC_ENV}=1 会让入门档整档落到待定价的中转模型——费率过 manager 前不得在生产打开`, () => {
    process.env[RELAY_DOMESTIC_ENV] = '1';
    // 这条不是「允许」而是**记录敞口**：开关打开时入门档三格全部换成中转键，
    // 而中转键在 manager 核定 group_ratio 之前全是占位值。写死在这里，
    // 是为了让「打开开关等于把没定价的模型卖给最便宜那档用户」这件事在代码里看得见，
    // 而不是等生产出账时才发现。集合变了（多一个/少一个）就必须重新过一遍 manager。
    expect(pendingOf('entry')).toEqual([
      'entry/critical → relay/DeepSeek-V4-Pro-0813',
      'entry/standard → relay/DeepSeek-V4-Pro-0813',
      'entry/bulk → relay/DeepSeek-V4-Flash-0731',
    ]);
  });
});
