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
  const { client } = getProvider('standard', 'entry');
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
