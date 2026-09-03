// app/src/app/api/v1/admin/realname/__tests__/routes.test.ts
// 护照实名审核台五条路由的端到端。每条判据都跑真 Request/Response，不 mock 路由内部。
//
// 判据（经理裁决 E）：
//   ① 非管理员（未登录 / 非白名单 / ADMIN_UIDS 空 / api key 身份）打五条路由一律**空体 404**；
//   ② 通过后 users 状态与 cert_type 正确、admin_audit 恰好一行、
//      用户端 /api/v1/realname/status 返回「已实名」；
//   ③ 驳回必须带非空原因（400 BAD_REASON），驳回后原因原样回显、用户可重交；
//   ④ 已落定的流水不得二次审核（400 BAD_STATE，不静默改写）；
//   ⑤ 照片路由：无鉴权 404、有鉴权 200 且 Content-Type 与上传时一致、带 no-store、
//      kind 非法 400；
//   ⑥ 发信尽力而为：SMTP 没配（sendMail 抛）照样 200 且 DB 已落定；没邮箱则优雅跳过；
//   ⑦ 队列每一行都自述得清：信封坏掉的那条照样现身并带 envelope_error（不是静默消失），
//      手机号是**解密后的全号**（不是掩码、也不是 null）；
//   ⑧ 陈旧流水不许落定：审的不是该用户 MAX(id) 那行 → 409 STALE_VERIFICATION，且什么都没写；
//   ⑨ 备注/原因有字数上限（400 BAD_NOTE / BAD_REASON）；
//   ⑩ 照片路由带 nosniff，且只回 image/*（其余 415，不把用户上传的字节交给浏览器渲染）。
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { signToken } from '@/lib/auth/jwt';

type IdCtx = { params: Promise<{ id: string }> };
type PhotoCtx = { params: Promise<{ id: string; kind: string }> };

let pendingGet: (req: Request) => Promise<Response>;
let detailGet: (req: Request, ctx: IdCtx) => Promise<Response>;
let photoGet: (req: Request, ctx: PhotoCtx) => Promise<Response>;
let approvePost: (req: Request, ctx: IdCtx) => Promise<Response>;
let rejectPost: (req: Request, ctx: IdCtx) => Promise<Response>;
let statusGet: (req: Request) => Promise<Response>;
let listUsers: (req: Request) => Promise<Response>;
let db: Database;

let ADMIN = 0;
let TARGET = 0;

const NAME = '张三';
const PASSPORT_NO = 'E12345678';
const ID_PAGE = Buffer.from(`fake-jpeg-idpage-${'x'.repeat(64)}`);
const SELFIE = Buffer.from(`fake-png-selfie-${'y'.repeat(64)}`);

function get(url: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost${url}`, { headers });
}

function post(url: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const idCtx = (id: number | string): IdCtx => ({ params: Promise.resolve({ id: String(id) }) });
const photoCtx = (id: number | string, kind: string): PhotoCtx => ({
  params: Promise.resolve({ id: String(id), kind }),
});

/** 交一份护照材料，返回流水 id。走的是真的领域函数，材料真落盘（FILES_DIR 指向临时目录）。 */
async function submit(userId = TARGET): Promise<number> {
  const { initPassportRealname } = await import('@/lib/auth/passport-realname');
  const r = initPassportRealname(db, {
    userId,
    realName: NAME,
    passportNo: PASSPORT_NO,
    idPage: { bytes: ID_PAGE, mime: 'image/jpeg' },
    selfie: { bytes: SELFIE, mime: 'image/png' },
  });
  if (!r.ok) throw new Error(`前置失败：${r.message}`);
  return r.verificationId;
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-adm-rn-${crypto.randomUUID()}.db`);
  process.env.FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-adm-rn-files-'));
  // 【发信必须真的走到 sendMail 并失败】不设 NOTIFY_DRY_RUN、不配 SMTP：
  // getTransport() 会抛「SMTP 凭证未配置」。判据 ⑥ 要的就是这条真实的失败路径。
  delete process.env.NOTIFY_DRY_RUN;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USERNAME;
  delete process.env.SMTP_PASSWORD;

  pendingGet = (await import('../pending/route')).GET;
  detailGet = (await import('../[id]/route')).GET;
  photoGet = (await import('../[id]/photo/[kind]/route')).GET;
  approvePost = (await import('../[id]/approve/route')).POST;
  rejectPost = (await import('../[id]/reject/route')).POST;
  statusGet = (await import('../../../realname/status/route')).GET;
  listUsers = (await import('../../users/route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  db.prepare('DELETE FROM admin_audit').run();
  db.prepare('DELETE FROM realname_verifications').run();
  // 【为什么连 files 一起清】storeBytes 按 sha256 去重：留着上一轮的行，下一次提交
  // 就命中去重、不再落盘。而本文件里有一条判据会**删光盘上的密文**——
  // 不清这张表，它就会把后面每一条依赖照片的用例一起毒死（且现象是"文件莫名其妙没了"）。
  db.prepare('DELETE FROM files').run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM users').run();

  ADMIN = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('boss@t.com').lastInsertRowid);
  TARGET = Number(
    db.prepare('INSERT INTO users (email) VALUES (?)').run('zhang@example.com').lastInsertRowid,
  );
  process.env.ADMIN_UIDS = String(ADMIN);
});

