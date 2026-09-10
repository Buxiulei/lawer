// app/src/app/api/mcp/__tests__/route.test.ts
// 手写的协议实现没有 SDK 兜底，形状错了要到真客户端连不上才发现，所以这里把
// initialize / tools/list / tools/call / notification 四条链路和错误分档全部钉死。
// 同时复验红线：换一把别人的 key，一个案件字段都不该看见。
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { decryptField, encryptField } from '@/lib/crypto';
import { CONSENT_KINDS } from '@/lib/consent';
import { recordConsent } from '@/lib/db/consents';
import * as realnameStore from '@/lib/db/realname';
import type { NbdpsySnapshot } from '@/lib/referral/identity-link';
import { getGongdao, gongdaoSettle } from '@/lib/billing';
import {
  CASE_FACTS_BUDGET,
  MAX_INJECTED_PACKS,
  createKnowledgeSearcher,
  packCitationGuide,
} from '@/lib/agent';

type Handler = (req: Request) => Promise<Response>;
let POST: Handler;
let db: Database;
let keyA: string;
let keyAReadOnly: string;
let keyB: string;
let caseA: number;
let ownerA: number;
let ownerB: number;

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
  for (const table of [
    // agent_writes 排在最前：它的 key_id 外键指向 api_keys 且**没有级联**，
    // 台账留着行时先删 api_keys 会 FOREIGN KEY constraint failed。
    // （写能力经这道门跑完会落台账行——见 route.ts 里的 recordCapabilityWrite。）
    'agent_writes',
    'api_keys', 'timeline_events', 'action_items', 'cases',
    // 余额闸那一轮之后，本组要造负余额；gongdao 两张表外键指向 users，得先于它清。
    // realname_verifications 同样外键指向 users 且无级联（互认那组会往里落行），也得先于 users 清。
    'token_usage', 'gongdao_ledger', 'gongdao', 'realname_verifications', 'users',
  ]) {
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
  ownerA = userA;
  ownerB = userB;
});

