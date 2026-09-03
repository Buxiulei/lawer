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
import { CASE_FACTS_BUDGET, createKnowledgeSearcher, packCitationGuide } from '@/lib/agent';

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
  /**
   * 顺序也钉死：客户端把这份清单原样展示给用户，往中间插一个工具等于面板重排。
   * 后加的两个（case_facts / knowledge_search）追加在末尾。
   */
  const CASE_SCOPED = [
    'case_get',
    'case_update',
    'timeline_add',
    'action_list',
    'action_complete',
    'deadline_list',
    'evidence_list',
    'case_facts',
  ];

  test('九个工具，每个都有 name / description / inputSchema', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, keyA));
    const { result } = await res.json();
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual([
      ...CASE_SCOPED,
      'knowledge_search',
    ]);
    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  test('操作案件的那八个都必填 case_id——少一个就是能不指名道姓地读写档案', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, keyA));
    const { result } = await res.json();
    const byName = new Map<string, { inputSchema: { required?: string[] } }>(
      result.tools.map((t: { name: string }) => [t.name, t]),
    );
    for (const name of CASE_SCOPED) {
      expect(byName.get(name)!.inputSchema.required, name).toContain('case_id');
    }
  });

  /**
   * knowledge_search 是**全库检索，不隶属任何案件**，所以它是这份清单里唯一没有
   * case_id 的工具。把 case_id 加进它的 required 会让对方 agent 在"还没问出案件 id"
   * 的时候查不了法条——而查法条这件事本来不需要知道是谁的案子。
   */
  test('knowledge_search 要 query、不要 case_id', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, keyA));
    const { result } = await res.json();
    const tool = result.tools.find((t: { name: string }) => t.name === 'knowledge_search');
    expect(tool.inputSchema.required).toEqual(['query']);
    expect(tool.inputSchema.required).not.toContain('case_id');
  });

  test('暂不交付的工具（计算器/文书/上传/OCR）一个都不许出现', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, keyA));
    const names: string[] = (await res.json()).result.tools.map((t: { name: string }) => t.name);
    for (const notYet of ['claim_calc', 'draft_write', 'evidence_upload', 'docs_ocr']) {
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

  describe('case_facts', () => {
    test('返回渲染好的事实卡，且不超预算', async () => {
      const { body } = await call('case_facts', { case_id: caseA }, keyA);
      expect(body.result.isError).toBe(false);
      const { case_facts } = JSON.parse(body.result.content[0].text) as { case_facts: string };
      expect(case_facts).toContain('案件事实卡');
      expect(case_facts).toContain('甲的案子');
      // 预算由 renderCaseFacts 后置保证；绕过它直接 JSON 化 snapshot 时这条会红
      expect(case_facts.length).toBeLessThanOrEqual(CASE_FACTS_BUDGET);
    });

    test('档案里没有的项写「未记录」，不是默认值', async () => {
      const { body } = await call('case_facts', { case_id: caseA }, keyA);
      const { case_facts } = JSON.parse(body.result.content[0].text) as { case_facts: string };
      // 这个案子只建了抬头，用工基本盘一项都没填
      expect(case_facts).toContain('未记录');
    });

    /**
     * 【本单最严重的一类回归】loadCaseSnapshot 只按 caseId 取数、不认识 user_id：
     * 漏掉 lib/cases 那道归属门，这个工具会把**别人的**事实卡整张交出去，
     * 而且返回 200、格式完全正常。
     */
    test('【红线】拿乙的 key 读甲的事实卡 → isError，一个字段都不泄漏', async () => {
      const { body } = await call('case_facts', { case_id: caseA }, keyB);
      expect(body.result.isError).toBe(true);
      const text = body.result.content[0].text;
      expect(JSON.parse(text).error_code).toBe('CASE_NOT_FOUND');
      expect(text).not.toContain('甲的案子');
      expect(text).not.toContain('拿到 2N');
    });
  });

  describe('knowledge_search', () => {
    test('检索得到卡，带 citation_guide 与 confidence', async () => {
      const { body } = await call('knowledge_search', { query: '经济补偿 计算' }, keyA);
      expect(body.result.isError).toBe(false);
      const payload = JSON.parse(body.result.content[0].text) as {
        packs: { id: string; confidence: string; citation_guide: string; excerpt: string }[];
      };
      expect(payload.packs.length).toBeGreaterThan(0);
      for (const p of payload.packs) {
        expect(p.id).toBeTruthy();
        expect(p.confidence).toBeTruthy();
        expect(typeof p.citation_guide).toBe('string');
      }
    });

    test('正文摘要有上限——整卡一万两千字塞进一次 tools/call 会占满对方一轮上下文', async () => {
      const { body } = await call('knowledge_search', { query: '经济补偿 计算' }, keyA);
      const payload = JSON.parse(body.result.content[0].text) as { packs: { excerpt: string }[] };
      for (const p of payload.packs) {
        // 1200 是摘要上限，加上截断留痕那句仍远小于整卡
        expect(p.excerpt.length).toBeLessThan(1400);
      }
    });

    test('空 query → isError，不打一次空检索', async () => {
      for (const args of [{ query: '' }, { query: '   ' }, {}]) {
        const { body } = await call('knowledge_search', args, keyA);
        expect(body.error, JSON.stringify(args)).toBeUndefined();
        expect(body.result.isError, JSON.stringify(args)).toBe(true);
        expect(JSON.parse(body.result.content[0].text).error_code).toBe('INVALID_QUERY');
      }
    });

    /**
     * 引用块必须与站内 agent 那条通路**同一个函数**产出。手写第二份的形态是：
     * 同一条法条在网页里和在用户自己的助手里长得不一样，而两边各自都读得通顺。
     */
    test('citation_guide 与 lib/agent 的 packCitationGuide 逐字相同', async () => {
      const { body } = await call('knowledge_search', { query: '经济补偿 计算', limit: 3 }, keyA);
      const payload = JSON.parse(body.result.content[0].text) as {
        packs: { id: string; citation_guide: string }[];
      };
      expect(payload.packs.length).toBeGreaterThan(0);
      const searcher = createKnowledgeSearcher();
      for (const p of payload.packs) {
        const pack = searcher.get!(p.id)!;
        expect(p.citation_guide, p.id).toBe(packCitationGuide(pack));
      }
    });
  });
});