// ───────────────────────────── ① 鉴权面 ─────────────────────────────

describe('🔴 非管理员一律空体 404（五条路由同形）', () => {
  test('未登录 / 非白名单 / ADMIN_UIDS 空：五条全 404，体逐字为空', async () => {
    const vid = await submit();
    const outsider = signToken(TARGET);
    const cases: { name: string; token?: string; env: string }[] = [
      { name: '未登录', token: undefined, env: String(ADMIN) },
      { name: '非白名单', token: outsider, env: String(ADMIN) },
      { name: 'ADMIN_UIDS 空', token: signToken(ADMIN), env: '' },
    ];

    for (const c of cases) {
      process.env.ADMIN_UIDS = c.env;
      const responses = await Promise.all([
        pendingGet(get('/api/v1/admin/realname/pending', c.token)),
        detailGet(get(`/api/v1/admin/realname/${vid}`, c.token), idCtx(vid)),
        photoGet(get(`/api/v1/admin/realname/${vid}/photo/id_page`, c.token), photoCtx(vid, 'id_page')),
        approvePost(post(`/api/v1/admin/realname/${vid}/approve`, {}, c.token), idCtx(vid)),
        rejectPost(post(`/api/v1/admin/realname/${vid}/reject`, { reason: 'x' }, c.token), idCtx(vid)),
      ]);
      for (const res of responses) {
        expect(res.status, c.name).toBe(404);
        expect(await res.text(), c.name).toBe('');
      }
    }
    process.env.ADMIN_UIDS = String(ADMIN);
  });

  test('🔴 api key 身份（哪怕这把 key 属于管理员本人）同样 404', async () => {
    const vid = await submit();
    const { generateApiKey, hashApiKey } = await import('@/lib/auth/api-key');
    const { insertApiKey } = await import('@/lib/db/api-keys');
    const key = generateApiKey();
    insertApiKey(db, {
      userId: ADMIN,
      name: 'boss-agent',
      keyHash: hashApiKey(key),
      scopesJson: JSON.stringify(['case:read', 'case:write']),
      // 本测试只用这把 key 证明「api key 身份打后台一律 404」，不回看明文，密文占位即可
      secretEnc: 'test-envelope-not-decryptable',
    });

    const responses = await Promise.all([
      pendingGet(get('/api/v1/admin/realname/pending', key)),
      detailGet(get(`/api/v1/admin/realname/${vid}`, key), idCtx(vid)),
      photoGet(get(`/api/v1/admin/realname/${vid}/photo/id_page`, key), photoCtx(vid, 'id_page')),
      approvePost(post(`/api/v1/admin/realname/${vid}/approve`, {}, key), idCtx(vid)),
      rejectPost(post(`/api/v1/admin/realname/${vid}/reject`, { reason: 'x' }, key), idCtx(vid)),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(404);
      // 【为什么必须是空体】给 api key 一个专门的错误码，等于对着一把泄露的 key 承认
      // "这个后台存在，只是你的凭据类型不对"。与非白名单逐字同形才拦得住探测。
      expect(await res.text()).toBe('');
    }
  });

  test('🔴 被拒的写请求确实什么都没写', async () => {
    const vid = await submit();
    process.env.ADMIN_UIDS = '';
    await approvePost(post(`/api/v1/admin/realname/${vid}/approve`, {}, signToken(ADMIN)), idCtx(vid));
    await rejectPost(post(`/api/v1/admin/realname/${vid}/reject`, { reason: 'x' }, signToken(ADMIN)), idCtx(vid));
    process.env.ADMIN_UIDS = String(ADMIN);

    expect(db.prepare('SELECT COUNT(*) c FROM admin_audit').get()).toEqual({ c: 0 });
    const row = db.prepare('SELECT status FROM realname_verifications WHERE id=?').get(vid) as { status: string };
    expect(row.status).toBe('待审');
    expect((db.prepare('SELECT auth_status a FROM users WHERE id=?').get(TARGET) as { a: string }).a).toBe('待审');
  });
});

// ───────────────────────────── ② 队列与详情 ─────────────────────────────

describe('GET /admin/realname/pending', () => {
  test('列出待审、带解密后的姓名与护照号、带联系方式', async () => {
    const vid = await submit();
    const body = await (await pendingGet(get('/api/v1/admin/realname/pending', signToken(ADMIN)))).json();
    expect(body.count).toBe(1);
    expect(body.rows[0]).toMatchObject({
      verification_id: vid,
      user_id: TARGET,
      email: 'zhang@example.com',
      cert_name: NAME,
      cert_no: PASSPORT_NO,
      envelope_error: null,
    });
    expect(typeof body.rows[0].submitted_at).toBe('string');
  });

  test('🔴 同一人连交两次，队列只出最新那条（审到旧行会造成静默不一致）', async () => {
    const first = await submit();
    const second = await submit();
    const body = await (await pendingGet(get('/api/v1/admin/realname/pending', signToken(ADMIN)))).json();
    expect(body.count).toBe(1);
    expect(body.rows[0].verification_id).toBe(second);
    expect(body.rows[0].verification_id).not.toBe(first);
  });

  test('🔴 信封坏掉的那条照样现身，带 envelope_error 自述原因（静默跳过=这条待审永远没人看见）', async () => {
    const vid = await submit();
    // 真实形态：密钥换过 / 那一列被清过。解密在 readPassportEnvelope 里抛。
    db.prepare('UPDATE realname_verifications SET raw_meta_enc=? WHERE id=?').run('enc:v1:坏掉了', vid);

    const res = await pendingGet(get('/api/v1/admin/realname/pending', signToken(ADMIN)));
    expect(res.status).toBe(200);
    const body = await res.json();
    // 【变异对照】把那段 try/catch 改成"解不开就 continue"（或整条 500）→ count 变 0 / 状态非 200 → 红
    expect(body.count).toBe(1);
    expect(body.rows[0].verification_id).toBe(vid);
    expect(typeof body.rows[0].envelope_error).toBe('string');
    expect(body.rows[0].envelope_error.length).toBeGreaterThan(0);
    // 解不开就是解不开：不许在这两个字段上编一个占位值
    expect(body.rows[0].cert_name).toBe(null);
    expect(body.rows[0].cert_no).toBe(null);
  });

  test('🔴 队列里的手机号是解密后的全号（不是掩码、不是 null）', async () => {
    const { encryptField, hashLookup } = await import('@/lib/crypto');
    const SEEDED = '13800138888';
    db.prepare('UPDATE users SET phone_enc=?, phone_hash=? WHERE id=?')
      .run(encryptField(SEEDED), hashLookup(SEEDED), TARGET);
    await submit();

    const body = await (await pendingGet(get('/api/v1/admin/realname/pending', signToken(ADMIN)))).json();
    // 【变异对照】回退成 phone_masked（`138****8888`）或忘了解密（null）→ 这里逐字对不上 → 红
    expect(body.rows[0].phone).toBe(SEEDED);
    expect(body.rows[0].phone_error).toBe(null);
  });

  test('审结之后离开队列', async () => {
    const vid = await submit();
    await approvePost(post(`/api/v1/admin/realname/${vid}/approve`, {}, signToken(ADMIN)), idCtx(vid));
    const body = await (await pendingGet(get('/api/v1/admin/realname/pending', signToken(ADMIN)))).json();
    expect(body.count).toBe(0);
  });
});

describe('GET /admin/realname/:id', () => {
  test('详情给姓名/护照号/材料哈希与大小，但**不给字节**', async () => {
    const vid = await submit();
    const res = await detailGet(get(`/api/v1/admin/realname/${vid}`, signToken(ADMIN)), idCtx(vid));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ verification_id: vid, user_id: TARGET, status: '待审', cert_name: NAME, cert_no: PASSPORT_NO });
    expect(body.materials.id_page.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.materials.id_page.size).toBe(ID_PAGE.length);
    expect(body.materials.id_page.file_id).toBeUndefined();
  });

  test('查无此行 / 非护照通道 → 空体 404', async () => {
    const cloud = Number(
      db.prepare("INSERT INTO realname_verifications (user_id, provider, status) VALUES (?, 'cloudauth', '待审')").run(TARGET).lastInsertRowid,
    );
    for (const id of [99999, cloud]) {
      const res = await detailGet(get(`/api/v1/admin/realname/${id}`, signToken(ADMIN)), idCtx(id));
      expect(res.status, String(id)).toBe(404);
      expect(await res.text()).toBe('');
    }
  });

  test('已驳回的记录仍翻得出来（含驳回原因），不因"已落定"而报错', async () => {
    const vid = await submit();
    await rejectPost(post(`/api/v1/admin/realname/${vid}/reject`, { reason: '照片模糊' }, signToken(ADMIN)), idCtx(vid));
    const body = await (await detailGet(get(`/api/v1/admin/realname/${vid}`, signToken(ADMIN)), idCtx(vid))).json();
    expect(body.status).toBe('未通过');
    expect(body.reject.reason).toBe('照片模糊');
  });
});