describe('鉴权', () => {
  test('没带 key → 401 且带 WWW-Authenticate', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    expect(res.status).toBe(401);
    // resource_metadata 那一段是只认 OAuth 的客户端找到授权服务器的唯一线索（RFC 9728）；
    // 具体内容由 api/oauth 那组判据钉，这里只确认 401 仍然带着 Bearer 挑战。
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer\b/);
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
   * 后加的几个（case_facts / knowledge_search / case_list / intake_submit / knowledge_get）一律追加在末尾。
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

  test('清单与顺序钉死，每个都有 name / description / inputSchema', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, keyA));
    const { result } = await res.json();
    // knowledge_search / case_list 不隶属案件；其余后加的一律**追加在末尾**（顺序钉死，见上）
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual([
      ...CASE_SCOPED,
      'knowledge_search',
      'case_list',
      'intake_submit',
      // 金额 / 期限 / 行动的写能力，同样**追加在末尾**
      'claim_calc',
      'claims_upsert',
      'claims_list',
      'deadline_set',
      'deadline_resolve',
      'action_create',
      // 时间线 / 文书 / 公司主体 / 情绪，同样**追加在末尾**
      'timeline_list',
      'timeline_milestone',
      'draft_list',
      'draft_get',
      'draft_write',
      'company_profile_upsert',
      'emotion_log',
      'knowledge_get',
      // 证据的详情 / 提取 / 简报，同样**追加在末尾**
      'evidence_get',
      'evidence_extract',
      'evidence_brief_get',
      'evidence_brief_update',
      // 来文与录音，同样**追加在末尾**
      'doc_submit',
      'doc_list',
      'doc_get',
      'transcript_submit',
      // 证据的上传→登记→出证→核验四条，同样**追加在末尾**
      'evidence_upload_url',
      'evidence_register',
      'evidence_attest',
      'attest_verify',
      'case_report_get',
      'case_report_update',
      // 危机检查 / 身份与账户，同样**追加在末尾**
      'crisis_check',
      'me_get',
      'quote_list',
      // 引用核验，同样**追加在末尾**
      'citation_check',
      // 对方主体情报（免费探测 → 报价 → 确认 → 读档 / 关系图 / 守望），同样**追加在末尾**
      'company_probe',
      'dossier_quote',
      'dossier_confirm',
      'dossier_get',
      'company_graph_get',
      'company_watch_set',
      // 分享与导出，同样**追加在末尾**
      'share_create',
      'share_revoke',
      'draft_export',
      // 转介，同样**追加在末尾**
      'referral_create',
      'referral_list',
      // 作废与简报重生成，同样**追加在末尾**
      'evidence_void',
      'evidence_brief_regenerate',
      // 数据生命周期（删除 / 整案导出 / 转介删除请求），同样**追加在末尾**
      'case_delete',
      'case_export',
      'referral_delete_request',
      // 要件与争点（S6），同样**追加在末尾**
      'element_sheet_get',
      'issue_list',
      'element_fill',
    ]);
    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  test('操作案件的工具都必填 case_id——少一个就是能不指名道姓地读写档案', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, keyA));
    const { result } = await res.json();
    const byName = new Map<string, { inputSchema: { required?: string[] } }>(
      result.tools.map((t: { name: string }) => [t.name, t]),
    );
    // intake_submit 也隶属某个案件（往哪个案子建档），同样必须点名 case_id
    for (const name of [
      ...CASE_SCOPED,
      'intake_submit',
      'claim_calc',
      'claims_upsert',
      'claims_list',
      'deadline_set',
      'deadline_resolve',
      'action_create',
      // W2 七条里除 draft_get（按 draft_id 取，归属在草稿上判）外都隶属案件
      'timeline_list',
      'timeline_milestone',
      'draft_list',
      'draft_write',
      'company_profile_upsert',
      'emotion_log',
      // 对方主体情报里隶属案件的四条（company_probe 是全库查主体、dossier_confirm 按报价号，
      // 报价号自己带着 case_id，故这两条不在名单里）
      'dossier_quote',
      'dossier_get',
      'company_graph_get',
      'company_watch_set',
    ]) {
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

  /*
   * 【knowledge_search 已从这份名单里删掉】它曾经与下面四项并列在「暂不交付」里。
   * 2026-09-03 经理裁决：**接受已交付**（ws/byo-key-rotate 复审台账，本单第 8 项）——
   * 它在 1a2ae29 随 case_facts 一起上线，走的是站内 agent 同一个 createKnowledgeSearcher，
   * 不在我们这边调模型。名单留着它的形态是：一条永远红的守卫钉着一件已经做完的事，
   * 下一个人要么删判据要么删功能，而两条路都没有台账可依。其余四项原样禁止。
   */
  /* 【claim_calc 也从名单里出去了】它随金额/期限/行动写能力一起交付，走的是
   * lib/cases/claims 里站内 agent 用的同一个 runClaimCalc，没有第二份公式。
   * 理由与上面 knowledge_search 那条一样：名单留着一件已经做完的事，只会逼下一个人
   * 在「删判据」和「删功能」之间选一个。 */
  /*
   * 【draft_write 同样已从名单里删掉】设计稿 §11 把 draft_list/get/write 排在 P1，
   * 本单交付：它走的是 lib/cases.writeDraft，与站内对话同一道「对外文书缺发出后果就拒收」
   * 的闸门（lib/cases/drafts 那一份清单）。留着它的形态与上面 knowledge_search 那条一样——
   * 一条永远红的守卫钉着一件已经做完的事。其余两项原样禁止。
   */
  test('暂不交付的工具（上传/OCR）一个都不许出现', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, keyA));
    const names: string[] = (await res.json()).result.tools.map((t: { name: string }) => t.name);
    for (const notYet of ['evidence_upload', 'docs_ocr']) {
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

  /**
   * 【为什么这条要先取 facts_token（2026-09-10 改）】改 stage 挂着 facts_token 闸，
   * 而闸排在能力的入参校验之前——这道门此前不把 args 交给前置闸，于是闸恒不开，
   * 这条判据当时验的是「闸不在」时的顺序。闸接上之后不带令牌的同一次调用回的是
   * FACTS_STALE，**不能为了保住这条判据反过来让 stage 校验插到闸前面**：
   * 那样的话一份过期认知照样能把非法阶段推到服务端跟前，两道门的顺序也就分叉了。
   * 所以这里照通用桥的走法先读一次事实卡，再验枚举错仍走 isError。
   */
  test('业务参数非法（枚举值不对）走 isError，让模型能自己纠正', async () => {
    const facts = await call('case_facts', { case_id: caseA }, keyA);
    const { facts_token } = JSON.parse(facts.body.result.content[0].text) as { facts_token: string };
    const { body } = await call('case_update', { case_id: caseA, stage: '瞎写的阶段', facts_token }, keyA);
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error_code).toBe('INVALID_STAGE');
  });

  // 上一条走的是同步能力：run 直接返回对象，漏掉 await 也照样对。异步能力（要外呼模型或 sidecar）
  // 回的是 Promise，`outcome.ok === false` 判在 Promise 上永远不成立 ⇒ 失败被当成成功，
  // 正文变成「[object Promise]」——回包 isError:false、内容一个字看不懂，模型无从纠正。
  // 所以这条判据必须挑一个 run 是 async 的工具（transcript_submit），且把正文也钉住。
  test('异步能力回 ok:false 同样走 isError，正文不是 [object Promise]', async () => {
    const { body } = await call('transcript_submit', { evidence_id: 999999 }, keyA);
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0].text as string;
    expect(text).not.toContain('Promise');
    expect(typeof JSON.parse(text).error_code).toBe('string');
  });

  /*
   * 【失败对象上的结构化字段必须过得了 MCP 这一层】claim_calc 的工具描述向对方 agent
   * 承诺「回包里有 missing / invalid 两张表」，而 MCP 是它唯一的对外面（没有 REST 面）。
   * 直调 runClaimCalc 的判据（lib/cases/__tests__/claim-calc-all-problems）钉的是算子那一层，
   * 抓不到这一层：路由把失败对象收窄成 {errorCode,message} 时，isError 照样 true、
   * 中文 message 照样列全三项，只有那两张表静默消失——照描述去读结构化字段的 agent
   * 读到 undefined，只能回头解析中文，或一次只补一个问题。所以这条走真实回包。
   */
  test('claim_calc 缺参：missing / invalid 两张表要出现在 MCP 回包里', async () => {
    const { body } = await call('claim_calc', { case_id: caseA, kind: 'N' }, keyA);
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.error_code).toBe('INVALID_CALC_INPUT');
    // 负例的核心：不是「有个 error_code 就算过」，而是两张表都在、且内容对得上
    expect(Array.isArray(payload.missing)).toBe(true);
    expect(payload.missing).toHaveLength(3);
    for (const field of ['avg_monthly_wage_fen', 'employed_from', 'terminated_at']) {
      expect(payload.missing.join(' ')).toContain(field);
    }
    expect(payload.invalid).toEqual([]);
    // 人读的那份与两张表同源，一次列全
    expect(payload.message).toContain('缺少 3 项');
    // 内部分档字段不外泄：ok / status 是 HTTP 面的事，对方 agent 不该看到
    expect(payload.ok).toBeUndefined();
    expect(payload.status).toBeUndefined();
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
     * limit 归一到 [1, MAX]。
     *
     * 【为什么这条判据不是形式主义】limit 是对面模型自己填的数。原来的
     * `Math.min(Number(x) || MAX, MAX)` 把负数原样放行：实测 limit=-5 时检索器回
     * **30 张卡**，每张最长 1200 字摘要，一次 tools/call 就把对方一轮上下文填满——
     * 而它返回 200、格式完全正常，没有任何一处会报错。
     */
    test('limit 越界一律夹回 [1, MAX]，不报错也不回 0 张', async () => {
      const packsOf = async (args: Record<string, unknown>) => {
        const { body } = await call('knowledge_search', { query: '经济补偿 计算', ...args }, keyA);
        expect(body.result.isError, JSON.stringify(args)).toBe(false);
        return (JSON.parse(body.result.content[0].text) as { packs: unknown[] }).packs;
      };

      // 正对照：这条 query 本身命中足够多，下面「夹到 1」「不超 MAX」才量得出来
      const full = await packsOf({});
      expect(full).toHaveLength(MAX_INJECTED_PACKS);

      // 夹下界：负数与 0 都不是「不限」也不是「一张都不要」
      for (const bad of [-5, -1, 0, 0.4]) {
        const got = await packsOf({ limit: bad });
        expect(got.length, `limit=${bad}`).toBeGreaterThanOrEqual(1);
        expect(got.length, `limit=${bad}`).toBeLessThanOrEqual(MAX_INJECTED_PACKS);
      }
      // 夹上界：要多少都不给超
      for (const big of [MAX_INJECTED_PACKS + 1, 9999]) {
        expect((await packsOf({ limit: big })).length, `limit=${big}`).toBe(MAX_INJECTED_PACKS);
      }
      // 压根不是个数：落回默认满额，而不是 NaN 一路传进检索器
      for (const junk of ['abc', null, true, {}]) {
        expect((await packsOf({ limit: junk })).length, JSON.stringify(junk)).toBe(
          MAX_INJECTED_PACKS,
        );
      }
      // 正对照：合法的 limit 照旧说了算（否则上面全绿也可能只是「limit 从此没人看」）
      expect(await packsOf({ limit: 1 })).toHaveLength(1);
      expect(await packsOf({ limit: 2 })).toHaveLength(2);
      expect(await packsOf({ limit: 2.7 })).toHaveLength(2);
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

  describe('case_list', () => {
    test('列出本人全部案件（case_id/抬头/阶段/建档时间），无需入参', async () => {
      const { body } = await call('case_list', {}, keyA);
      expect(body.result.isError).toBe(false);
      const { cases } = JSON.parse(body.result.content[0].text) as {
        cases: { case_id: number; title: string; stage: string; created_at: string }[];
      };
      expect(cases).toHaveLength(1);
      expect(cases[0]).toMatchObject({ case_id: caseA, title: '甲的案子', stage: '风声' });
      expect(cases[0].created_at).toBeTruthy();
    });

    /**
     * 【变异臂】case_list 若忘了按 userId 过滤（列全库案件），这两条红：
     * 甲只该看见甲的案件、乙只该看见乙的，谁都看不见对方的抬头。
     */
    test('【红线】只列本人案件，看不见别人的', async () => {
      db.prepare(
        "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, '乙的案子', '风声', '2026-08-19T00:00:00.000Z')",
      ).run(ownerB);

      const listOf = async (key: string) => {
        const { body } = await call('case_list', {}, key);
        expect(body.result.isError).toBe(false);
        return JSON.parse(body.result.content[0].text) as {
          cases: { title: string }[];
        };
      };

      const a = await listOf(keyA);
      expect(a.cases.map((c) => c.title)).toEqual(['甲的案子']);

      const b = await listOf(keyB);
      expect(b.cases.map((c) => c.title)).toEqual(['乙的案子']);
    });
  });

  describe('intake_submit', () => {
    const INTAKE = {
      stage: '已收通知',
      company_name: '华衡永泰供应链管理有限公司',
      employed_from: '2021-04-12',
      monthly_wage_yuan: 22000,
      position: '仓储主管',
      contract_count: '只签过一次',
      events: [{ date: '2026-08-28', text: '部门开会说要优化' }],
      goals: ['违法解除赔偿金（2N）'],
      bottom_line: '低于 2N 不签。',
    };

    test('写入后事实卡里用工基本盘不再「未记录」，金额按元换算成分', async () => {
      const submit = await call('intake_submit', { case_id: caseA, ...INTAKE }, keyA);
      expect(submit.body.result.isError).toBe(false);

      const { body } = await call('case_facts', { case_id: caseA }, keyA);
      const { case_facts } = JSON.parse(body.result.content[0].text) as { case_facts: string };
      expect(case_facts).toContain('入职日期：2021-04-12');
      expect(case_facts).toContain('岗位：仓储主管');
      // 22000 元 → 2_200_000 分 → 渲染 22000.00 元
      expect(case_facts).toContain('月工资：22000.00 元');
    });

    /**
     * 【红线 / 变异臂】intake_submit 若漏了 lib/cases 那道 assertOwned，
     * 会往别人的案子建档且返回正常——这条钉住它走的是 cases.submitIntake（含归属门）。
     */
    test('【红线】拿乙的 key 往甲的案子建档 → isError CASE_NOT_FOUND，且不留痕', async () => {
      const { body } = await call('intake_submit', { case_id: caseA, ...INTAKE }, keyB);
      expect(body.result.isError).toBe(true);
      expect(JSON.parse(body.result.content[0].text).error_code).toBe('CASE_NOT_FOUND');

      // 甲的案子一个字段都没被动
      const facts = await call('case_facts', { case_id: caseA }, keyA);
      expect(JSON.parse(facts.body.result.content[0].text).case_facts).toContain('入职日期：未记录');
    });

    test('校验失败回字段级原因（金额非法）走 isError，让模型能自己补', async () => {
      const { body } = await call(
        'intake_submit',
        { case_id: caseA, ...INTAKE, monthly_wage_yuan: 0 },
        keyA,
      );
      expect(body.error).toBeUndefined();
      expect(body.result.isError).toBe(true);
      expect(JSON.parse(body.result.content[0].text).error_code).toBe('INVALID_MONTHLY_WAGE');
    });
  });

  describe('case_update 用工基本盘', () => {
    test('四项基本盘可经 MCP 单独更新（元换算成分），读回来对得上', async () => {
      const upd = async (args: Record<string, unknown>) => {
        const { body } = await call('case_update', { case_id: caseA, ...args }, keyA);
        expect(body.result.isError, JSON.stringify(args)).toBe(false);
      };
      await upd({ employed_from: '2020-01-06' });
      await upd({ monthly_wage_yuan: 18000 });
      await upd({ position: '后端工程师' });
      await upd({ contract_count: '续签过一次' });

      const { body } = await call('case_facts', { case_id: caseA }, keyA);
      const { case_facts } = JSON.parse(body.result.content[0].text) as { case_facts: string };
      expect(case_facts).toContain('入职日期：2020-01-06');
      expect(case_facts).toContain('月工资：18000.00 元');
      expect(case_facts).toContain('岗位：后端工程师');
    });
  });

  describe('timeline_add 幂等', () => {
    const rows = () =>
      db.prepare('SELECT id, title FROM timeline_events WHERE case_id = ?').all(caseA) as {
        id: number;
        title: string;
      }[];

    test('同 client_ref 重放只落一行，deduped:true', async () => {
      const ev = { case_id: caseA, happened_at: '2026-08-15T09:30:00+08:00', kind: '公司动作', title: 'HR 约谈', client_ref: 'op-1' };
      await call('timeline_add', ev, keyA);
      const again = await call('timeline_add', { ...ev, happened_at: '2026-08-16T09:30:00+08:00' }, keyA);
      expect(JSON.parse(again.body.result.content[0].text).deduped).toBe(true);
      expect(rows()).toHaveLength(1);
    });

    test('无 client_ref 近重复（同日同类标题去标点相等）只落一行；真不同的照落', async () => {
      const base = { case_id: caseA, happened_at: '2026-08-20T09:00:00+08:00', kind: '公司动作' };
      await call('timeline_add', { ...base, title: 'HR 约谈，宣布裁员' }, keyA);
      await call('timeline_add', { ...base, title: 'HR约谈，宣布裁员。' }, keyA); // 近重复 → 不落
      await call('timeline_add', { ...base, title: '收到解除通知' }, keyA); // 真不同 → 落
      expect(rows()).toHaveLength(2);
    });
  });
});

/* ── 余额闸不装到这里（主理人 2026-09-03「拦」第 3 条）─────────────────
   网页对话余额 ≤ 0 就拦；**MCP 与 v1 案件数据路由不设闸、也不扣费**。
   理由是「我的」页上印着的那句事实：数据读写不花钱，只有我们替你调模型才花钱
   （account/self-host-hint.test.tsx 按源码把「只有 orchestrator 等三处扣费」钉死了）。
   两条判据分工：那一条守「不扣」，这一条守「不拦」——一个把闸抄到 MCP 上的改动
   不会新增任何 gongdaoSettle 调用点，那边全绿，只有这里会红。

   变异臂 M-G7：给 MCP 路由加同一道 canStartTurn 闸 ⇒ 本组两条全红。 */
describe('MCP 不设余额闸', () => {
  /** 把某人的余额压到 -100：比「刚好欠一轮」更狠，网页那边这种账号一句话都发不出去。 */
  function goNegative(userId: number, amount = 100): void {
    gongdaoSettle(userId, amount, `mcp-gate-probe-${userId}`, 'companion', null, db);
    expect(getGongdao(userId, db)).toBe(-amount);
  }

  test('余额 -100 的 key 照样 initialize 200', async () => {
    goNegative(ownerA);
    const res = await POST(
      rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, keyA),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ serverInfo: { name: 'lawer-caiyuan' } });
  });

  test('余额 -100 的 key 照样 tools/list 与 tools/call 200，且一分不扣', async () => {
    goNegative(ownerA);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM gongdao_ledger').get() as { n: number }).n;

    const list = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, keyA));
    expect(list.status).toBe(200);
    expect((await list.json()).result.tools.length).toBeGreaterThan(0);

    const call = await POST(
      rpc(
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'case_get', arguments: { case_id: caseA } } },
        keyA,
      ),
    );
    expect(call.status).toBe(200);
    expect((await call.json()).result.isError).toBe(false);

    // 读写数据不记账：余额还是那个 -100，账本没多出一行
    expect(getGongdao(ownerA, db)).toBe(-100);
    expect((db.prepare('SELECT COUNT(*) AS n FROM gongdao_ledger').get() as { n: number }).n).toBe(before);
  });
});

