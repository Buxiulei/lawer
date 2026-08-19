// app/src/lib/llm/providers/deepseek.ts
// DeepSeek OpenAI 兼容端点。正文在 openai-compat.ts，本文件只放厂商差异（目前只有 baseUrl）。
// 官方 base_url 写作 https://api.deepseek.com，带不带 /v1 都通（/v1 与 OpenAI 版本号无关），
// 这里取带 /v1 的写法，与另外两家的 `${base}/chat/completions` 拼接方式统一。

import type { Provider, ProviderOptions } from '../types';
import { createOpenAICompatProvider } from './openai-compat';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

export function createDeepSeek(o: ProviderOptions): Provider {
  return createOpenAICompatProvider({ ...o, name: 'deepseek', defaultBaseUrl: DEEPSEEK_BASE_URL });
}
