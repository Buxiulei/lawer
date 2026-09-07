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
    // **显式传 false，不吃缺省**：这三条流水线（证据简报 / 来文解读 / 转介摘要）拿不到
    // user_id，判不出这个人同没同意出境，所以一律按"没同意"走境内（协议五.5（2）：
    // 不同意的仍可使用仅境内模型的全部服务）。缺省本来也是 false，写出来是为了让
    // 下一个读到这里的人看见这道闸在，而不是以为这里漏传了一位——
    // 不写的形态是：有人为了"统一签名"顺手把缺省改成放行，这三条路上所有人的
    // 材料从此出境，而回包一切正常、没有一处报错（口径同 lib/llm/router.ts RouteOptions）。
    const { client } = getProvider('standard', 'entry', { overseasAllowed: false });
    if (!client.chatJSON) return null;
    const chatJSON = client.chatJSON.bind(client);
    return { chatJSON: (messages) => chatJSON(messages) };
  } catch {
    return null;
  }
}