// ───────────────────────────── ③ 照片路由 ─────────────────────────────

describe('🔴 GET /admin/realname/:id/photo/:kind', () => {
  test('管理员拿到原始字节，Content-Type 与上传时一致，且带 no-store', async () => {
    const vid = await submit();
    for (const [kind, bytes, mime] of [
      ['id_page', ID_PAGE, 'image/jpeg'],
      ['selfie', SELFIE, 'image/png'],
    ] as const) {
      const res = await photoGet(
        get(`/api/v1/admin/realname/${vid}/photo/${kind}`, signToken(ADMIN)),
        photoCtx(vid, kind),
      );
      expect(res.status, kind).toBe(200);
      // 【变异对照】若路由用 NextResponse.json 包了一层，这里会是 application/json → 红
      expect(res.headers.get('content-type'), kind).toBe(mime);
      expect(res.headers.get('cache-control'), kind).toBe('no-store');
      // 【为什么这条也要钉】回的是用户上传的字节。没有 nosniff，浏览器会按内容猜类型——
      // 一份"声明是 image/jpeg、内容是 HTML"的材料就会在本站源上被当页面渲染，
      // 而本站的登录态就在 localStorage 里。少这一个头不报错、不崩，平时看不出来。
      expect(res.headers.get('x-content-type-options'), kind).toBe('nosniff');
      const got = Buffer.from(await res.arrayBuffer());
      expect(got.equals(bytes), kind).toBe(true);
    }
  });

  test('kind 非法 → 400 BAD_KIND（但非管理员即便 kind 非法也只得到 404）', async () => {
    const vid = await submit();
    const bad = await photoGet(
      get(`/api/v1/admin/realname/${vid}/photo/passport_back`, signToken(ADMIN)),
      photoCtx(vid, 'passport_back'),
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error_code).toBe('BAD_KIND');

    // 闸门在前：非管理员不该靠 400/404 的差异判断出这条路由存在
    const outsider = await photoGet(
      get(`/api/v1/admin/realname/${vid}/photo/passport_back`, signToken(TARGET)),
      photoCtx(vid, 'passport_back'),
    );
    expect(outsider.status).toBe(404);
    expect(await outsider.text()).toBe('');
  });

  test('🔴 非图片的材料一律 415，不把字节交给浏览器', async () => {
    const vid = await submit();
    // 真实形态：上传面哪天松了口，或历史行里躺着一条别的类型。
    db.prepare("UPDATE files SET mime='text/html'").run();
    const res = await photoGet(
      get(`/api/v1/admin/realname/${vid}/photo/id_page`, signToken(ADMIN)),
      photoCtx(vid, 'id_page'),
    );
    // 【变异对照】把 mime 白名单去掉 → 这里变成 200 + text/html → 红
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error_code).toBe('BAD_MATERIAL_MIME');
    // 415 的体里不许夹带原始字节
    expect(JSON.stringify(body)).not.toContain(ID_PAGE.toString('utf-8'));
  });

  test('盘上密文没了 → 500 且说清是哪一种坏（不伪装成"没这张图"）', async () => {
    const vid = await submit();
    for (const f of fs.readdirSync(process.env.FILES_DIR!, { recursive: true }) as string[]) {
      const abs = path.join(process.env.FILES_DIR!, f);
      if (fs.statSync(abs).isFile()) fs.unlinkSync(abs);
    }
    const res = await photoGet(
      get(`/api/v1/admin/realname/${vid}/photo/id_page`, signToken(ADMIN)),
      photoCtx(vid, 'id_page'),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error_code).toBe('MATERIAL_UNREADABLE');
    expect(body.message).toContain('密文缺失');
  });
});

