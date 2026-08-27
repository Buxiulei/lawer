// app/src/app/api/v1/agent-setup/__tests__/route.test.ts
// 一键接入信息。重点防三件事：
//   1. 未鉴权就把接入方式与接入说明全文吐出去
//   2. tools 清单与 MCP 注册表漂移（有人加了工具却忘了这里 → 用户 agent 拿到过时说明书）
//   3. 接入面混进某一家客户端的假设（spec D4：用户可能用任意 AI 助手）
import { beforeAll, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { signToken } from '@/lib/auth';
import { TOOLS } from '@/lib/mcp/tools';

type Handler = (req: Request) => Promise<Response>;
let agentSetup: Handler;

function get(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/v1/agent-setup', { method: 'GET', headers });
}

beforeAll(async () => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-agent-setup-${crypto.randomUUID()}.db`);
  delete process.env.LAWER_PUBLIC_URL;
  agentSetup = (await import('../route')).GET;
});

describe('GET /api/v1/agent-setup', () => {
  test('没带凭据 → 401 UNAUTHORIZED', async () => {
    const res = await agentSetup(get());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error_code: 'UNAUTHORIZED' });
  });

  test('token 伪造或过期 → 401', async () => {
    const expired = signToken(1, new Date('2020-01-01T00:00:00Z'));
    for (const bad of [`Bearer ${expired}`, 'Bearer nonsense']) {
      expect((await agentSetup(get({ authorization: bad }))).status).toBe(401);
    }
  });

  test('带 JWT → 字段齐全，tools 与 MCP 注册表逐条一致', async () => {
    const res = await agentSetup(get({ authorization: `Bearer ${signToken(1)}` }));
    expect(res.status).toBe(200);
    const body = await res.json();

    // 没配 LAWER_PUBLIC_URL 时退回请求自身 origin
    expect(body.mcp_url).toBe('http://localhost/api/mcp');
    expect(body.api_base).toBe('http://localhost/api/v1');
    expect(body.manifest_url).toBe('http://localhost/api/manifest');
    expect(body.tools).toEqual(TOOLS.map((t) => ({ name: t.name, description: t.description })));
    // 接入说明读的是仓库根 skill/ 的真文件，不是硬编码进 TS 的字符串
    expect(body.setup_markdown).toContain('# 土八鼠 · 接入说明');
    expect(body.setup_markdown).toContain('case_get');
  });

  test('接入面不含客户端专属假设：返回的是 MCP/REST 两个标准，不绑某一家助手', async () => {
    const res = await agentSetup(get({ authorization: `Bearer ${signToken(1)}` }));
    const body = await res.json();

    // 客户端名不该出现在字段值里（说明书里提到"支持哪些客户端"是允许的，故只查结构化字段）
    const structured = JSON.stringify({ ...body, setup_markdown: undefined });
    for (const vendor of ['Claude', 'claude', 'Codex', '豆包', 'Trae', 'Cursor']) {
      expect(structured).not.toContain(vendor);
    }
    // 两条路都得给全：不支持 MCP 的客户端要能走 REST
    expect(body.api_base).toBeTruthy();
    expect(body.manifest_url).toBeTruthy();
    expect(body.setup_markdown).toContain('REST');
  });

  test('配了 LAWER_PUBLIC_URL 就用它当基址（结尾斜杠不影响）', async () => {
    process.env.LAWER_PUBLIC_URL = 'https://lawer.example.com/';
    const res = await agentSetup(get({ authorization: `Bearer ${signToken(1)}` }));
    const body = await res.json();
    expect(body.mcp_url).toBe('https://lawer.example.com/api/mcp');
    delete process.env.LAWER_PUBLIC_URL;
  });
});
