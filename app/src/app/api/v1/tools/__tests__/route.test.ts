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
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { getCapability, listCapabilities } from '@/lib/capabilities';
import { CONSENT_KINDS } from '@/lib/consent';
import { decryptField, encryptField } from '@/lib/crypto';
import { recordConsent } from '@/lib/db/consents';
import * as realnameStore from '@/lib/db/realname';
import type { NbdpsySnapshot } from '@/lib/referral/identity-link';

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
    // realname_verifications 外键指向 users 且无级联：有互认落下来的行时，得先于 users 清，
    // 否则 DELETE users 撞外键（本文件 try/catch 会把它悄悄吞掉，留下一堆孤儿用户）。
    'token_usage', 'gongdao_ledger', 'gongdao', 'realname_verifications', 'users',
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
  insertCase.run(uidB, '乙的案子');
  caseVerified = Number(insertCase.run(uidVerified, '已实名者的案子').lastInsertRowid);

  evidenceA = insertEvidence(caseA, uidA);
  evidenceVerified = insertEvidence(caseVerified, uidVerified);

  // 情绪记录的单独同意（协议五.2（2））：本组用例测的是清单、幂等与归属，不是同意闸。
  // 三个人都先同意过，emotion_log 才走得到它自己的判定；
  // 同意闸本身的两臂另有专门用例（consent-gate.test.ts 与本文件末尾那条）。
  for (const uid of [uidA, uidB, uidVerified]) {
    recordConsent(db, { userId: uid, kind: CONSENT_KINDS.emotion });
  }

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
  evidence_void: { evidence_id: 999_999, reason: '与条目 1 重复' },
  evidence_brief_regenerate: { evidence_id: 999_999 },
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
  // 个案报告（长期记忆）
  case_report_get: { case_id: '#case' },
  case_report_update: { case_id: '#case', section: '风险与未定项', content: '暂无补充。', reason: '补齐', base_version: 0 },
  // 危机检查 / 身份与账户
  crisis_check: { case_id: '#case', text: '最近睡不好，但还扛得住' },
  me_get: {},
  quote_list: { case_id: '#case' },
  // 引用核验
  citation_check: { assert_terms: ['经济补偿按 N 计算'] },
  // 对方主体情报（探测 → 报价 → 确认 → 读档 / 关系图 / 守望）
  company_probe: { name: '某某科技有限公司' },
  dossier_quote: { case_id: '#case', name: '某某科技有限公司', blocks: ['venue'] },
  dossier_confirm: { quote_id: 999_999 },
  dossier_get: { case_id: '#case' },
  company_graph_get: { case_id: '#case' },
  company_watch_set: { case_id: '#case', name: '某某科技有限公司', tier: 'daily' },
  // 分享与导出（前两条需实名，未实名 key 会先被闸挡回 403）
  share_create: { evidence_id: '#evidence' },
  draft_export: { draft_id: 999_999 },
  share_revoke: { share_id: 999_999 },
  // 转介
  referral_create: { case_id: '#case', consent: true },
  referral_list: { case_id: '#case' },
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
  // 例外三条，都不回 404，但各有下面单独的判据盯着不漏数据：
  //  · doc_list / quote_list：按 (case_id, user_id) 取行，别人的案子回空清单，一个字段都不给。
  //  · crisis_check：case_id 只是可选标签，非本人案子被静默降级成"无案"（caseId=null），
  //    记的是调用者自己的危机留痕，既不读也不写那个案子。
  const CASE_SCOPED_EXCEPT = ['doc_list', 'quote_list', 'crisis_check'];
  const CASE_SCOPED = ALL_NAMES.filter(
    (n) =>
      (MINIMAL_ARGS[n] as Record<string, unknown>).case_id === '#case' &&
      !CASE_SCOPED_EXCEPT.includes(n),
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

  test('quote_list 对他人案件回空清单，不回任何一行', async () => {
    const { status, body } = await bridge('quote_list', { case_id: caseA }, keyB);
    expect(status).toBe(200);
    expect(body.quotes).toEqual([]);
  });

  test('crisis_check 带他人 case_id：静默降级为无案，不往那个案子记一笔', async () => {
    const countForCaseA = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM crisis_hits WHERE case_id=?').get(caseA) as { n: number }).n;
    const before = countForCaseA();
    const { status } = await bridge('crisis_check', { case_id: caseA, text: '我没事，随口一说' }, keyB);
    expect(status).toBe(200);
    // 外人的这次命中记在 case_id=null 上，甲案里一条都不该多
    expect(countForCaseA()).toBe(before);
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

// ========== 实名互认：前置闸与证据 REST 同一道 OrLinked 判定 ==========

/**
 * 互认判定（本地没实名 → 问一次 NBDpsy → approved 就采信）此前只长在证据 REST 的
 * requireRealname 上；桥/MCP 的前置闸用的是纯本地的 isRealnameVerified。于是「已在
 * NBDpsy 实名、本地没实名」的人在证据 REST 侧放行、在桥/MCP 侧被 403——同一人同一条能力，
 * 两条入口两个答案，两边都不报错。闸改成 async 调 realnameVerifiedOrLinked 后，这组盯三件事。
 *
 * 【变异臂】把 invoke.checkPreconditions 改回 isRealnameVerified（纯本地判定）⇒
 * 第一条（approved 放行 + 落快照）当场红：本地未实名的人仍被 403，快照那一行也不会出现。
 * 互认落库时把证件号存成全号 ⇒ 第一条里「快照不含明文」那句红。
 */
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

  /** 一把假 fetch：无论问什么手机号都回同一份对方回包；counter 记它被打了几次。 */
  function identityFetch(body: Record<string, unknown>, counter?: { n: number }): typeof fetch {
    return (async () => {
      if (counter) counter.n += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  }

  /** 造一个带手机号（互认匹配键）、本地未实名的用户 + 他的一件案子 + 一把可写 key。 */
  function makeLinkedUser(authStatus = '未认证'): { uid: number; key: string; caseId: number } {
    const phone = `link-${crypto.randomUUID()}`;
    const uid = Number(
      db
        .prepare(
          'INSERT INTO users (phone_enc, phone_hash, auth_status, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(encryptField(phone), phone, authStatus, '2026-09-01T00:00:00.000Z').lastInsertRowid,
    );
    const caseId = Number(
      db
        .prepare(
          "INSERT INTO cases (user_id, title, stage, goal, created_at) VALUES (?, '互认者的案子', '风声', '拿到 2N', '2026-09-01T00:00:00.000Z')",
        )
        .run(uid).lastInsertRowid,
    );
    return { uid, key: issueKey(uid, ['case:read', 'case:write']), caseId };
  }

  const REG = (caseId: number) => ({ case_id: caseId, upload_token: 'not-a-real-token', name: '工资条' });

  test('本地未实名 + 对方 approved 但没同意采用 ⇒ 拒、零写入、码是 CONSENT_REQUIRED', async () => {
    // 协议三.3 / 附一 #3：采用要先有单独同意。这一臂盯的是「问了对方、但一个字都不写」。
    // 变异确认：把 realnameGate 里那句 hasConsent 判断删掉 ⇒ 本条红（放行且落了快照）。
    const u = makeLinkedUser();
    const calls = { n: 0 };
    globalThis.fetch = identityFetch(
      { verified: true, real_name: '张三', id_number_masked: '1101**********1234' },
      calls,
    );

    const { body } = await bridge('evidence_register', REG(u.caseId), u.key);
    expect(body.error_code).toBe('CONSENT_REQUIRED');
    expect(String(body.message)).toContain('同意采用');
    expect(realnameStore.latestByUser(db, u.uid), '没同意就一行都不该写').toBeUndefined();
    expect(
      (db.prepare('SELECT auth_status FROM users WHERE id=?').get(u.uid) as { auth_status: string })
        .auth_status,
    ).toBe('未认证');
  });

  test('本地未实名 + 对方 approved ⇒ evidence_register 放行、落 provider=nbdpsy 掩码快照', async () => {
    const u = makeLinkedUser();
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
        customer_code: 'C-8899',
      },
      calls,
    );

    const { status, body } = await bridge('evidence_register', REG(u.caseId), u.key);

    // 放行：不再是实名闸的 403；闸后 run 因假 token 停在 UPLOAD_TOKEN_NOT_FOUND
    expect(body.error_code, JSON.stringify(body).slice(0, 300)).not.toBe('REALNAME_REQUIRED');
    expect(status).not.toBe(403);
    expect(calls.n, '本地未实名必须去问一次对方').toBe(1);

    // 落了一条 provider=nbdpsy 的核验流水，users 翻成已实名
    const row = realnameStore.latestByUser(db, u.uid)!;
    expect(row.provider).toBe('nbdpsy');
    expect(row.status).toBe('已实名');
    expect(row.cert_no, '那一列不放证件号').toBeNull();
    const snapshot = JSON.parse(decryptField(row.raw_meta_enc!)) as NbdpsySnapshot;
    expect(snapshot.id_masked).toContain('*');
    expect(JSON.stringify(snapshot), '快照里不许有证件号明文（存全号 ⇒ 红）').not.toContain(FULL_ID);
    expect(
      (db.prepare('SELECT auth_status FROM users WHERE id=?').get(u.uid) as { auth_status: string })
        .auth_status,
    ).toBe('已实名');
  });

  test('本地未实名 + 对方 found=false ⇒ 403 REALNAME_REQUIRED，零写入', async () => {
    const u = makeLinkedUser();
    globalThis.fetch = identityFetch({ verified: false });
    const before = (db.prepare('SELECT COUNT(*) AS n FROM realname_verifications').get() as { n: number }).n;

    const { status, body } = await bridge('evidence_register', REG(u.caseId), u.key);

    expect(status).toBe(403);
    expect(body.error_code).toBe('REALNAME_REQUIRED');
    expect((db.prepare('SELECT COUNT(*) AS n FROM realname_verifications').get() as { n: number }).n).toBe(before);
  });

  test('本地未实名 + 对方连不上 ⇒ 403 REALNAME_REQUIRED，不抛错不 5xx', async () => {
    const u = makeLinkedUser();
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const { status, body } = await bridge('evidence_register', REG(u.caseId), u.key);

    expect(status).toBe(403);
    expect(body.error_code).toBe('REALNAME_REQUIRED');
  });

  test('本地已实名 ⇒ 闸直接放行，一次都不问对方（假对方计数 0）', async () => {
    const u = makeLinkedUser('已实名');
    const calls = { n: 0 };
    globalThis.fetch = identityFetch({ verified: true, id_number_masked: '1101**********1234' }, calls);

    const { status, body } = await bridge('evidence_register', REG(u.caseId), u.key);

    expect(body.error_code, JSON.stringify(body).slice(0, 300)).not.toBe('REALNAME_REQUIRED');
    expect(status).not.toBe(403);
    expect(calls.n, '本地已实名不该去问对方').toBe(0);
  });
});

/**
 * 情绪记录的单独同意（协议 五.2（2）/ 附一 #4）在 **MCP/REST 这一面**的两臂。
 *
 * 【为什么这条要在这里再测一遍】站内对话那条路的判据在
 * lib/agent/__tests__/consent-emotion.test.ts，走的是 orchestrator 的 runTool；
 * 这条路走的是**能力注册表 + invoke 的 checkPreconditions**——两套完全不同的代码。
 * 只测一面的形态是：网页上问得好好的，而用户的 agent 直接调 REST 就把情绪记进去了，
 * 且回包一切正常。同一道闸有几个面，就要有几条判据。
 *
 * 【为什么本组要自己造人】文件开头的 beforeEach 给三个夹具用户都记了 emotion 同意
 * （那些用例测的是清单、幂等与归属，不该被一道无关的闸挡住）。这一臂要的是
 * **没同意过**的人——拿一个已经同意过的人来测"没同意会怎样"，闸拆了也照样绿。
 *
 * 【变异臂】2026-09-07 实跑：把 families/emotion.ts 的 `precondition: ['emotion_consent']`
 * 改回 `[]` ⇒ 本组第一条红（没同意也照写，库里多了一行）。
 */
describe('情绪记录：MCP/REST 这一面同样要单独同意', () => {
  const emotionRows = (caseId: number): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM emotion_log WHERE case_id=?').get(caseId) as { n: number }).n;

  /** 造一个**没同意过任何东西**的人 + 一件案子 + 一把可写 key */
  function makeFreshUser(): { uid: number; key: string; caseId: number } {
    const uid = Number(
      db
        .prepare("INSERT INTO users (phone_hash, auth_status) VALUES (?, '未认证')")
        .run(`fresh-${crypto.randomUUID()}`).lastInsertRowid,
    );
    const caseId = Number(
      db
        .prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, '没同意过的人的案子', '风声')")
        .run(uid).lastInsertRowid,
    );
    return { uid, key: issueKey(uid, ['case:read', 'case:write']), caseId };
  }

  test('没同意 ⇒ CONSENT_REQUIRED，且**零写入**', async () => {
    const u = makeFreshUser();

    const { body } = await bridge('emotion_log', { case_id: u.caseId, level: '焦虑' }, u.key);

    expect(body.error_code).toBe('CONSENT_REQUIRED');
    expect(emotionRows(u.caseId), '没同意就一行都不该写').toBe(0);
    // 对方 agent 读的是这段话，它必须挡住"改个参数再试一次"那条路
    expect(String(body.message)).toContain('没有写入任何东西');
    expect(String(body.message), '同意要由用户本人在网页上给').toContain('网页');
  });

  test('同意之后 ⇒ 照常写入（同一份入参，只多了一行 consents）', async () => {
    const u = makeFreshUser();
    recordConsent(db, { userId: u.uid, kind: CONSENT_KINDS.emotion });

    const { body } = await bridge('emotion_log', { case_id: u.caseId, level: '焦虑' }, u.key);

    expect(body.error_code, `同意过了还被拦：${String(body.message)}`).toBeUndefined();
    expect(emotionRows(u.caseId)).toBe(1);
  });
});
