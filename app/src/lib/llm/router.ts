// app/src/lib/llm/router.ts
// 套餐路由（spec §8「task_class × 套餐 → 模型」）+ 缺 key 显式降级（manager 2026-08-19 追加裁决）。
// 本文件只做「查表 + 沿降级链找第一个有 key 的目标」，策略与顺序全在 routing.config.ts——
// 那是 manager 审批的契约文件，不许把型号或档位判断写死在函数里。

import { createProvider, type CreateProviderOptions } from './providers';
import { REQUIRED_ENV, degradeChain, routingTable, type Plan, type RouteTarget, type TaskClass } from './routing.config';
import type { Provider, ProviderName } from './types';

export interface RouteResult extends RouteTarget {
  /** true 表示首选目标缺 key，本次实际用的是降级链上的次优模型 */
  degraded: boolean;
  /** 仅 degraded 时存在：被跳过的原首选目标（provider + model），供响应头/日志透传 */
  degradedFrom?: RouteTarget;
}

export interface RouteOptions {
  /** 判断某 provider 的凭据是否可用。默认查环境变量；注入用于单测与「调用方自带 key」的场景。 */
  isAvailable?: (provider: ProviderName) => boolean;
}

/** 默认可用性判据：该 provider 所需的环境变量**全部**存在且非空串。
 *  空串当没配——半配置比没配置更容易让人误判。
 *  中转需要 key + 端点两个（见 routing.config.REQUIRED_ENV）：只判 key 会让它在
 *  「选中了才发现建不出来」的地方炸，那时降级链已经没机会接手了。 */
function envHasCredentials(provider: ProviderName): boolean {
  return REQUIRED_ENV[provider].every((name) => !!process.env[name]);
}

/** 查路由表并在首选缺 key 时沿 DEGRADE_CHAIN 向后降级。
 *
 *  plan/taskClass 可能来自数据库列或用户输入，所以运行时也要校验——静默落到某个默认档
 *  意味着「用户买了高配却在跑 DeepSeek」或反过来烧钱，两种都不能接受。
 *  同理，降级必须是**显式**的：返回值带 degraded/degradedFrom，调用方有责任透传到
 *  响应头与日志，绝不能让用户以为自己拿到的是首选模型。 */
export function route(taskClass: TaskClass, plan: Plan, o: RouteOptions = {}): RouteResult {
  // 走访问器而不是常量：RELAY_ROUTE_DOMESTIC 开着时境内两家会被改挂到中转（见 routing.config）。
  const table = routingTable();
  const byClass = table[plan];
  if (!byClass) throw new Error(`未知套餐档 plan=${plan}，可选：${Object.keys(table).join('/')}`);
  const preferred = byClass[taskClass];
  if (!preferred) throw new Error(`未知任务档 task_class=${taskClass}，可选：${Object.keys(byClass).join('/')}`);

  const isAvailable = o.isAvailable ?? envHasCredentials;
  if (isAvailable(preferred.provider)) return { ...preferred, degraded: false };

  // 只向后走：链上排在首选之前的都比它贵，降级绝不能把用户升档（白送钱）
  const chain = degradeChain()[taskClass];
  const from = chain.findIndex((t) => t.provider === preferred.provider && t.model === preferred.model);
  if (from < 0) {
    throw new Error(
      `路由表配置错误：${plan}/${taskClass} 的首选 ${preferred.provider}/${preferred.model} 不在 DEGRADE_CHAIN.${taskClass} 上，无法确定降级方向`,
    );
  }
  for (const target of chain.slice(from + 1)) {
    if (isAvailable(target.provider)) return { ...target, degraded: true, degradedFrom: preferred };
  }

  // 列出每条腿**全部**缺的变量名（中转是 key+端点两个）：只点名一半会让人补完还是不通。
  const tried = chain
    .slice(from)
    .map((t) => `${REQUIRED_ENV[t.provider].join('+')}(${t.model.api})`)
    .join(' → ');
  throw new Error(`${plan}/${taskClass} 无可用模型：降级链上的 key 全部缺失（${tried}），请补齐 app/.env.local`);
}

/** 路由 + 建客户端一步到位，供 lib/agent 直接用。
 *  返回 route 结果而不只是客户端：degraded 标记必须能传到响应头/日志，
 *  而 client.name/model 只说得出「用了谁」，说不出「本该用谁」。
 *
 *  传了 apiKey 就视为调用方自带凭据、所有 provider 都可用——否则会出现
 *  「明明给了 key 却因为环境变量没配而降级」的怪事。 */
export function getProvider(
  taskClass: TaskClass,
  plan: Plan,
  o: Omit<CreateProviderOptions, 'model'> = {},
): { client: Provider; route: RouteResult } {
  const result = route(taskClass, plan, o.apiKey ? { isAvailable: () => true } : {});
  return { client: createProvider(result, o), route: result };
}
