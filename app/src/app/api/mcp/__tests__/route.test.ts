// app/src/app/api/mcp/__tests__/route.test.ts
// 手写的协议实现没有 SDK 兜底，形状错了要到真客户端连不上才发现，所以这里把
// initialize / tools/list / tools/call / notification 四条链路和错误分档全部钉死。
// 同时复验红线：换一把别人的 key，一个案件字段都不该看见。
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';

type Handler = (req: Request) => Promise<Response>;
let POST: Handler;
let db: Database;
let keyA: string;
let keyAReadOnly: string;
let keyB: string;
let caseA: number;

function rpc(body: unknown, key?: string, extraHeaders: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders };
  if (key) headers.authorization = `Bearer ${key}`;
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function issueKey(userId: number, scopes: string[]): string {
  const key = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-08-19T00:00:00.000Z')",
  ).run(userId, hashApiKey(key), JSON.stringify(scopes));
  return key;
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-mcp-${crypto.randomUUID()}.db`);

  POST = (await import('../route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const table of ['api_keys', 'timeline_events', 'action_items', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-08-19T00:00:00.000Z')",
  );
  const userA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  const userB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);
  caseA = Number(
    db
      .prepare(
        "INSERT INTO cases (user_id, title, stage, goal, created_at) VALUES (?, '甲的案子', '风声', '拿到 2N', '2026-08-19T00:00:00.000Z')",
      )
      .run(userA).lastInsertRowid,
  );
  keyA = issueKey(userA, ['case:read', 'case:write']);
  keyAReadOnly = issueKey(userA, ['case:read']);
  keyB = issueKey(userB, ['case:read', 'case:write']);
});

describe('鉴权', () => {
  test('没带 key → 401 且带 WWW-Authenticate', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  test('伪造的 key → 401', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, generateApiKey()));
    expect(res.status).toBe(401);
  });
});

describe('协议握手', () => {
  test('initialize 回 protocolVersion / capabilities / serverInfo', async () => {
    const res = await POST(
      rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, keyA),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'lawer-caiyuan' },
      },
    });
  });

  test('客户端要老版本就回老版本，要没听过的就回我们最新的', async () => {
    const old = await POST(
      rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, keyA),
    );
    expect((await old.json()).result.protocolVersion).toBe('2025-03-26');

    const unknown = await POST(
      rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, keyA),
    );
    expect((await unknown.json()).result.protocolVersion).toBe('2025-06-18');
  });

  /**
   * clientInfo.name 要落库。
   *
   * 【为什么这条值得单立】页面上「已接入：claude-code」那一行的名字就来自这里。
   * 握手照收、名字照丢的话，页面只能念用户自己给钥匙起的备注，
   * 于是**它看起来在报告"哪个助手接进来了"，其实只是在复读用户自己填的字**——
   * 这种假话没有任何报错，也没有任何人会去核对。
   */
  test('initialize 带 clientInfo.name → 落进 api_keys.client_name', async () => {
    const keyRow = () =>
      db.prepare('SELECT client_name FROM api_keys WHERE key_hash = ?').get(hashApiKey(keyA)) as {
        client_name: string | null;
      };
    expect(keyRow().client_name).toBeNull(); // 正对照：一开始确实是空的

    await POST(
      rpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } },
        },
        keyA,
      ),
    );
    expect(keyRow().client_name).toBe('claude-code');

    // 不报名字的那一次**不许把已有的名字抹掉**：同一把 key 换个不报名的客户端握手，
    // 页面会当场从「claude-code」退回「你给钥匙起的名」，而没有任何东西变坏。
    await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'initialize' }, keyA));
    expect(keyRow().client_name).toBe('claude-code');

    // 空白名同理：空格不是自报名
    await POST(
      rpc({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { clientInfo: { name: '   ' } } }, keyA),
    );
    expect(keyRow().client_name).toBe('claude-code');
  });

  test('自报名过长会被截到 64 字符——长度由我们定，不由对方定', async () => {
    await POST(
      rpc(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'x'.repeat(500) } } },
        keyA,
      ),
    );
    const row = db
      .prepare('SELECT client_name FROM api_keys WHERE key_hash = ?')
      .get(hashApiKey(keyA)) as { client_name: string | null };
    expect(row.client_name).toHaveLength(64);
  });

  test('MCP-Protocol-Version 头不认识 → 400；认识或不带 → 放行', async () => {
    const bad = await POST(
      rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, keyA, {
        'mcp-protocol-version': '2030-01-01',
      }),
    );
    expect(bad.status).toBe(400);

    const good = await POST(
      rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, keyA, {
        'mcp-protocol-version': '2025-06-18',
      }),
    );
    expect(good.status).toBe(200);
  });

  test('notifications/initialized（无 id）→ 202 空 body', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, keyA));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  test('坏 JSON / 非法消息 → JSON-RPC 错误码', async () => {
    const badJson = new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keyA}` },
      body: '{not json',
    });
    expect((await (await POST(badJson)).json()).error.code).toBe(-32700);

    const noMethod = await POST(rpc({ jsonrpc: '2.0', id: 1 }, keyA));
    expect((await noMethod.json()).error.code).toBe(-32600);

    const unknownMethod = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, keyA));
    expect((await unknownMethod.json()).error.code).toBe(-32601);
  });
});

