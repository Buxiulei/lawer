// REST 通用工具桥的判据。
//
// 【这条桥的失败形态是什么】它是「同一条能力的第二个入口」。第二个入口的坏法不是报错，
// 是**判定少了一句**：少判暴露面 → 不该露的能力从这里露出去；少判 scope → 只读 key 写得进档案；
// 少判前置闸 → 未过闸的人从这条路照样写。三种坏法在回包上都长成 200，MCP 那条仍然拦得好好的。
// 所以下面盯的是「与 MCP 同一批判定」这件事本身：逐条能力都能从桥上调到、错误码与状态成对、
// 他人案件一律 404、闸门原样生效。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { getCapability, listCapabilities } from '@/lib/capabilities';

type Ctx = { params: Promise<{ name: string }> };
let callTool: (req: Request, ctx: Ctx) => Promise<Response>;
let listTools: (req: Request) => Promise<Response>;
let db: Database;

let keyA: string;
let keyARead: string;
let keyB: string;
let keyVerified: string;
let uidA: number;
let uidVerified: number;
let caseA: number;
let caseB: number;
let caseVerified: number;
let evidenceA: number;
let evidenceVerified: number;

/** 打一次桥。name 走路径段，入参走 body。 */
async function bridge(
  name: string,
  args: Record<string, unknown> | undefined,
  key: string | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const req = new Request(`http://localhost/api/v1/tools/${name}`, {
    method: 'POST',
    headers,
    body: args === undefined ? undefined : JSON.stringify(args),
  });
  const res = await callTool(req, { params: Promise.resolve({ name }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function issueKey(userId: number, scopes: string[]): string {
  const key = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-09-01T00:00:00.000Z')",
  ).run(userId, hashApiKey(key), JSON.stringify(scopes));
  return key;
}

/** 造一条证据行（连同它的 files 行）。走 SQL 而不是走上传流程：这里要的是「有这么一件材料」。 */
function insertEvidence(caseId: number, userId: number, mime = 'image/jpeg'): number {
  const fileId = Number(
    db
      .prepare("INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, 1024, ?, '/dev/null')")
      .run(crypto.randomUUID(), mime).lastInsertRowid,
  );
  return Number(
    db
      .prepare(
        "INSERT INTO evidence (case_id, user_id, file_id, name, category, created_at) VALUES (?, ?, ?, '截图.jpg', '沟通记录', '2026-09-01T00:00:00.000Z')",
      )
      .run(caseId, userId, fileId).lastInsertRowid,
  );
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-bridge-${crypto.randomUUID()}.db`);
  // 解读类能力要先能装配出模型依赖才轮得到归属与报价判定。给一把假 key 让装配过得去：
  // 本组判据全部停在「归属不对」或「只出价、不动账」之前，一次也不会真去打上游。
  process.env.DEEPSEEK_API_KEY ||= 'sk-test-not-a-real-key';

  callTool = (await import('../[name]/route')).POST;
  listTools = (await import('../route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const table of [
    'api_keys', 'timeline_events', 'action_items', 'deadlines', 'claims', 'drafts',
    'company_profiles', 'emotion_logs', 'evidence', 'files', 'cases',
    'token_usage', 'gongdao_ledger', 'gongdao', 'users',
  ]) {
    try {
      db.prepare(`DELETE FROM ${table}`).run();
    } catch {
      // 这一版数据库里没有这张表就跳过：清场是为了互不干扰，不是判据本身
    }
  }
  const insertUser = db.prepare(
    'INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, ?, ?)',
  );
  uidA = Number(insertUser.run(`a-${crypto.randomUUID()}`, '未认证', '2026-09-01T00:00:00.000Z').lastInsertRowid);
  const uidB = Number(insertUser.run(`b-${crypto.randomUUID()}`, '未认证', '2026-09-01T00:00:00.000Z').lastInsertRowid);
  uidVerified = Number(insertUser.run(`v-${crypto.randomUUID()}`, '已实名', '2026-09-01T00:00:00.000Z').lastInsertRowid);

  const insertCase = db.prepare(
    "INSERT INTO cases (user_id, title, stage, goal, created_at) VALUES (?, ?, '风声', '拿到 2N', '2026-09-01T00:00:00.000Z')",
  );
  caseA = Number(insertCase.run(uidA, '甲的案子').lastInsertRowid);
  caseB = Number(insertCase.run(uidB, '乙的案子').lastInsertRowid);
  caseVerified = Number(insertCase.run(uidVerified, '已实名者的案子').lastInsertRowid);

  evidenceA = insertEvidence(caseA, uidA);
  evidenceVerified = insertEvidence(caseVerified, uidVerified);

  keyA = issueKey(uidA, ['case:read', 'case:write']);
  keyARead = issueKey(uidA, ['case:read']);
  keyB = issueKey(uidB, ['case:read', 'case:write']);
  keyVerified = issueKey(uidVerified, ['case:read', 'case:write']);
});

// ========== 清单 ==========

describe('GET /api/v1/tools', () => {
  function get(key?: string): Promise<Response> {
    return listTools(
      new Request('http://localhost/api/v1/tools', {
        headers: key ? { authorization: `Bearer ${key}` } : {},
      }),
    );
  }

  test('没带凭据 → 401 UNAUTHORIZED', async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect((await res.json()).error_code).toBe('UNAUTHORIZED');
  });

  test('清单与注册表逐条同名同序，且每条都带 scope 与入参 schema', async () => {
    const body = await (await get(keyA)).json();
    const expected = listCapabilities({ exposeTo: 'mcp' });
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(expected.map((c) => c.name));
    for (const t of body.tools) {
      expect(t.scope, t.name).toMatch(/^case:(read|write)$/);
      expect(t.input_schema?.type, t.name).toBe('object');
      expect(t.bridge.path, t.name).toBe(`/api/v1/tools/${t.name}`);
    }
  });

  test('只有 case:write 的 key 也读得到清单（这条回的是接口自描述，不是案件数据）', async () => {
    const writeOnly = issueKey(uidA, ['case:write']);
    const res = await get(writeOnly);
    expect(res.status).toBe(200);
    expect((await res.json()).tools.length).toBeGreaterThan(0);
  });
});

// ========== 逐条能力：37 条都调得到 ==========

/**
 * 每条能力的一组最小合法入参。值里的占位符在调用前替换成本轮 fixture 的真实 id。
 * **这张表必须覆盖注册表的每一条**——下面有一条判据钉着它，加了能力不加这里当场红，
 * 否则新能力会安静地不被这组判据碰到。
 */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  case_get: { case_id: '#case' },
  case_update: { case_id: '#case', goal: '拿到 2N' },
  case_facts: { case_id: '#case' },
  case_list: {},
  intake_submit: {
    case_id: '#case',
    stage: '风声',
    company_name: '某某科技有限公司',
    employed_from: '2020-03-01',
    monthly_wage_yuan: 20000,
    goals: ['拿到 2N'],
  },
  timeline_add: { case_id: '#case', happened_at: '2026-08-20T09:00:00+08:00', kind: '公司动作', title: '约谈' },
  timeline_list: { case_id: '#case' },
  timeline_milestone: { case_id: '#case', event_id: 999_999, milestone: '协商', user_confirmed: true },
  action_list: { case_id: '#case' },
  action_create: {
    case_id: '#case',
    items: [{ what: '寄出异议函', how: '快递到付并留底', why: '固定送达证据', due_at: '2026-09-10T18:00:00+08:00' }],
  },
  action_complete: { case_id: '#case', action_id: 999_999 },
  claim_calc: {
    case_id: '#case',
    kind: 'N',
    inputs: { avg_monthly_wage_fen: 2_000_000, employed_from: '2020-03-01', terminated_at: '2026-03-01' },
  },
  claims_upsert: { case_id: '#case', kind: '欠薪', amount_fen: 123_400 },
  claims_list: { case_id: '#case' },
  deadline_list: { case_id: '#case' },
  deadline_set: { case_id: '#case', kind: '起诉15日', anchor_date: '2026-03-02' },
  deadline_resolve: { case_id: '#case', deadline_id: 999_999 },
  draft_list: { case_id: '#case' },
  draft_get: { draft_id: 999_999 },
  draft_write: {
    case_id: '#case',
    kind: '异议函',
    title: '异议函',
    body: '本人对调岗决定提出异议。',
    send_consequences: '发出后视为明确表态，公司可能据此推进解除；这一步不可逆。',
  },
  company_profile_upsert: { case_id: '#case', name: '某某科技有限公司' },
  emotion_log: { case_id: '#case', level: '平稳' },
  knowledge_search: { query: '经济补偿' },
  knowledge_get: { id: '不存在的卡片' },
  evidence_list: { case_id: '#case' },
  evidence_get: { evidence_id: '#evidence' },
  evidence_brief_get: { evidence_id: '#evidence' },
  evidence_brief_update: { evidence_id: '#evidence', brief: {}, reason: '补齐', base_version: 0 },
  evidence_extract: { evidence_id: '#evidence', mode: 'ocr' },
  evidence_upload_url: { case_id: '#case', filename: '工资条.pdf' },
  evidence_register: { case_id: '#case', upload_token: 'not-a-real-token', name: '工资条' },
  evidence_attest: { evidence_ids: ['#evidence'] },
  attest_verify: { order_no: 'NO-SUCH-ORDER' },
  doc_submit: { case_id: '#case', doc_kind: '解除通知', text: '公司决定与你解除劳动合同。' },
  doc_list: { case_id: '#case' },
  doc_get: { doc_id: 999_999 },
  transcript_submit: { evidence_id: '#evidence' },
};

/** 把 '#case' / '#evidence' 换成本轮的真实 id */
function fill(args: Record<string, unknown>, ids: { caseId: number; evidenceId: number }): Record<string, unknown> {
  const swap = (v: unknown): unknown => {
    if (v === '#case') return ids.caseId;
    if (v === '#evidence') return ids.evidenceId;
    if (Array.isArray(v)) return v.map(swap);
    return v;
  };
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, swap(v)]));
}

/** 桥回包允许出现的 HTTP 状态。5xx 与 200-但没有 ok 都不在其列。 */
const ALLOWED_STATUSES = new Set([200, 400, 402, 403, 404, 409, 413, 422, 429]);

const ALL_NAMES = listCapabilities({ exposeTo: 'mcp' }).map((c) => c.name);

describe('通用桥：注册表里的每一条都调得到', () => {
  test(`最小入参表覆盖全部 ${ALL_NAMES.length} 条能力（加了能力不加入参 → 红）`, () => {
    expect(Object.keys(MINIMAL_ARGS).sort()).toEqual([...ALL_NAMES].sort());
  });

  test.each(ALL_NAMES)('%s 从桥上调得到：不是 TOOL_NOT_FOUND、不是 5xx、错误码与状态成对', async (name) => {
    const { status, body } = await bridge(
      name,
      fill(MINIMAL_ARGS[name], { caseId: caseA, evidenceId: evidenceA }),
      keyA,
    );
    expect(ALLOWED_STATUSES.has(status), `${name} 回了 ${status}：${JSON.stringify(body).slice(0, 300)}`).toBe(true);
    if (status === 200) {
      expect(body.ok, name).toBe(true);
    } else {
      // 失败一律 { ok:false, error_code, message }，与 MCP 那条路同形
      expect(body.ok, name).toBe(false);
      expect(typeof body.error_code, name).toBe('string');
      expect(body.error_code, `${name} 被桥当成了未知能力`).not.toBe('TOOL_NOT_FOUND');
      expect(String(body.message).length, name).toBeGreaterThan(0);
    }
  });

  test('名字不在注册表里 → 404 TOOL_NOT_FOUND', async () => {
    const { status, body } = await bridge('case_delete_everything', {}, keyA);
    expect(status).toBe(404);
    expect(body.error_code).toBe('TOOL_NOT_FOUND');
  });

  test('没带凭据 → 401，且不看 name 是否存在（先鉴权再认名字）', async () => {
    expect((await bridge('case_get', { case_id: caseA }, undefined)).status).toBe(401);
    expect((await bridge('没有这个能力', {}, undefined)).status).toBe(401);
  });

  test('无入参能力可以不发 body；发了非对象 body → 400 INVALID_BODY', async () => {
    expect((await bridge('case_list', undefined, keyA)).status).toBe(200);
    const req = new Request('http://localhost/api/v1/tools/case_list', {
      method: 'POST',
      headers: { authorization: `Bearer ${keyA}` },
      body: '[1,2,3]',
    });
    const res = await callTool(req, { params: Promise.resolve({ name: 'case_list' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_BODY');
  });
});

// ========== 读 200 / 写重放 deduped ==========

/** 空档案上就该直接回 200 的读能力 */
const READ_OK = [
  'case_get', 'case_facts', 'case_list', 'timeline_list', 'action_list',
  'claims_list', 'deadline_list', 'evidence_list', 'draft_list', 'doc_list',
  'evidence_get', 'evidence_brief_get',
] as const;

describe('读能力走桥回 200', () => {
  test.each(READ_OK)('%s → 200 且 ok:true', async (name) => {
    const { status, body } = await bridge(
      name,
      fill(MINIMAL_ARGS[name], { caseId: caseA, evidenceId: evidenceA }),
      keyARead,
    );
    expect(status, `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
    expect(body.ok).toBe(true);
  });
});

