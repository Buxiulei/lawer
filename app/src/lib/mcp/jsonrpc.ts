// app/src/lib/mcp/jsonrpc.ts
// 手写的最小 MCP over Streamable HTTP 实现，只覆盖 initialize / tools/list / tools/call
// 三个方法 + notifications/initialized 一个通知。
//
// 为什么不引官方 SDK（取舍留档）：
//   - @modelcontextprotocol/sdk 1.x 的 StreamableHTTPServerTransport 收的是 Node 的
//     (IncomingMessage, ServerResponse)，而 Next 的 route handler 给的是 Web Request/Response，
//     中间还得垫一层 fetch-to-node，净增依赖不减复杂度。
//   - mcp-handler 2.x 走的是刚发布的 @modelcontextprotocol/server v2 依赖树。
//   - 我们只需要"无状态 JSON-RPC over POST"，而这正是规范明文允许的最简子集：
//     服务端可以直接回 application/json 单个 JSON 对象，客户端 MUST 两种都支持
//     （spec 2025-06-18 Transports 第 5 条），不需要 SSE、不需要 Mcp-Session-Id。
//   代价：将来要接 resources / prompts，或要 server 主动推 notifications（那必须上 SSE），
//   得自己补。到那一步再考虑换 SDK。
//
// 参考：https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
//       https://modelcontextprotocol.io/specification/2025-06-18/server/tools

/** 我们实现并声明支持的协议版本 */
export const PROTOCOL_VERSION = '2025-06-18';
/**
 * 也接受的历史版本。客户端没带 MCP-Protocol-Version 头时，规范要求按 2025-03-26 处理。
 * 2026-07-28 那版取消了 initialize 握手，属于另一套方言，本实现不声明支持。
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const FALLBACK_PROTOCOL_VERSION = '2025-03-26';

export const SERVER_INFO = {
  name: 'lawer-caiyuan',
  title: '土八鼠',
  version: '0.1.0',
};

/** JSON-RPC 2.0 标准错误码 */
export const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** 没有 id 的消息是 notification（不是请求），规范要求接受后回 202 空 body */
export function isNotification(msg: JsonRpcRequest): boolean {
  return msg.id === undefined || msg.id === null;
}

/**
 * 校验 MCP-Protocol-Version 请求头。
 * 缺省 → 按 2025-03-26 处理（规范的向后兼容要求）；带了但不认识 → 必须 400。
 */
export function checkProtocolHeader(headers: Headers): { ok: true } | { ok: false; message: string } {
  const raw = headers.get('mcp-protocol-version');
  if (!raw) return { ok: true };
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(raw.trim())) {
    return {
      ok: false,
      message: `不支持的 MCP-Protocol-Version: ${raw}（本服务支持 ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}）`,
    };
  }
  return { ok: true };
}

/** initialize 的版本协商：认得客户端要的就原样回，认不得就回我们最新的 */
export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : PROTOCOL_VERSION;
}

/** tools/call 的成功结果：内容按 text 回，结构化数据序列化成 JSON 文本 */
export function toolTextResult(payload: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: false,
  };
}

/**
 * tools/call 的**工具执行失败**结果。
 * 规范把错误分两档：协议层错误（未知工具名、参数形状不对）走 JSON-RPC error 对象；
 * 工具跑起来了但业务失败（案件不存在、枚举值非法）走 result.isError=true——
 * 这样模型能读到失败原因并自己调整下一步，而不是整个请求炸掉。
 */
export function toolErrorResult(errorCode: string, message: string) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error_code: errorCode, message }) }],
    isError: true,
  };
}
