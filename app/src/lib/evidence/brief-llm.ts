// app/src/lib/evidence/brief-llm.ts
// 生产上给简报挑模型。**单独一个文件**：brief.ts 里那几个纯函数（parseBrief / briefSummary /
// validateBrief）被事实卡与工具壳引用，它们不该因此把整个 lib/llm 拖进依赖图。
import { getProvider } from '@/lib/llm';

import type { BriefLlm } from './brief';

/**
 * 生产上写简报用哪个模型。
 *
 * **入门档 + standard 任务档**：按 routing.config 的三套餐表，这个组合恒落在境内便宜档
 * （不走 Claude），而简报是后续每一轮推理的输入——用 bulk 那档最便宜的模型写，
 * 省下的钱会以"后面每一轮都基于一份糊涂简报"的形式还回来。
 *
 * 取不到 provider（缺 key / 那家不实现 chatJSON）时回 null，**不抛错**：
 * 简报生成失败不该把已经付过钱的提取判成失败。
 */
export function defaultBriefLlm(): BriefLlm | null {
  try {
    const { client } = getProvider('standard', 'entry');
    if (!client.chatJSON) return null;
    const chatJSON = client.chatJSON.bind(client);
    return { chatJSON, billingModel: client.billingModel };
  } catch {
    return null;
  }
}
