// app/src/lib/referral/summary-llm.ts
// 生产上给情绪状态摘要挑模型。**单独一个文件**（同 lib/evidence/brief-llm 的分法）：
// packet.ts 里的纯函数会被判据与工具壳引用，它们不该因此把整个 lib/llm 拖进依赖图。
import { getProvider } from '@/lib/llm';

import type { SummaryLlm } from './packet';

/**
 * 入门档 + standard 任务档：与证据简报同一档。这段摘要只有 200 字，
 * 而它要做的是「把细节剥掉、只留状态」——不需要贵模型，需要的是一道**之后**的过滤器
 * （见 neutral.ts）。
 *
 * 取不到 provider（缺 key / 那家不实现 chatJSON）时回 null，**不抛错**：
 * 模型没连上不该让一次已经取得用户同意的转介失败，packet 会回落到按记录统计的兜底摘要。
 */
export function defaultSummaryLlm(): SummaryLlm | null {
  try {
    const { client } = getProvider('standard', 'entry');
    if (!client.chatJSON) return null;
    const chatJSON = client.chatJSON.bind(client);
    return { chatJSON: (messages) => chatJSON(messages) };
  } catch {
    return null;
  }
}
