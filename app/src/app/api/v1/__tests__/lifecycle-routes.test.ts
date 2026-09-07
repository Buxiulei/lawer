// app/src/app/api/v1/__tests__/lifecycle-routes.test.ts
// 数据生命周期那五条 REST 端点**自己**的判定（协议五.9、九.3）。
//
// 【这一份盯的不是删除/导出/注销做得对不对】那些在 lib/lifecycle 的五份判据里逐臂钉过了，
// 而且 REST 与 MCP 走的是同一条能力。这里只盯路由这一层自己做出的、领域层看不见的决定：
//   ① confirm_token 从**查询串**读，不从请求体读——把它放进体里就删不成
//      （DELETE 带体在各家客户端与网关上会被丢掉，而丢掉令牌的那次调用长得像第一步：
//        回一份确认单、什么都没删，用户点了删除却什么也没发生，且没有一处报错）；
//   ② 注销与撤回同意**只认网页登录态**：一把被泄露的长期 key 不该能把这个人的档案
//      推进删除流程，也不该能替他关掉他自己开的功能；
//   ③ 导出那条挂着实名闸，且未过闸时**零导出**（连一份 zip 都不该落到 files 表里）；
//   ④ 转介删除请求的体是选填的：读不出 JSON 时按「没给理由」办，不因此拒收一次撤回请求。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';
import { caseDeleteConfirmToken } from '@/lib/lifecycle/case-delete';

type IdCtx = { params: Promise<{ id: string }> };
type IdHandler = (req: Request, ctx: IdCtx) => Promise<Response>;
type Handler = (req: Request) => Promise<Response>;

let deleteCase: IdHandler;
let exportCase: IdHandler;
let cancelAccount: Handler;
let getConsents: Handler;
let postConsents: Handler;
let referralDelete: IdHandler;

let db: Database;
let uidA: number;
let uidB: number;
let caseA: number;
let referralA: number;
let keyWrite: string;
let keyRead: string;

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function request(method: string, url: string, auth?: string, body?: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function reply(res: Response): Promise<Reply> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function issueKey(userId: number, scopes: string[]): string {
  const key = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-09-01T00:00:00.000Z')",
  ).run(userId, hashApiKey(key), JSON.stringify(scopes));
  return key;
}

const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-lifecycle-routes-${crypto.randomUUID()}.db`);
  process.env.FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-routes-'));

  const caseRoute = await import('../cases/[id]/route');
  deleteCase = caseRoute.DELETE;
  exportCase = (await import('../cases/[id]/export/route')).GET;
  cancelAccount = (await import('../me/cancel/route')).POST;
  const consents = await import('../me/consents/route');
  getConsents = consents.GET;
  postConsents = consents.POST;
  referralDelete = (await import('../referrals/[id]/delete-request/route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const t of ['referral_delete_requests', 'referrals', 'consents', 'cases', 'api_keys', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, email, auth_status, created_at) VALUES (?, ?, ?, '2026-09-01T00:00:00.000Z')",
  );
  uidA = Number(insertUser.run(`a-${crypto.randomUUID()}`, 'a@t.com', '已实名').lastInsertRowid);
  uidB = Number(insertUser.run(`b-${crypto.randomUUID()}`, 'b@t.com', '未认证').lastInsertRowid);
  caseA = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uidA, '甲的档案').lastInsertRowid,
  );
  referralA = Number(
    db
      .prepare(
        `INSERT INTO referrals (case_id, user_id, payload_json, consent_at, status, external_ref)
         VALUES (?,?,'{}','2026-09-01 00:00:00','sent','LEAD-9')`,
      )
      .run(caseA, uidA).lastInsertRowid,
  );
  keyWrite = issueKey(uidA, ['case:read', 'case:write']);
  keyRead = issueKey(uidA, ['case:read']);
});

function tokenOfCaseA(): string {
  const row = db.prepare('SELECT id, user_id, created_at FROM cases WHERE id = ?').get(caseA) as {
    id: number;
    user_id: number;
    created_at: string;
  };
  return caseDeleteConfirmToken(row);
}

const del = (query: string, auth: string, body?: unknown) =>
  deleteCase(request('DELETE', `http://localhost/api/v1/cases/${caseA}${query}`, auth, body), {
    params: Promise.resolve({ id: String(caseA) }),
  }).then(reply);