// ───────────────────────────── ④ 通过 ─────────────────────────────

describe('🔴 POST /admin/realname/:id/approve', () => {
  test('users 转已实名 + cert_type=护照 + 两列密文非空；审计恰好一行；队列清空', async () => {
    const vid = await submit();
    const res = await approvePost(
      post(`/api/v1/admin/realname/${vid}/approve`, { note: '姓名与护照号逐字核对一致' }, signToken(ADMIN)),
      idCtx(vid),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      user_id: TARGET,
      cert_type: '护照',
      auth_status: '已实名',
    });

    const u = db
      .prepare('SELECT auth_status, cert_type, real_name_enc, id_card_enc FROM users WHERE id=?')
      .get(TARGET) as Record<string, string | null>;
    expect(u.auth_status).toBe('已实名');
    expect(u.cert_type).toBe('护照');
    expect(u.real_name_enc).toBeTruthy();
    expect(u.id_card_enc).toBeTruthy();
    // 回填的是密文，不是明文
    expect(u.id_card_enc).not.toContain(PASSPORT_NO);
    expect(u.real_name_enc).not.toContain(NAME);

    const audit = db.prepare('SELECT * FROM admin_audit').all() as
      { action: string; operator_uid: number; target_uid: number; detail_json: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'approve_realname', operator_uid: ADMIN, target_uid: TARGET });
    expect(JSON.parse(audit[0].detail_json).verification_id).toBe(vid);
    // 审计明细不含 PII
    expect(audit[0].detail_json).not.toContain(PASSPORT_NO);
    expect(audit[0].detail_json).not.toContain(NAME);
  });

  test('🔴 用户端 /api/v1/realname/status 跟着变成「已实名」', async () => {
    const vid = await submit();
    const before = await (await statusGet(get('/api/v1/realname/status', signToken(TARGET)))).json();
    expect(before).toMatchObject({ auth_status: '待审', verification_status: '待审', method: 'passport' });

    await approvePost(post(`/api/v1/admin/realname/${vid}/approve`, {}, signToken(ADMIN)), idCtx(vid));

    const after = await (await statusGet(get('/api/v1/realname/status', signToken(TARGET)))).json();
    expect(after).toMatchObject({
      auth_status: '已实名',
      verification_status: '已实名',
      method: 'passport',
      message: '认证通过',
    });
  });

  test('🔴 已落定的不许二次审核：400 BAD_STATE，且不多落一行审计', async () => {
    const vid = await submit();
    await approvePost(post(`/api/v1/admin/realname/${vid}/approve`, {}, signToken(ADMIN)), idCtx(vid));
    const again = await approvePost(post(`/api/v1/admin/realname/${vid}/approve`, {}, signToken(ADMIN)), idCtx(vid));
    expect(again.status).toBe(400);
    expect((await again.json()).error_code).toBe('BAD_STATE');
    expect(db.prepare('SELECT COUNT(*) c FROM admin_audit').get()).toEqual({ c: 1 });
  });

  test('流水不存在 / 不是护照通道 → 404，不是 400（点错行与被抢先审过必须分得开）', async () => {
    const res = await approvePost(post('/api/v1/admin/realname/99999/approve', {}, signToken(ADMIN)), idCtx(99999));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });
});

