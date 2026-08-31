// app/src/lib/llm/providers/relay.ts
// 第三方中转（OpenAI 兼容）。正文全在 openai-compat.ts，本文件只放两件中转特有的事：
// 端点从 env 读、以及端点缺失时给一条能自己说清楚的错。
//
// 【为什么协议走 OpenAI 兼容】2026-08-31 生产实测：中转是 new-api/one-api 系软件，
// `GET /v1/models` 与 `POST /v1/chat/completions` 全在册，SSE 报文形态是
// `data: {...}` + 末帧 usage（choices 为空）+ `data: [DONE]`，与 parseCompatStream 的三处
// 关键分支（usage-only 帧、按 tc.index 稀疏落槽、[DONE] 提前 return）逐条命中，
// 零个不可解析行。所以不需要 anthropic-compat 那套改造，薄包装即可。
//
// 【为什么端点不写成编译期常量】另外四家的 baseUrl 是各自厂商的官方域名，写死没有风险；
// 中转的域名是我们自己采买的一条线路，换供应商/换线路是运维动作，不该要求改代码重新发版。
// 所以它和 key 一样是**凭据**：代码里只有变量名，值只进 env 文件。
//
// 【中转特有的坑，记在这里免得日后重新踩】
//  · 同一个 model 名在不同请求可能落到不同上游渠道（实测 x-routing-group 在 default/vip 间浮动），
//    所以「同一条输入两次调用的缓存读/写切分不同」是常态，不是 bug；
//  · 429 不带 retry-after 也不带任何 x-ratelimit-*，退避只能靠 gate.ts 自带节奏；
//  · 503 的报文前 ~700 字节全是分组名清单，真正的判据（哪个模型、无可用渠道）在末尾——
//    所以 sse.ts::httpError 必须保头保尾，只保头等于每个 503 长得一模一样。

import type { Provider, ProviderOptions } from '../types';
import { RELAY_BASE_URL_ENV } from '../routing.config';
import { createOpenAICompatProvider } from './openai-compat';

/**
 * 从环境变量取中转端点（OpenAI 兼容根地址，形如 https://…/v1）。
 * 缺失时抛「缺什么 / 为什么缺 / 怎么办」三段式错误——裸报一句 fetch failed
 * 会让人以为是中转挂了，实际只是这台机器没配过这个变量。
 */
export function relayBaseUrl(): string {
  const raw = process.env[RELAY_BASE_URL_ENV]?.trim();
  if (!raw) {
    throw new Error(
      `${RELAY_BASE_URL_ENV} 未配置，无法创建 relay provider。` +
        `中转端点与 key 一样属凭据，代码里只有变量名、值只进 env 文件，所以缺了它就不知道该把请求发去哪。` +
        `请在 app/.env.local（生产为 env 文件）补 ${RELAY_BASE_URL_ENV}=<中转的 OpenAI 兼容根地址，形如 https://…/v1>。`,
    );
  }
  // 去掉末尾斜杠：openai-compat 拼的是 `${base}/chat/completions`，运维粘贴时多带一条斜杠
  // 会拼成 //chat/completions，部分网关据此 404——这是个纯粹的手滑，不值得让人排查一轮。
  return raw.replace(/\/+$/, '');
}

export function createRelay(o: ProviderOptions): Provider {
  // 调用方显式给了 baseUrl（单测注入 mock 端点）时不读 env：否则跑单测得先配环境变量。
  return createOpenAICompatProvider({ ...o, name: 'relay', defaultBaseUrl: o.baseUrl ?? relayBaseUrl() });
}