describe('tools/list', () => {
  test('七个工具，每个都有 name / description / inputSchema', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, keyA));
    const { result } = await res.json();
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual([
      'case_get',
      'case_update',
      'timeline_add',
      'action_list',
      'action_complete',
      'deadline_list',
      'evidence_list',
    ]);
    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required).toContain('case_id');
    }
  });

  test('暂不交付的工具（计算器/文书/知识检索）一个都不许出现', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, keyA));
    const names: string[] = (await res.json()).result.tools.map((t: { name: string }) => t.name);
    for (const notYet of ['claim_calc', 'draft_write', 'knowledge_search', 'evidence_upload', 'docs_ocr']) {
      expect(names).not.toContain(notYet);
    }
  });
});

describe('tools/call', () => {
  async function call(name: string, args: Record<string, unknown>, key: string) {
    const res = await POST(
      rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, key),
    );
    return { status: res.status, body: await res.json() };
  }

  test('case_get 正常返回档案与时间线', async () => {
    const { body } = await call('case_get', { case_id: caseA }, keyA);
    expect(body.result.isError).toBe(false);
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.case).toMatchObject({ title: '甲的案子', goal: '拿到 2N' });
    expect(payload.timeline).toEqual([]);
  });

  test('写工具真的落库，读回来看得到', async () => {
    await call(
      'timeline_add',
      {
        case_id: caseA,
        happened_at: '2026-08-15T09:30:00+08:00',
        kind: '公司动作',
        title: 'HR 约谈',
      },
      keyA,
    );
    const { body } = await call('case_get', { case_id: caseA }, keyA);
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.timeline).toHaveLength(1);
    expect(payload.timeline[0].title).toBe('HR 约谈');
  });

  test('【红线】拿乙的 key 读甲的案件 → isError，且一个字段都不泄漏', async () => {
    const { body } = await call('case_get', { case_id: caseA }, keyB);
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0].text;
    expect(JSON.parse(text).error_code).toBe('CASE_NOT_FOUND');
    expect(text).not.toContain('甲的案子');
    expect(text).not.toContain('拿到 2N');
  });

  test('【红线】拿乙的 key 写甲的案件 → 拒绝且不留痕', async () => {
    const { body } = await call('case_update', { case_id: caseA, stage: '结案' }, keyB);
    expect(body.result.isError).toBe(true);

    const after = await call('case_get', { case_id: caseA }, keyA);
    expect(JSON.parse(after.body.result.content[0].text).case.stage).toBe('风声');
  });

  test('只读 key 调写工具 → JSON-RPC error（协议层拒绝，不是业务失败）', async () => {
    const { body } = await call('case_update', { case_id: caseA, stage: '已解除' }, keyAReadOnly);
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain('case:write');
    expect(body.result).toBeUndefined();

    // 只读 key 读是可以的
    const read = await call('case_get', { case_id: caseA }, keyAReadOnly);
    expect(read.body.result.isError).toBe(false);
  });

  test('未知工具名 → JSON-RPC error -32601，不是 isError', async () => {
    const { body } = await call('drop_database', {}, keyA);
    expect(body.error.code).toBe(-32601);
    expect(body.result).toBeUndefined();
  });

  test('arguments 不是对象 → -32602', async () => {
    const res = await POST(
      rpc(
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'case_get', arguments: [1, 2] } },
        keyA,
      ),
    );
    expect((await res.json()).error.code).toBe(-32602);
  });

  test('业务参数非法（枚举值不对）走 isError，让模型能自己纠正', async () => {
    const { body } = await call('case_update', { case_id: caseA, stage: '瞎写的阶段' }, keyA);
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error_code).toBe('INVALID_STAGE');
  });
});
