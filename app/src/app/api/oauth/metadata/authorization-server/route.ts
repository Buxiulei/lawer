// app/src/app/api/oauth/metadata/authorization-server/route.ts
// 对外地址是 `/.well-known/oauth-authorization-server`（next.config 里一条 rewrite 落到这儿）。
// 公开无鉴权：客户端在还没有任何凭据的时候读它，才知道该往哪儿跳、往哪儿换令牌。
import { ALL_SCOPES } from '@/lib/auth/api-key';
import { authorizationServerMetadata } from '@/lib/auth/oauth';
import { resolveBaseUrl } from '@/lib/mcp/setup';

export async function GET(req: Request) {
  return Response.json(authorizationServerMetadata(resolveBaseUrl(req), ALL_SCOPES));
}