// ───────────────── 实名互认：前置闸与证据 REST 同一道 OrLinked 判定 ─────────────────
//
// 互认判定（本地没实名 → 问一次 NBDpsy → approved 就采信并落掩码快照）此前只长在证据
// REST 的 requireRealname 上；MCP 与通用桥的前置闸用的是纯本地的 isRealnameVerified。
// 于是「已在 NBDpsy 实名、本地没实名」的人在证据 REST 侧放行、在 MCP 侧被 403——
// 同一人同一条能力，两条入口两个答案，两边都不报错。闸改成 async 调 realnameVerifiedOrLinked
// 后，这组在 MCP 这条路上钉住：approved 放行且落掩码快照；对方没通过/连不上一律 403；
// 本地已实名不去问对方。
//
// 【变异臂】把 invoke.checkPreconditions 改回 isRealnameVerified ⇒ 第一条当场红
// （本地未实名的人仍被 403，快照那一行也不出现）。互认落库存证件全号 ⇒ 第一条「快照不含明文」红。
describe('实名互认：前置闸认同一口径（NBDpsy OrLinked）', () => {
  const FULL_ID = '110101199001011234';
  const envBackup = {
    base: process.env.NBDPSY_INTERNAL_BASE,
    secret: process.env.NBDPSY_INTERNAL_SECRET,
  };
  let fetchOriginal: typeof globalThis.fetch;

  beforeEach(() => {
    process.env.NBDPSY_INTERNAL_BASE = 'http://127.0.0.1:9';
    process.env.NBDPSY_INTERNAL_SECRET = 'test-shared-secret';
    fetchOriginal = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
    if (envBackup.base === undefined) delete process.env.NBDPSY_INTERNAL_BASE;
    else process.env.NBDPSY_INTERNAL_BASE = envBackup.base;
    if (envBackup.secret === undefined) delete process.env.NBDPSY_INTERNAL_SECRET;
    else process.env.NBDPSY_INTERNAL_SECRET = envBackup.secret;
  });

  /** 无论问什么手机号都回同一份对方回包；counter 记它被打了几次。 */
  function identityFetch(body: Record<string, unknown>, counter?: { n: number }): typeof fetch {
    return (async () => {
      if (counter) counter.n += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  }

  /** 带手机号（互认匹配键）的用户 + 一件案子 + 一把可写 key。 */
  function makeLinkedUser(authStatus = '未认证'): { uid: number; key: string; caseId: number } {
    const phone = `link-${crypto.randomUUID()}`;
    const uid = Number(
      db
        .prepare(
          'INSERT INTO users (phone_enc, phone_hash, auth_status, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(encryptField(phone), phone, authStatus, '2026-08-19T00:00:00.000Z').lastInsertRowid,
    );
    const caseId = Number(
      db
        .prepare(
          "INSERT INTO cases (user_id, title, stage, goal, created_at) VALUES (?, '互认者', '风声', '拿到 2N', '2026-08-19T00:00:00.000Z')",
        )
        .run(uid).lastInsertRowid,
    );
    const key = generateApiKey();
    db.prepare(
      "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-08-19T00:00:00.000Z')",
    ).run(uid, hashApiKey(key), JSON.stringify(['case:read', 'case:write']));
    return { uid, key, caseId };
  }

  /** 调一次 MCP evidence_register，回 JSON-RPC 结果体。 */
  async function register(key: string, caseId: number) {
    const res = await POST(
      rpc(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: {
            name: 'evidence_register',
            arguments: { case_id: caseId, upload_token: 'not-a-real-token', name: '工资条' },
          },
        },
        key,
      ),
    );
    return res.json();
  }

  test('本地未实名 + 对方 approved ⇒ 放行并落 provider=nbdpsy 掩码快照', async () => {
    const u = makeLinkedUser();
    // 采用要先有单独同意（协议三.3）；本条测的是采用之后 MCP 这条路放不放行。
    // 「没同意就不许采用」那一臂在 lib/referral/__tests__/referral.test.ts 与
    // app/api/v1/tools/__tests__/route.test.ts 各有一条（三面同一道闸，判定只有一处）。
    recordConsent(db, { userId: u.uid, kind: CONSENT_KINDS.realnameAdopt });
    const calls = { n: 0 };
    globalThis.fetch = identityFetch(
      {
        verified: true,
        real_name: '张三',
        id_type: 'idcard',
        id_number_masked: FULL_ID, // 对方即使往掩码键回了全号
        id_no: FULL_ID, // 甚至另给一个明文键
        verified_at: '2026-08-01T10:00:00Z',
        customer_code: 'C-1',
      },
      calls,
    );

    const body = await register(u.key, u.caseId);

    // 闸过了：run 因假 token 停在 UPLOAD_TOKEN_NOT_FOUND（isError=true 但不是实名闸）
    const text = body.result.content[0].text as string;
    expect(JSON.parse(text).error_code, text).not.toBe('REALNAME_REQUIRED');
    expect(calls.n, '本地未实名必须去问一次对方').toBe(1);

    const row = realnameStore.latestByUser(db, u.uid)!;
    expect(row.provider).toBe('nbdpsy');
    expect(row.status).toBe('已实名');
    expect(row.cert_no, '那一列不放证件号').toBeNull();
    const snapshot = JSON.parse(decryptField(row.raw_meta_enc!)) as NbdpsySnapshot;
    expect(snapshot.id_masked).toContain('*');
    expect(JSON.stringify(snapshot), '快照里不许有证件号明文（存全号 ⇒ 红）').not.toContain(FULL_ID);
  });

  test('本地未实名 + 对方 found=false ⇒ REALNAME_REQUIRED，零写入', async () => {
    const u = makeLinkedUser();
    globalThis.fetch = identityFetch({ verified: false });
    const before = (db.prepare('SELECT COUNT(*) AS n FROM realname_verifications').get() as { n: number }).n;

    const body = await register(u.key, u.caseId);

    const text = body.result.content[0].text as string;
    expect(JSON.parse(text).error_code).toBe('REALNAME_REQUIRED');
    expect((db.prepare('SELECT COUNT(*) AS n FROM realname_verifications').get() as { n: number }).n).toBe(before);
  });

  test('本地未实名 + 对方连不上 ⇒ REALNAME_REQUIRED，不抛错', async () => {
    const u = makeLinkedUser();
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const body = await register(u.key, u.caseId);

    expect(JSON.parse(body.result.content[0].text as string).error_code).toBe('REALNAME_REQUIRED');
  });

  test('本地已实名 ⇒ 直接放行，一次都不问对方（假对方计数 0）', async () => {
    const u = makeLinkedUser('已实名');
    const calls = { n: 0 };
    globalThis.fetch = identityFetch({ verified: true, id_number_masked: '1101**********1234' }, calls);

    const body = await register(u.key, u.caseId);

    const text = body.result.content[0].text as string;
    expect(JSON.parse(text).error_code, text).not.toBe('REALNAME_REQUIRED');
    expect(calls.n, '本地已实名不该去问对方').toBe(0);
  });
});