const stillAlive = () => count('SELECT COUNT(*) AS n FROM cases WHERE id=? AND deleted_at IS NULL', caseA);

describe('DELETE /api/v1/cases/{id}：令牌走查询串', () => {
  test('不带令牌 ⇒ 只出确认单，案件仍在', async () => {
    const res = await del('', keyWrite);
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('confirm');
    expect(res.body.confirm_token).toBe(tokenOfCaseA());
    expect(stillAlive()).toBe(1);
  });

  test('🔑 令牌放在**请求体**里删不掉（变异：路由改成从 body 读 → 本条红）', async () => {
    const res = await del('', keyWrite, { confirm_token: tokenOfCaseA() });
    expect(res.body.stage, '体里的令牌不该被当成确认').toBe('confirm');
    expect(stillAlive()).toBe(1);
  });

  test('令牌放查询串里才真删，且删完读侧再也取不到', async () => {
    const res = await del(`?confirm_token=${tokenOfCaseA()}`, keyWrite);
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('deleted');
    expect(res.body.already_deleted).toBe(false);
    expect(stillAlive()).toBe(0);
  });

  test('查询串里抄错一位 ⇒ INVALID_CONFIRM_TOKEN 且零删除', async () => {
    const res = await del('?confirm_token=deadbeef', keyWrite);
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('INVALID_CONFIRM_TOKEN');
    expect(stillAlive()).toBe(1);
  });

  test('只读 key 删不掉（scope 闸在路由这一层）', async () => {
    const res = await del(`?confirm_token=${tokenOfCaseA()}`, keyRead);
    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe('FORBIDDEN_SCOPE');
    expect(stillAlive()).toBe(1);
  });
});

describe('GET /api/v1/cases/{id}/export：实名闸与零导出', () => {
  const exportA = (auth: string) =>
    exportCase(request('GET', `http://localhost/api/v1/cases/${caseA}/export`, auth), {
      params: Promise.resolve({ id: String(caseA) }),
    }).then(reply);

  test('已实名 ⇒ 200，回一条一次性下载地址，包里五样齐', async () => {
    const res = await exportA(keyRead);
    expect(res.status).toBe(200);
    expect(res.body.download_url).toMatch(/^\/api\/v1\/files\/download\/[0-9a-f]{32}$/);
    expect(res.body.entries).toEqual(
      expect.arrayContaining(['档案.json', '清单.json', 'README.txt']),
    );
  });

  test('🔑 未实名 ⇒ 403 REALNAME_REQUIRED，且**一份包都没落到 files 表**', async () => {
    db.prepare("UPDATE users SET auth_status='未认证' WHERE id=?").run(uidA);
    const before = count('SELECT COUNT(*) AS n FROM files');

    const res = await exportA(keyRead);
    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe('REALNAME_REQUIRED');
    expect(count('SELECT COUNT(*) AS n FROM files'), '未过闸却已经打了包').toBe(before);
  });

  test('软删之后导出这条路也关上（回同一句 CASE_NOT_FOUND）', async () => {
    db.prepare("UPDATE cases SET deleted_at='2026-09-01 00:00:00' WHERE id=?").run(caseA);
    const res = await exportA(keyRead);
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('CASE_NOT_FOUND');
  });
});

describe('POST /api/v1/me/cancel：只认网页登录态', () => {
  test('🔑 api key 注销不了账号（变异：把 requireWebSession 换成 requireIdentity → 本条红）', async () => {
    const res = await reply(
      await cancelAccount(request('POST', 'http://localhost/api/v1/me/cancel', keyWrite, {})),
    );
    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe('WEB_SESSION_REQUIRED');
    expect(
      count('SELECT COUNT(*) AS n FROM users WHERE id=? AND cancelled_at IS NULL', uidA),
      '被 key 挡下的这一次不该留下任何痕迹',
    ).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM email_codes')).toBe(0);
  });

  test('没有凭据 ⇒ 401', async () => {
    const res = await reply(
      await cancelAccount(request('POST', 'http://localhost/api/v1/me/cancel', undefined, {})),
    );
    expect(res.status).toBe(401);
  });
});

