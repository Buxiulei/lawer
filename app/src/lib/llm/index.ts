// app/src/lib/llm/index.ts
// 模型路由模块出口（spec §8 llm 路由）。跨模块只经本文件导出的接口（spec §3.2）：
// 上层要么 getProvider(taskClass, plan) 拿现成客户端，要么 route() 只看路由结果不建连接。
export { route, getProvider, type RouteResult, type RouteOptions } from './router';
export { createProvider, type CreateProviderOptions } from './providers';
// 并发闸的排队超时错误跨模块可见：它是 chatStream 的一种正常失败形态（503 而非 500），
// 上层要能认出来才可能给用户「人多稍后再试」而不是一条通用错误。
export { LlmGateBusyError } from './providers/gate';
export {
  MODELS,
  ROUTING_TABLE,
  DEGRADE_CHAIN,
  VARIANT_REQUEST_PARAMS,
  API_KEY_ENV,
  billingKey,
  type Plan,
  type TaskClass,
  type Variant,
  type ModelSpec,
  type RouteTarget,
} from './routing.config';
export { emptyUsage } from './types';
export {
  createPiiSession,
  withPiiRedaction,
  StreamRestorer,
  OUTBOUND_PROVIDERS,
  type PiiKind,
  type PiiSession,
} from './pii';
export type {
  ChatMessage,
  ChatStreamOptions,
  ChatStreamResult,
  FinishReason,
  Provider,
  ProviderName,
  ProviderOptions,
  TokenUsage,
  UsageReport,
  ToolCall,
  ToolDef,
  UsageCallback,
} from './types';