// ───────────────────────────── ⑤ 驳回 ─────────────────────────────

describe('🔴 POST /admin/realname/:id/reject', () => {
  test('原因必填：缺字段 / 空串 / 纯空格都 400 BAD_REASON，且什么都没写', async () => {
    const vid = await submit();
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 123 }]) {
      const res = await rejectPost(post(`/api/v1/admin/realname/${vid}/reject`, body, signToken(ADMIN)), idCtx(vid));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error_code).toBe('BAD_REASON');
    }
    expect((db.prepare('SELECT status s FROM realname_verifications WHERE id=?').get(vid) as { s: string }).s).toBe('待审');
    expect(db.prepare('SELECT COUNT(*) c FROM admin_audit').get()).toEqual({ c: 0 });
  });

  test('🔴 驳回后：用户端 status 回显**原因原文**，状态可重交', async () => {
    const vid = await submit();
    const REASON = '手持自拍看不清护照号，请在光线足的地方重拍一张';
    const res = await rejectPost(post(`/api/v1/admin/realname/${vid}/reject`, { reason: REASON }, signToken(ADMIN)), idCtx(vid));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, user_id: TARGET, auth_status: '未认证' });

    const status = await (await statusGet(get('/api/v1/realname/status', signToken(TARGET)))).json();
    expect(status.verification_status).toBe('未通过');
    // 【变异对照】读错字段路径（env.audit 而不是 env.reject）→ 这里退回硬编码「认证未通过」→ 红
    expect(status.message).toBe(REASON);
    expect(status.auth_status).toBe('未认证');

    // 可重交：新一条待审流水进队列
    const nextVid = await submit();
    const queue = await (await pendingGet(get('/api/v1/admin/realname/pending', signToken(ADMIN)))).json();
    expect(queue.count).toBe(1);
    expect(queue.rows[0].verification_id).toBe(nextVid);

    const audit = db.prepare('SELECT action, detail_json FROM admin_audit').all() as
      { action: string; detail_json: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('reject_realname');
    expect(JSON.parse(audit[0].detail_json).reason).toBe(REASON);
  });

  test('已驳回的记录不得再被通过（用户不会莫名其妙"被通过"）', async () => {
    const vid = await submit();
    await rejectPost(post(`/api/v1/admin/realname/${vid}/reject`, { reason: '照片模糊' }, signToken(ADMIN)), idCtx(vid));
    const res = await approvePost(post(`/api/v1/admin/realname/${vid}/approve`, {}, signToken(ADMIN)), idCtx(vid));
    expect(res.status).toBe(400);
    expect((db.prepare('SELECT auth_status a FROM users WHERE id=?').get(TARGET) as { a: string }).a).toBe('未认证');
  });
});

