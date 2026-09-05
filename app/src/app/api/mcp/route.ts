// app/src/app/api/mcp/route.ts
// MCP streamable HTTP 端点（spec §4：MCP 跑在 app 内，鉴权复用 api_keys 表）。
// 协议细节与"为什么手写不引 SDK"见 lib/mcp/jsonrpc.ts 顶部。
//
// 路由照例是薄的：鉴权 → 解析 JSON-RPC → 分发到 lib/mcp/tools 的注册表 → 包壳返回。
import { hasScope, resolveIdentity } from '@/lib/auth/identity';
import { recordClientName } from '@/lib/db/api-keys';
import { getDb } from '@/lib/db/client';
import { findTool, TOOLS } from '@/lib/mcp/tools';
import {
  checkProtocolHeader,
  isNotification,
  JSON_RPC,
  negotiateVersion,
  PROTOCOL_VERSION,
  rpcError,
  rpcResult,
  SERVER_INFO,
  toolErrorResult,
  toolTextResult,
  type JsonRpcRequest,
} from '@/lib/mcp/jsonrpc';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function POST(req: Request) {
  // 未鉴权一律 401，且带 WWW-Authenticate 让客户端知道该怎么补
  const identity = resolveIdentity(getDb(), req.headers);
  if (!identity) {
    return new Response(JSON.stringify({ error: 'unauthorized', message: '需要有效的 api key' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
    });
  }

  const protocolCheck = checkProtocolHeader(req.headers);
  if (!protocolCheck.ok) {
    return json({ error: 'unsupported_protocol_version', message: protocolCheck.message }, 400);
  }

  let msg: JsonRpcRequest;
  try {
    msg = await req.json();
  } catch {
    return json(rpcError(null, JSON_RPC.PARSE_ERROR, '请求体不是合法 JSON'), 400);
  }
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    return json(rpcError(null, JSON_RPC.INVALID_REQUEST, '不是合法的 JSON-RPC 消息'), 400);
  }

  // 通知（无 id）不需要响应体，规范要求收下就回 202 空 body
  if (isNotification(msg)) {
    return new Response(null, { status: 202 });
  }

  const id = msg.id!;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (msg.method) {
    case 'initialize': {
      // 客户端自报的名字（MCP 规范 initialize.params.clientInfo）。此前整个丢掉，
      // 于是页面上只能显示用户自己给钥匙起的名，说不出"到底是哪个助手接进来了"。
      // 没报名字就**不写**——不能拿一次匿名握手把上一次报过的名字抹掉。
      const clientInfo = params.clientInfo as { name?: unknown } | undefined;
      const reported =
        typeof clientInfo?.name === 'string' ? clientInfo.name.trim().slice(0, 64) : '';
      if (identity.keyId !== undefined && reported) {
        recordClientName(getDb(), identity.keyId, reported);
      }
      return json(
        rpcResult(id, {
          protocolVersion: negotiateVersion(params.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            '这是「土八鼠」的案件档案接口。所有工具都只能操作当前 api key 所属用户自己的案件。' +
            '时间线只追加不修改，记错了补一条更正事件。',
        }),
      );
    }

    case 'tools/list':
      return json(
        rpcResult(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        }),
      );

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = findTool(name);
      // 未知工具名是协议层错误 → JSON-RPC error
      if (!tool) {
        return json(rpcError(id, JSON_RPC.METHOD_NOT_FOUND, `未知的工具：${name}`));
      }
      const args = params.arguments;
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        return json(rpcError(id, JSON_RPC.INVALID_PARAMS, 'arguments 必须是对象'));
      }
      // 权限不足也算协议层拒绝：这把 key 压根不该看到这个工具能用
      if (!hasScope(identity, tool.scope)) {
        return json(
          rpcError(id, JSON_RPC.INVALID_REQUEST, `当前 api key 缺少 ${tool.scope} 权限`),
        );
      }

      // 业务失败（案件不存在、枚举非法）走 isError=true，让模型能读到原因自行纠正。
      // **必须 await**：耗算力的能力（要外呼模型或 sidecar）回的是 Promise，不 await 的话
      // 下面那句 `.ok === false` 判的是一个 Promise 对象——它永远不等于 false，于是失败被当成成功，
      // 回给对方的正文是「[object Promise]」。同步能力 await 一个非 Promise 值原样返回，不受影响。
      const outcome = (await tool.run(getDb(), identity, (args ?? {}) as Record<string, unknown>)) as
        | { ok: false; errorCode: string; message: string }
        | Record<string, unknown>;
      if (outcome && (outcome as { ok?: boolean }).ok === false) {
        const failure = outcome as { errorCode: string; message: string };
        return json(rpcResult(id, toolErrorResult(failure.errorCode, failure.message)));
      }
      return json(rpcResult(id, toolTextResult(outcome)));
    }

    default:
      return json(rpcError(id, JSON_RPC.METHOD_NOT_FOUND, `不支持的方法：${msg.method}`));
  }
}

/** GET 用于探活与自描述；MCP 的 SSE 流我们不实现（无状态 JSON 响应已满足规范） */
export async function GET() {
  return json({
    protocol: 'mcp',
    transport: 'streamable-http',
    protocol_version: PROTOCOL_VERSION,
    server: SERVER_INFO,
    note: '请用 POST 发 JSON-RPC 2.0 消息，并在 Authorization: Bearer 里带 api key。',
  });
}
