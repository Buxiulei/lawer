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
    // **显式传 false，不吃缺省**：这三条流水线（证据简报 / 来文解读 / 转介摘要）拿不到
    // user_id，判不出这个人同没同意出境，所以一律按"没同意"走境内（协议五.5（2）：
    // 不同意的仍可使用仅境内模型的全部服务）。缺省本来也是 false，写出来是为了让
    // 下一个读到这里的人看见这道闸在，而不是以为这里漏传了一位——
    // 不写的形态是：有人为了"统一签名"顺手把缺省改成放行，这三条路上所有人的
    // 材料从此出境，而回包一切正常、没有一处报错（口径同 lib/llm/router.ts RouteOptions）。
    const { client } = getProvider('standard', 'entry', { overseasAllowed: false });
    if (!client.chatJSON) return null;
    const chatJSON = client.chatJSON.bind(client);
    return { chatJSON, billingModel: client.billingModel };
  } catch {
    return null;
  }
}