// ─────────────── ⑧ 陈旧流水：审的必须是该用户最新那一行 ───────────────

describe('🔴 STALE_VERIFICATION：不是 MAX(id) 那行，一律 409 且什么都没写', () => {
  test('管理员打开队列之后用户又交了一份 → 审旧行 409，审新行照常 200', async () => {
    const stale = await submit();
    const fresh = await submit();
    expect(fresh).toBeGreaterThan(stale);

    for (const [name, call] of [
      ['approve', () => approvePost(post(`/api/v1/admin/realname/${stale}/approve`, {}, signToken(ADMIN)), idCtx(stale))],
      ['reject', () => rejectPost(post(`/api/v1/admin/realname/${stale}/reject`, { reason: '照片模糊' }, signToken(ADMIN)), idCtx(stale))],
    ] as const) {
      const res = await call();
      // 【变异对照】去掉 latestVerificationIdForUser 那一比 → 这里变 200（旧行落定，
      // 而 /realname/status 只认新行，用户界面继续显示"等待人工核验"）→ 红
      expect(res.status, name).toBe(409);
      expect((await res.json()).error_code, name).toBe('STALE_VERIFICATION');
    }

    // 被拒的两次确实什么都没写：两行流水都还在待审，用户没被改，审计 0 行
    for (const id of [stale, fresh]) {
      expect((db.prepare('SELECT status s FROM realname_verifications WHERE id=?').get(id) as { s: string }).s).toBe('待审');
    }
    expect((db.prepare('SELECT auth_status a FROM users WHERE id=?').get(TARGET) as { a: string }).a).toBe('待审');
    expect(db.prepare('SELECT COUNT(*) c FROM admin_audit').get()).toEqual({ c: 0 });

    const ok = await approvePost(post(`/api/v1/admin/realname/${fresh}/approve`, {}, signToken(ADMIN)), idCtx(fresh));
    expect(ok.status).toBe(200);
  });

  test('409 与 400 分得开：同一条流水"陈旧"和"已落定"不是同一个码', async () => {
    const vid = await submit();
    await approvePost(post(`/api/v1/admin/realname/${vid}/approve`, {}, signToken(ADMIN)), idCtx(vid));
    // 仍是 MAX(id)，只是已经落定 → 400 BAD_STATE（不是 409）
    const again = await approvePost(post(`/api/v1/admin/realname/${vid}/approve`, {}, signToken(ADMIN)), idCtx(vid));
    expect(again.status).toBe(400);
    expect((await again.json()).error_code).toBe('BAD_STATE');
  });
});

