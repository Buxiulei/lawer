// app/src/app/api/v1/tools/route.ts
// GET /api/v1/tools → 通用桥能调哪些能力（名、scope、读写、前置闸、入参 schema）。
//
// 【为什么要有它】不支持 MCP 的客户端此前只能靠专用端点，而专用端点只覆盖一部分能力：
// 事实卡、法律依据检索、金额主张这些没有专用端点的能力，走 REST 的 agent 无从调用，
// 且从它手上看不出「少了」——清单里根本没提过它们。现在能力清单与 MCP tools/list 同源，
// 少一条要么两边都少，要么当场对不上。
//
// 与 /api/v1/agent-setup 同一档鉴权：认凭据但**不校 scope**——回的全是接口自描述，
// 没有一个字节的案件数据，一把只有 case:write 的 key 也该读得到自己能调什么。
import { resolveIdentity } from '@/lib/auth/identity';
import { listCapabilities } from '@/lib/capabilities';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

export async function GET(req: Request) {
  if (!resolveIdentity(getDb(), req.headers)) {
    return apiJson(
      { ok: false, error_code: 'UNAUTHORIZED', message: '缺少或无效的凭据' },
      { status: 401 },
    );
  }

  return apiJson({
    ok: true,
    // 顺序照注册表原样：客户端把清单原样展示给用户，重排等于面板重排
    tools: listCapabilities({ exposeTo: 'mcp' }).map((c) => ({
      name: c.name,
      title: c.title,
      description: c.description,
      scope: c.scope,
      kind: c.kind,
      // 服务端闸门。realname 的能力未实名调一律 403 REALNAME_REQUIRED，先看这里免得白调一次
      precondition: c.precondition,
      input_schema: c.inputSchema,
      // 有专用端点的能力也可以走通用桥；两条路同一份实现、同一批判定
      rest: c.rest ?? null,
      bridge: { method: 'POST', path: `/api/v1/tools/${c.name}` },
    })),
  });
}