describe('/api/v1/me/consents：读与撤回', () => {
  const get = (auth?: string) =>
    getConsents(request('GET', 'http://localhost/api/v1/me/consents', auth)).then(reply);
  const post = (auth: string | undefined, body: unknown) =>
    postConsents(request('POST', 'http://localhost/api/v1/me/consents', auth, body)).then(reply);

  test('网页登录态读得到两项，且都还没撤回', async () => {
    const res = await get(signToken(uidA));
    expect(res.status).toBe(200);
    const kinds = (res.body.consents as { kind: string; revoked: boolean }[]).map((c) => c.kind);
    expect(kinds.sort()).toEqual(['emotion', 'overseas']);
    expect((res.body.consents as { revoked: boolean }[]).every((c) => !c.revoked)).toBe(true);
  });

  test('撤回一项之后再读，那一项 revoked=true 且带着「撤回后会发生什么」', async () => {
    const done = await post(signToken(uidA), { kind: 'emotion' });
    expect(done.status).toBe(200);
    expect(done.body.already_revoked).toBe(false);

    const after = await get(signToken(uidA));
    const emotion = (after.body.consents as { kind: string; revoked: boolean; effect: string }[]).find(
      (c) => c.kind === 'emotion',
    )!;
    expect(emotion.revoked).toBe(true);
    expect(emotion.effect.length).toBeGreaterThan(10);
  });

  test('🔑 api key 撤不了别人替他开的东西（变异：换成 requireIdentity → 本条红）', async () => {
    const res = await post(keyWrite, { kind: 'emotion' });
    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe('WEB_SESSION_REQUIRED');
    expect(count('SELECT COUNT(*) AS n FROM consents')).toBe(0);
  });

  test('体读不出来 ⇒ INVALID_BODY 且零写入（撤回要落到一项具体的同意上，不猜）', async () => {
    const res = await reply(
      await postConsents(
        new Request('http://localhost/api/v1/me/consents', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${signToken(uidA)}` },
          body: '不是 JSON',
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('INVALID_BODY');
    expect(count('SELECT COUNT(*) AS n FROM consents')).toBe(0);
  });

  test('kind 不认识 ⇒ INVALID_CONSENT_KIND 且零写入', async () => {
    const res = await post(signToken(uidA), { kind: 'whatever' });
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('INVALID_CONSENT_KIND');
    expect(count('SELECT COUNT(*) AS n FROM consents')).toBe(0);
  });
});

describe('POST /api/v1/referrals/{id}/delete-request', () => {
  const ask = (id: number, auth: string | undefined, body?: unknown) =>
    referralDelete(
      request('POST', `http://localhost/api/v1/referrals/${id}/delete-request`, auth, body),
      { params: Promise.resolve({ id: String(id) }) },
    ).then(reply);

  test('🔑 没有请求体也照收（reason 选填；变异：读不出体就回 400 → 本条红）', async () => {
    const res = await ask(referralA, keyWrite);
    expect(res.status).toBe(200);
    expect(res.body.delivered, '对方还没有删除通道，这里不许说成已送达').toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM referral_delete_requests WHERE referral_id=?', referralA)).toBe(1);
  });

  test('给了理由就记下来（截到 500 字以内的那一份口径在领域层）', async () => {
    await ask(referralA, keyWrite, { reason: '我不想让他们留着这些' });
    const row = db
      .prepare('SELECT reason FROM referral_delete_requests WHERE referral_id=?')
      .get(referralA) as { reason: string };
    expect(row.reason).toBe('我不想让他们留着这些');
  });

  test('别人的转介 ⇒ REFERRAL_NOT_FOUND 且零写入', async () => {
    const res = await ask(referralA, issueKey(uidB, ['case:read', 'case:write']));
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('REFERRAL_NOT_FOUND');
    expect(count('SELECT COUNT(*) AS n FROM referral_delete_requests')).toBe(0);
  });

  test('id 不是正整数 ⇒ 同一句话（不据此推断编号有效性）', async () => {
    const res = await referralDelete(
      request('POST', 'http://localhost/api/v1/referrals/abc/delete-request', keyWrite),
      { params: Promise.resolve({ id: 'abc' }) },
    ).then(reply);
    expect(res.status).toBe(404);
    expect(res.body.error_code).toBe('REFERRAL_NOT_FOUND');
  });

  test('只读 key 提不了（这是一次写）', async () => {
    const res = await ask(referralA, keyRead);
    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe('FORBIDDEN_SCOPE');
  });
});