/**
 * 写能力的重放。同一个 client_ref 打两次，第二次必须是 deduped——
 * 漏掉幂等的形态是：agent 网络抖动重试一次，用户档案里多一条一模一样的记录，
 * 而两次调用都返回 200。
 */
const WRITE_REPLAY: [string, Record<string, unknown>][] = [
  ['timeline_add', MINIMAL_ARGS.timeline_add],
  ['claim_calc', MINIMAL_ARGS.claim_calc],
  ['claims_upsert', MINIMAL_ARGS.claims_upsert],
  ['deadline_set', MINIMAL_ARGS.deadline_set],
  ['action_create', MINIMAL_ARGS.action_create],
  ['draft_write', MINIMAL_ARGS.draft_write],
  ['company_profile_upsert', MINIMAL_ARGS.company_profile_upsert],
  ['emotion_log', MINIMAL_ARGS.emotion_log],
];

describe('写能力走桥：同 client_ref 重放只落一条', () => {
  test.each(WRITE_REPLAY)('%s 第二次回 deduped:true', async (name, args) => {
    const payload = { ...fill(args, { caseId: caseA, evidenceId: evidenceA }), client_ref: `ref-${name}` };
    const first = await bridge(name, payload, keyA);
    expect(first.status, `${name} 第一次就没成功：${JSON.stringify(first.body).slice(0, 300)}`).toBe(200);
    expect(first.body.deduped, `${name} 第一次`).toBe(false);

    const second = await bridge(name, payload, keyA);
    expect(second.status).toBe(200);
    expect(second.body.deduped, `${name} 第二次`).toBe(true);
  });

  test('只读 key 调写能力 → 403 FORBIDDEN_SCOPE 且零写入', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM timeline_events').get() as { n: number }).n;
    const { status, body } = await bridge('timeline_add', fill(MINIMAL_ARGS.timeline_add, { caseId: caseA, evidenceId: evidenceA }), keyARead);
    expect(status).toBe(403);
    expect(body.error_code).toBe('FORBIDDEN_SCOPE');
    expect((db.prepare('SELECT COUNT(*) AS n FROM timeline_events').get() as { n: number }).n).toBe(before);
  });
});

