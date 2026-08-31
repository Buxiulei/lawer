// app/src/lib/llm/providers/index.ts
// provider 工厂：把一个路由目标（provider + 型号 + 计费变体）变成 Provider 实例，
// 并在这里（且只在这里）从环境变量取 key、把 variant 翻译成厂商请求参数。
// 上层拿到的永远是统一接口，不认厂商。

import { withPiiRedaction } from '../pii';
import { API_KEY_ENV, VARIANT_REQUEST_PARAMS, billingKey, type RouteTarget } from '../routing.config';
import type { Provider, ProviderName, ProviderOptions } from '../types';
import { createAnthropic } from './anthropic';
import { createDashScope } from './dashscope';
import { createDeepSeek } from './deepseek';
import { createOpenAI } from './openai';
import { createRelay } from './relay';

const FACTORIES: Record<ProviderName, (o: ProviderOptions) => Provider> = {
  anthropic: createAnthropic,
  openai: createOpenAI,
  deepseek: createDeepSeek,
  dashscope: createDashScope,
  relay: createRelay,
};

export interface CreateProviderOptions {
  /** 不传则从对应环境变量取（见 routing.config.API_KEY_ENV）；单测传假 key */
  apiKey?: string;
  /** 不传则用各 provider 的官方端点；单测可指向 mock */
  baseUrl?: string;
  /** 注入供单测 mock */
  fetchImpl?: typeof fetch;
}

/** 不做单例缓存：客户端本身无连接池状态（每次 fetch 独立），缓存只会让 fetchImpl 注入失效。
 *
 *  variant 的请求参数在这里查表下发，与计费键在同一处算出——两者必须同源，
 *  否则会出现「计费键写着 nothink、实际请求开了思考」的对不上账。
 *  标了 variant 却没有对应映射直接报错，不静默按无变体发出去。 */
export function createProvider(target: RouteTarget, o: CreateProviderOptions = {}): Provider {
  const envName = API_KEY_ENV[target.provider];
  const apiKey = o.apiKey ?? process.env[envName];
  if (!apiKey) throw new Error(`${envName} 未配置（app/.env.local），无法创建 ${target.provider} provider`);

  let extraBody: Record<string, unknown> | undefined;
  if (target.variant) {
    const key = `${target.provider}:${target.variant}`;
    extraBody = VARIANT_REQUEST_PARAMS[key];
    if (!extraBody) {
      throw new Error(`计费变体 ${key} 未在 VARIANT_REQUEST_PARAMS 注册，无法确定该下发什么请求参数`);
    }
  }

  // 出境脱敏包在最外层（PIPL 39 条，见 ../pii.ts）：本函数是 lib/llm 唯一的实例出口，
  // 拦在这里才能保证「不管哪个调用方、走哪条路由」，发往 anthropic/openai 的消息都过了一遍。
  // 境内两家在 withPiiRedaction 内部短路，不产生任何包装开销。
  return withPiiRedaction(
    FACTORIES[target.provider]({
      apiKey,
      model: target.model.api,
      billingModel: billingKey(target),
      extraBody,
      baseUrl: o.baseUrl,
      fetchImpl: o.fetchImpl,
    }),
  );
}

export { createAnthropic, createDashScope, createDeepSeek, createOpenAI, createRelay };