// ─────────────── ⑨ 备注 / 驳回原因的字数上限 ───────────────

describe('🔴 reason / note 超长 → 400（审计表要给人翻，不能被一份聊天记录读废）', () => {
  test('note 500 字放行、501 字 BAD_NOTE 且什么都没写', async () => {
    const vid = await submit();
    const tooLong = await approvePost(
      post(`/api/v1/admin/realname/${vid}/approve`, { note: '核'.repeat(501) }, signToken(ADMIN)),
      idCtx(vid),
    );
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error_code).toBe('BAD_NOTE');
    expect(db.prepare('SELECT COUNT(*) c FROM admin_audit').get()).toEqual({ c: 0 });
    expect((db.prepare('SELECT status s FROM realname_verifications WHERE id=?').get(vid) as { s: string }).s).toBe('待审');

    const ok = await approvePost(
      post(`/api/v1/admin/realname/${vid}/approve`, { note: '核'.repeat(500) }, signToken(ADMIN)),
      idCtx(vid),
    );
    expect(ok.status).toBe(200);
  });

  test('reason 500 字放行、501 字 BAD_REASON 且什么都没写', async () => {
    const vid = await submit();
    const tooLong = await rejectPost(
      post(`/api/v1/admin/realname/${vid}/reject`, { reason: '糊'.repeat(501) }, signToken(ADMIN)),
      idCtx(vid),
    );
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error_code).toBe('BAD_REASON');
    expect(db.prepare('SELECT COUNT(*) c FROM admin_audit').get()).toEqual({ c: 0 });

    const ok = await rejectPost(
      post(`/api/v1/admin/realname/${vid}/reject`, { reason: '糊'.repeat(500) }, signToken(ADMIN)),
      idCtx(vid),
    );
    expect(ok.status).toBe(200);
  });
});

// ───────────────────────── ⑥ 通知：尽力而为 ─────────────────────────

