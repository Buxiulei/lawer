// app/src/app/api/mcp/route.ts
// MCP streamable HTTP 端点（spec §4：MCP 跑在 app 内，鉴权复用 api_keys 表）。
// 协议细节与"为什么手写不引 SDK"见 lib/mcp/jsonrpc.ts 顶部。
//
// 路由照例是薄的：鉴权 → 解析 JSON-RPC → 分发到 lib/mcp/tools 的注册表 → 包壳返回。
import { hasScope, resolveIdentity } from '@/lib/auth/identity';
import { OAUTH_PATHS } from '@/lib/auth/oauth';
import { checkPreconditions } from '@/lib/capabilities/invoke';
import { recordCapabilityWrite } from '@/lib/capabilities/ledger';
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
import { resolveBaseUrl } from '@/lib/mcp/setup';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function POST(req: Request) {
  // 未鉴权一律 401，且带 WWW-Authenticate 让客户端知道该怎么补
  //
  // 【resource_metadata 那一段不是装饰】只认 OAuth 的客户端（网页版连接器）就是靠它
  // 从这条 401 里找到授权服务器的（RFC 9728）。省掉它的形态是：客户端收到 401，
  // 无从知道该去哪儿授权，界面上只显示一句"连接失败"，我们这边看不到任何异常。
  const identity = resolveIdentity(getDb(), req.headers);
  if (!identity) {
    const metadata = `${resolveBaseUrl(req)}${OAUTH_PATHS.protectedResourceMetadata}`;
    return new Response(
      JSON.stringify({
        error: 'unauthorized',
        message: '需要有效的 api key，或走 OAuth 授权拿到的 access token',
      }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': `Bearer resource_metadata="${metadata}"`,
        },
      },
    );
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

      // 【前置闸由注册表驱动，不由各工具自觉】precondition 是能力条目上的一个字段，
      // 判定本身在 lib/capabilities/invoke.ts，**REST 通用桥调的是同一份**——
      // 两条入口各写一句的形态是：一边拦住了、另一边放行，而两边都不报错。
      // 【为什么 await】realname 闸走 realnameVerifiedOrLinked，本地没实名时会去问一次
      // NBDpsy（实名互认）——那一步是异步的。不 await 的形态是：gate 恒为一个 truthy 的
      // Promise，于是每一条带 realname 前置的工具都被这条 403 拦死，而没有任何一处报错。
      const gate = await checkPreconditions(getDb(), tool, identity);
      if (gate) {
        return json(rpcResult(id, toolErrorResult({ ...gate })));
      }

      // 业务失败（案件不存在、枚举非法）走 isError=true，让模型能读到原因自行纠正
      // 【为什么 await】出证一类能力要调外部服务，run 返回的是 Promise。
      // 不 await 的形态是：回包里是一个 {} （序列化后的 Promise），HTTP 200，没有任何报错。
      const outcome = (await tool.run(getDb(), identity, (args ?? {}) as Record<string, unknown>)) as
        | { ok: false; errorCode: string; message: string }
        | Record<string, unknown>;
      if (outcome && (outcome as { ok?: boolean }).ok === false) {
        // 【整个失败对象交给 toolErrorResult】能力挂在失败对象上的结构化清单要跟着出去，
        // 挑字段转交的形态是：新加一张表的那个能力在描述里承诺了它，回包却少那几个键。
        const failure = outcome as { errorCode: string; message: string } & Record<string, unknown>;
        return json(rpcResult(id, toolErrorResult(failure)));
      }

      // 【台账记在这道门上】走能力壳（withClientRef / writeOnce）的写能力在自己的事务里
      // 记过了；**没走能力壳的那一批此前一行都不留**——挂守望、出证、删档案这些会花钱或
      // 不可逆的动作，经这道门写进去查不到是谁写的，而回包 200、没有一处报错
      //（2026-09-10 复审 major#2）。recordCapabilityWrite 认注册表上的 ledger 字段，
      // 只记该由门记的那些，不会给能力壳那批记出第二行。
      recordCapabilityWrite(
        getDb(),
        identity,
        tool,
        (args ?? {}) as Record<string, unknown>,
        outcome as Record<string, unknown>,
        'mcp',
      );
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
