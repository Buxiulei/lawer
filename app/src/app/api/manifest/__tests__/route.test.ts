// app/src/app/api/manifest/__tests__/route.test.ts
// /api/manifest 是对方 agent 接入前读的自描述清单。上一单发现两处缺口：
// 裸 GET /cases 与 POST /cases/{id}/intake 没登记——清单里没有的端点，对方就不知道能调。
// 这里把这两条钉进清单，并守 intake_submit 出现在 mcp 工具列。
import { describe, expect, test } from 'vitest';

import { GET } from '../route';

type Endpoint = { method: string; path: string; scope?: string };

async function manifest() {
  return (await GET()).json() as Promise<{
    rest: { endpoints: Endpoint[] };
    mcp: { tools: { name: string; scope: string }[] };
  }>;
}

describe('自描述清单', () => {
  test('裸 GET /cases 已登记（对应 MCP case_list）', async () => {
    const { rest } = await manifest();
    const ep = rest.endpoints.find((e) => e.method === 'GET' && e.path === '/api/v1/cases');
    expect(ep, 'GET /cases 没进清单，对方 agent 只能靠猜').toBeDefined();
    expect(ep!.scope).toBe('case:read');
  });

  test('POST /cases/{id}/intake 已登记（对应 MCP intake_submit）', async () => {
    const { rest } = await manifest();
    const ep = rest.endpoints.find(
      (e) => e.method === 'POST' && e.path === '/api/v1/cases/{id}/intake',
    );
    expect(ep, 'POST intake 没进清单，走 REST 的客户端建不了档').toBeDefined();
    expect(ep!.scope).toBe('case:write');
  });

  test('intake_submit 在 mcp 工具列里，scope 为 case:write', async () => {
    const { mcp } = await manifest();
    const tool = mcp.tools.find((t) => t.name === 'intake_submit');
    expect(tool).toBeDefined();
    expect(tool!.scope).toBe('case:write');
  });
});
