// app/src/app/api/oauth/metadata/protected-resource/route.ts
// 对外地址是 `/.well-known/oauth-protected-resource`（含 RFC 9728 的路径插入变体，
// 见 next.config 的 rewrite）。它回答的只有一个问题：这个 MCP 资源由谁发令牌。
import { ALL_SCOPES } from '@/lib/auth/api-key';
import { protectedResourceMetadata } from '@/lib/auth/oauth';
import { resolveBaseUrl } from '@/lib/mcp/setup';

export async function GET(req: Request) {
  return Response.json(protectedResourceMetadata(resolveBaseUrl(req), ALL_SCOPES));
}
