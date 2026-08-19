// app/src/lib/llm/providers/openai.ts
// OpenAI 官方端点。正文在 openai-compat.ts，本文件只放厂商差异（目前只有 baseUrl）。
// 注意：GPT-5 系在 chat/completions 上不接受 temperature，所以 ChatStreamOptions.temperature
// 不传时就不下发该字段（见 openai-compat.ts），调用方对 OpenAI 别硬塞温度。

import type { Provider, ProviderOptions } from '../types';
import { createOpenAICompatProvider } from './openai-compat';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export function createOpenAI(o: ProviderOptions): Provider {
  return createOpenAICompatProvider({ ...o, name: 'openai', defaultBaseUrl: OPENAI_BASE_URL });
}
