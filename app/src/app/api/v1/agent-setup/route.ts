// app/src/app/api/v1/agent-setup/route.ts
// GET /api/v1/agent-setup → {ok, mcp_url, api_base, manifest_url, tools, setup_markdown}
// 用户把这份东西喂给自己的 AI 助手，就能直连档案库（spec D4 一键接入）。
// 接入面与客户端无关：MCP（Streamable HTTP）与 REST 两个标准，用哪家助手都一样。
//
// JWT 或 api key 都认，且不要求任何 scope：返回的全是接口自描述与说明书，没有一个字节的案件数据，
// 一把只有 case:write 的 key 也该读得到自己的接入方式。但仍要求鉴权——接入说明里会写明
// 该往哪儿连、怎么带凭据，属于产品资产，不对匿名访问者敞开（匿名要看形状去 /api/manifest）。
import { NextResponse } from 'next/server';

import { resolveIdentity } from '@/lib/auth/identity';
import { getDb } from '@/lib/db/client';
import { agentSetup } from '@/lib/mcp/setup';

export async function GET(req: Request) {
  const identity = resolveIdentity(getDb(), req.headers);
  if (!identity) {
    // 措辞与 lib/auth/guard.ts 一致：这条路由两种凭据都收，不能只说"重新验证手机号"
    return NextResponse.json(
      { ok: false, error_code: 'UNAUTHORIZED', message: '缺少或无效的凭据' },
      { status: 401 },
    );
  }

  return NextResponse.json({ ok: true, ...agentSetup(req) });
}
