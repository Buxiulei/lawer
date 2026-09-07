// app/src/lib/docs/index.ts
// 来文解读与录音要点的模块出口。能力壳（lib/capabilities/families/docs.ts）、
// REST 路由与网页只经本文件取东西，不各自深引内部文件。
import { getProvider } from '@/lib/llm';

import type { DocReviewDeps, DocReviewLlm } from './review';
import type { TranscriptDeps } from './transcript';

export { listDocs, getDoc, type DocDetail, type DocFinding, type DocListItem, type RiskFlag } from './read';
export {
  submitDoc,
  verifyFindings,
  locateQuote,
  type DocQuoteResult,
  type DocReviewDeps,
  type DocReviewLlm,
  type DocReviewResult,
  type SubmitDocInput,
  type VerifiedFinding,
} from './review';
export {
  submitTranscript,
  verifyEvents,
  type SubmitTranscriptInput,
  type SuggestedEvent,
  type TranscriptDeps,
  type TranscriptResult,
} from './transcript';
export { DOC_KINDS, isDocKind, rulesFor, type DocKind, type ReviewRule } from './rules';

/**
 * 生产用的模型件。**取不到 chatJSON 的供应商在这里就炸**，不是在半路静默降级：
 * 这两条流水线要的都是一次小型 JSON 调用，没有 chatJSON 就没有可用的形态
 *（见 lib/llm/types.ts：Anthropic 侧刻意不实现，bulk 档本来也不走它）。
 */
function jsonLlm(): DocReviewLlm {
  // **显式传 false，不吃缺省**：这三条流水线（证据简报 / 来文解读 / 转介摘要）拿不到
  // user_id，判不出这个人同没同意出境，所以一律按"没同意"走境内（协议五.5（2）：
  // 不同意的仍可使用仅境内模型的全部服务）。缺省本来也是 false，写出来是为了让
  // 下一个读到这里的人看见这道闸在，而不是以为这里漏传了一位——
  // 不写的形态是：有人为了"统一签名"顺手把缺省改成放行，这三条路上所有人的
  // 材料从此出境，而回包一切正常、没有一处报错（口径同 lib/llm/router.ts RouteOptions）。
  const { client } = getProvider('standard', 'entry', { overseasAllowed: false });
  const call = client.chatJSON;
  if (!call) {
    throw new Error(
      `当前路由到的模型 ${client.billingModel} 不支持 JSON 调用。` +
        '为什么：来文解读与录音要点都是一次性的小型 JSON 调用，不是流式对话。' +
        '怎么办：检查 lib/llm/routing.config.ts 的 standard 档降级链与本机 key 配置。',
    );
  }
  return {
    chatJSON: (messages) => call.call(client, messages),
    billingModel: client.billingModel,
  };
}

export function defaultDocReviewDeps(): DocReviewDeps {
  return { llm: jsonLlm() };
}

export function defaultTranscriptDeps(): TranscriptDeps {
  return { llm: jsonLlm() };
}