describe('🔴 审核通知发不出去，不影响审核已经落定', () => {
  test('SMTP 未配置（sendMail 真的抛）→ 仍 200、notified=failed、DB 已提交', async () => {
    const vid = await submit();
    const res = await approvePost(post(`/api/v1/admin/realname/${vid}/approve`, {}, signToken(ADMIN)), idCtx(vid));
    expect(res.status).toBe(200);
    const body = await res.json();
    // 【变异对照】把 sendMail 写进 db.transaction 的回调里 → 抛错会把落定一起回滚，
    // 下面这三条会同时翻红（状态还是待审、审计 0 行）。
    expect(body.notified).toBe('failed');
    expect((db.prepare('SELECT auth_status a FROM users WHERE id=?').get(TARGET) as { a: string }).a).toBe('已实名');
    expect(db.prepare('SELECT COUNT(*) c FROM admin_audit').get()).toEqual({ c: 1 });
  });

  test('没绑邮箱的用户：优雅跳过（notified=no_email），不抛、不重试', async () => {
    const noMail = Number(db.prepare('INSERT INTO users (email) VALUES (NULL)').run().lastInsertRowid);
    const vid = await submit(noMail);
    const res = await rejectPost(post(`/api/v1/admin/realname/${vid}/reject`, { reason: '照片模糊' }, signToken(ADMIN)), idCtx(vid));
    expect(res.status).toBe(200);
    expect((await res.json()).notified).toBe('no_email');
    expect((db.prepare('SELECT status s FROM realname_verifications WHERE id=?').get(vid) as { s: string }).s).toBe('未通过');
  });

  test('注入一个会成功的 sendMail → sent；注入一个会抛的 → failed（证明这三态真的分得开）', async () => {
    const { notifyRealnameReviewed } = await import('@/lib/admin/realname-notify');
    const seen: { to: string; subject: string }[] = [];
    expect(
      await notifyRealnameReviewed(db, TARGET, {
        sendMail: async (to, copy) => {
          seen.push({ to, subject: copy.subject });
        },
      }),
    ).toBe('sent');
    expect(seen).toHaveLength(1);
    expect(seen[0].to).toBe('zhang@example.com');
    // 出站文案里不许出现结论与 PII
    for (const w of ['已实名', '未通过', '护照', NAME, PASSPORT_NO]) {
      expect(seen[0].subject).not.toContain(w);
    }

    expect(
      await notifyRealnameReviewed(db, TARGET, {
        sendMail: async () => {
          throw new Error('SMTP 凭证未配置');
        },
      }),
    ).toBe('failed');
  });
});

// ───────────────────── ⑦ 手机号全显（后台账号列表回归）─────────────────────

describe('🔴 /admin/users 手机号全显与片段检索（裁决 B）', () => {
  test('全号出参、片段检索命中、解不开的行自述原因', async () => {
    const { encryptField, hashLookup } = await import('@/lib/crypto');
    db.prepare('UPDATE users SET phone_enc=?, phone_hash=? WHERE id=?')
      .run(encryptField('13800138888'), hashLookup('13800138888'), TARGET);
    const brokenUid = Number(
      db.prepare('INSERT INTO users (phone_enc, phone_hash, email) VALUES (?,?,?)')
        .run('enc:v1:坏掉了', hashLookup('13700000000'), 'broken@t.com').lastInsertRowid,
    );

    const all = await (await listUsers(get('/api/v1/admin/users', signToken(ADMIN)))).json();
    const target = all.rows.find((r: { uid: number }) => r.uid === TARGET);
    expect(target.phone).toBe('13800138888');
    expect(target.phone_error).toBe(null);
    const broken = all.rows.find((r: { uid: number }) => r.uid === brokenUid);
    expect(broken.phone).toBe(null);
    expect(broken.phone_error).toBeTruthy();

    const fuzzy = await (await listUsers(get('/api/v1/admin/users?field=phone&q=8888', signToken(ADMIN)))).json();
    expect(fuzzy.total).toBe(1);
    expect(fuzzy.rows[0].uid).toBe(TARGET);
  });
});
