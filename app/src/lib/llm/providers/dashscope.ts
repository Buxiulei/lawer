// app/src/lib/llm/providers/dashscope.ts
// DashScope（阿里云百炼）OpenAI 兼容端点。正文在 openai-compat.ts，本文件只放 baseUrl。
//
// 思考链开关不在这里硬编码，走 routing.config.VARIANT_REQUEST_PARAMS 的 think/nothink 变体：
// 百炼「思考输出与非思考输出价不同」（C01），所以它是计费维度，必须与计费键绑在一起下发，
// 硬编码在 provider 里会出现「计费键说 nothink、实际请求开了思考」的对不上账。
// 路由表里的 qwen 目标一律钉 nothink——2026-08-19 实测 qwen3.6-flash 同一条 trivial 提问，
// 关思考 completion=1、开思考 completion=211（reasoning=206），两百倍差价；
// 且 qwen 官方 function-calling 文档不建议思考链与工具调用同用（六爻 2026-07-07 结论）。

import type { Provider, ProviderOptions } from '../types';
import { createOpenAICompatProvider } from './openai-compat';

export const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export function createDashScope(o: ProviderOptions): Provider {
  return createOpenAICompatProvider({ ...o, name: 'dashscope', defaultBaseUrl: DASHSCOPE_BASE_URL });
}