// ========== 归属 ==========

describe('他人案件一律 CASE_NOT_FOUND 404', () => {
  // doc_list 例外：它按 (case_id, user_id) 取行，别人的案子回的是空清单而不是 404。
  // 不算泄露（一个字段都不给），但形状与其余不同，单独一条判据盯它不漏数据。
  const CASE_SCOPED = ALL_NAMES.filter(
    (n) => (MINIMAL_ARGS[n] as Record<string, unknown>).case_id === '#case' && n !== 'doc_list',
  );

  test('参与本组的确实是那一批（空名单会让下面那条永远绿）', () => {
    expect(CASE_SCOPED.length).toBeGreaterThanOrEqual(18);
  });

  test.each(CASE_SCOPED)('%s 拿别人的 key 调甲的案子 → 404 CASE_NOT_FOUND', async (name) => {
    // 声明了实名闸的能力要用一把**已实名**的外人 key：否则先被 403 拦下，
    // 归属那一道根本没轮到判，这条判据就成了在验实名闸而不是在验归属。
    const outsider = getCapability(name)!.precondition.includes('realname') ? keyVerified : keyB;
    // evidence_id 一并换成甲的：连案带材料都不是他的，一个字段都不该看见
    const { status, body } = await bridge(
      name,
      fill(MINIMAL_ARGS[name], { caseId: caseA, evidenceId: evidenceA }),
      outsider,
    );
    expect(status, `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(404);
    expect(body.ok).toBe(false);
  });

  test('doc_list 对他人案件回空清单，不回任何一行', async () => {
    const { status, body } = await bridge('doc_list', { case_id: caseA }, keyB);
    expect(status).toBe(200);
    expect(body.docs).toEqual([]);
  });

  test('乙看不到甲案里的任何一条时间线（读能力也走同一道归属）', async () => {
    await bridge('timeline_add', { ...MINIMAL_ARGS.timeline_add, case_id: caseA }, keyA);
    const mine = await bridge('timeline_list', { case_id: caseA }, keyA);
    expect((mine.body.events as unknown[]).length).toBe(1);
    const theirs = await bridge('timeline_list', { case_id: caseA }, keyB);
    expect(theirs.status).toBe(404);
    expect(JSON.stringify(theirs.body)).not.toContain('约谈');
  });
});

// ========== 前置闸：桥不许绕过 ==========

/**
 * 变异臂：把 [name]/route.ts 里的 checkPreconditions/invokeCapability 换成直接 capability.run
 * ⇒ 本组两条全红（未实名的写入会当场落库、余额 0 的确认会扣成负数）。
 */
describe('前置闸与 MCP 同一份判定', () => {
  test('未实名调 evidence_register → 403 REALNAME_REQUIRED 且零写入', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM evidence').get() as { n: number }).n;
    const { status, body } = await bridge(
      'evidence_register',
      { case_id: caseA, upload_token: 'not-a-real-token', name: '工资条' },
      keyA,
    );
    expect(status).toBe(403);
    expect(body.error_code).toBe('REALNAME_REQUIRED');
    // 闸在 run 之前：连「token 不存在」都没轮到判，更没有落任何行
    expect((db.prepare('SELECT COUNT(*) AS n FROM evidence').get() as { n: number }).n).toBe(before);
  });

  test('未实名调 evidence_upload_url / evidence_attest 同样 403（闸由注册表驱动，不挑能力）', async () => {
    for (const [name, args] of [
      ['evidence_upload_url', { case_id: caseA, filename: '工资条.pdf' }],
      ['evidence_attest', { evidence_ids: [evidenceA] }],
    ] as const) {
      const { status, body } = await bridge(name, args, keyA);
      expect(status, name).toBe(403);
      expect(body.error_code, name).toBe('REALNAME_REQUIRED');
    }
  });

  test('已实名但余额 0：evidence_extract 只看价 200，确认扣费 402 GONGDAO_EXHAUSTED', async () => {
    const quote = await bridge(
      'evidence_extract',
      { evidence_id: evidenceVerified, mode: 'ocr' },
      keyVerified,
    );
    expect(quote.status, JSON.stringify(quote.body).slice(0, 300)).toBe(200);
    const quoteId = (quote.body.quote as { quote_id: number }).quote_id;

    const { status, body } = await bridge(
      'evidence_extract',
      { evidence_id: evidenceVerified, mode: 'ocr', quote_id: quoteId },
      keyVerified,
    );
    expect(status).toBe(402);
    expect(body.error_code).toBe('GONGDAO_EXHAUSTED');
  });

  test('未实名者连报价都拿不到（realname 闸在 balance 之前，且不看这次要不要花钱）', async () => {
    const { status, body } = await bridge('evidence_extract', { evidence_id: evidenceA, mode: 'ocr' }, keyA);
    expect(status).toBe(403);
    expect(body.error_code).toBe('REALNAME_REQUIRED');
  });
});
