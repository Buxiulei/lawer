// app/src/app/api/v1/admin/__tests__/routes.test.ts
// 后台四条路由的端到端。判据全在这里过一遍真 Request/Response：
//   非白名单 404 / ADMIN_UIDS 空全拒 / 列表只出掩码 / 发值走账本且同 refId 只一次 /
//   调会员写行带操作痕 / 每笔操作落 admin_audit。
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { signToken } from '@/lib/auth/jwt';

type Handler = (req: Request) => Promise<Response>;
type UidHandler = (req: Request, ctx: { params: Promise<{ uid: string }> }) => Promise<Response>;

let listUsers: Handler;
let listAudit: Handler;
let postMembership: UidHandler;
let postGongdao: UidHandler;
let db: Database;

let ADMIN = 0;
let TARGET = 0;

function get(url: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost${url}`, { headers });
}

function post(url: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

const ctx = (uid: number) => ({ params: Promise.resolve({ uid: String(uid) }) });

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-admin-${crypto.randomUUID()}.db`);

  listUsers = (await import('../users/route')).GET;
  listAudit = (await import('../audit/route')).GET;
  postMembership = (await import('../users/[uid]/membership/route')).POST;
  postGongdao = (await import('../users/[uid]/gongdao/route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(async () => {
  db.prepare('DELETE FROM admin_audit').run();
  db.prepare('DELETE FROM gongdao_ledger').run();
  db.prepare('DELETE FROM gongdao').run();
  db.prepare('DELETE FROM memberships').run();
  db.prepare('DELETE FROM cases').run();
  db.prepare('DELETE FROM users').run();

  const { encryptField, hashLookup } = await import('@/lib/crypto');
  ADMIN = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('boss@t.com').lastInsertRowid);
  TARGET = Number(
    db.prepare('INSERT INTO users (phone_enc, phone_hash, email) VALUES (?,?,?)')
      .run(encryptField('13800138888'), hashLookup('13800138888'), 'zhang@example.com')
      .lastInsertRowid,
  );
  process.env.ADMIN_UIDS = String(ADMIN);
});

// ───────────────────────────── 鉴权面 ─────────────────────────────

describe('非白名单一律 404', () => {
  test('未登录 / 非白名单登录用户 / 空 ADMIN_UIDS，四条路由全部 404 且响应同形', async () => {
    const outsiderToken = signToken(TARGET);
    const cases: { name: string; token?: string; env: string }[] = [
      { name: '未登录', token: undefined, env: String(ADMIN) },
      { name: '非白名单', token: outsiderToken, env: String(ADMIN) },
      { name: 'ADMIN_UIDS 空', token: signToken(ADMIN), env: '' },
    ];

    for (const c of cases) {
      process.env.ADMIN_UIDS = c.env;
      const responses = await Promise.all([
        listUsers(get('/api/v1/admin/users', c.token)),
        listAudit(get('/api/v1/admin/audit', c.token)),
        postMembership(post(`/api/v1/admin/users/${TARGET}/membership`, { plan: 'pro', days: 31 }, c.token), ctx(TARGET)),
        postGongdao(post(`/api/v1/admin/users/${TARGET}/gongdao`, { delta: 100, note: 'x' }, c.token), ctx(TARGET)),
      ]);
      for (const res of responses) {
        expect(res.status, c.name).toBe(404);
        expect(await res.text(), c.name).toBe(''); // 空体：与不存在的地址逐字同形
      }
    }
  });

  test('被拒的写请求确实什么都没写（不是只把响应改成 404）', async () => {
    process.env.ADMIN_UIDS = '';
    await postGongdao(post(`/api/v1/admin/users/${TARGET}/gongdao`, { delta: 999, note: 'x' }, signToken(ADMIN)), ctx(TARGET));
    await postMembership(post(`/api/v1/admin/users/${TARGET}/membership`, { plan: 'pro', days: 31 }, signToken(ADMIN)), ctx(TARGET));
    expect(db.prepare('SELECT COUNT(*) c FROM gongdao_ledger').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM memberships').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM admin_audit').get()).toEqual({ c: 0 });
  });
});

// ───────────────────────────── 列表 ─────────────────────────────

describe('GET /admin/users', () => {
  // 【2026-09-03 判据翻转】主理人：「手机号不要脱敏，这是管理后台」。
  // 原判据是"正文里没有 11 位连续数字"，现在反过来：全号必须原样出现在响应里。
  // 掩码回潮（把 maskPhoneTail4 找回来）在这条上即红。
  test('🔴 手机号出全号：响应正文里就是那 11 位', async () => {
    const res = await listUsers(get('/api/v1/admin/users', signToken(ADMIN)));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('13800138888');
    expect(text).not.toContain('****8888');
    const body = JSON.parse(text);
    const row = body.rows.find((r: { uid: number }) => r.uid === TARGET);
    expect(row.phone).toBe('13800138888');
    expect(row.phone_error).toBe(null);
  });

  // M13：出参绝不带 phone_enc（密文是 base64，不含 11 位数字，`\d{11}` 那条判据挡不住它）。
  // 掩码在服务端算完即把 phone_enc 从行里剔除；这条独立盯住「密文没随行漏出去」。
  test('出参不含 phone_enc 字段，也不含手机号密文本体', async () => {
    const res = await listUsers(get('/api/v1/admin/users', signToken(ADMIN)));
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.rows.length).toBeGreaterThan(0);
    for (const r of body.rows) expect(Object.prototype.hasOwnProperty.call(r, 'phone_enc')).toBe(false);
    // 库里 TARGET 的真实密文一个字符都不该出现在响应里
    const enc = (db.prepare('SELECT phone_enc AS e FROM users WHERE id=?').get(TARGET) as { e: string }).e;
    expect(enc).toBeTruthy();
    expect(text).not.toContain(enc);
  });

  test('🔴 手机检索：全号走 hash 精确，≤10 位片段走解密扫描（原来这里是空结果 + 提示）', async () => {
    const hit = await (await listUsers(get('/api/v1/admin/users?field=phone&q=13800138888', signToken(ADMIN)))).json();
    expect(hit.total).toBe(1);
    expect(hit.rows[0].uid).toBe(TARGET);

    const fuzzy = await (await listUsers(get('/api/v1/admin/users?field=phone&q=138', signToken(ADMIN)))).json();
    expect(fuzzy.total).toBe(1);
    expect(fuzzy.rows[0].uid).toBe(TARGET);
    expect(fuzzy.hint).toBe(null);

    // 12 位以上仍是"格式不对"，不静默当全量
    const bad = await (await listUsers(get('/api/v1/admin/users?field=phone&q=138001388881', signToken(ADMIN)))).json();
    expect(bad.total).toBe(0);
    expect(bad.hint).toContain('11 位全号');
  });

  test('按 uid 精确、按邮箱子串', async () => {
    const byUid = await (await listUsers(get(`/api/v1/admin/users?field=uid&q=${TARGET}`, signToken(ADMIN)))).json();
    expect(byUid.total).toBe(1);
    const byEmail = await (await listUsers(get('/api/v1/admin/users?field=email&q=example.com', signToken(ADMIN)))).json();
    expect(byEmail.total).toBe(1);
  });

  test('回 self_uid（前端拿它拼幂等键，不自己猜）', async () => {
    const body = await (await listUsers(get('/api/v1/admin/users', signToken(ADMIN)))).json();
    expect(body.self_uid).toBe(ADMIN);
  });
});

// ───────────────────────────── 调会员 ─────────────────────────────

describe('POST /admin/users/{uid}/membership', () => {
  test('写 memberships 行，order_no 带 admin-<操作者uid>- 操作痕，并落审计', async () => {
    const res = await postMembership(
      post(`/api/v1/admin/users/${TARGET}/membership`, { plan: 'standard', days: 92 }, signToken(ADMIN)),
      ctx(TARGET),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order_no).toMatch(new RegExp(`^admin-${ADMIN}-\\d{10,}$`));

    const row = db.prepare('SELECT plan, order_no FROM memberships WHERE user_id=?').get(TARGET) as
      { plan: string; order_no: string };
    expect(row.plan).toBe('standard');
    expect(row.order_no).toBe(body.order_no);
    expect(row.order_no.startsWith(`admin-${ADMIN}-`)).toBe(true);

    const audit = db.prepare('SELECT * FROM admin_audit').all() as {
      action: string; operator_uid: number; target_uid: number; detail_json: string;
    }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'grant_membership', operator_uid: ADMIN, target_uid: TARGET });
    expect(JSON.parse(audit[0].detail_json)).toMatchObject({ plan: 'standard', days: 92, order_no: body.order_no });
  });

  test('降档：立即生效，原档提前到期', async () => {
    await postMembership(post(`/api/v1/admin/users/${TARGET}/membership`, { plan: 'pro', days: 365 }, signToken(ADMIN)), ctx(TARGET));
    await new Promise((r) => setTimeout(r, 2)); // 换一个毫秒，order_no 不撞
    const res = await postMembership(
      post(`/api/v1/admin/users/${TARGET}/membership`, { plan: 'entry', days: 31 }, signToken(ADMIN)),
      ctx(TARGET),
    );
    const body = await res.json();
    expect(body.downgraded).toBe(true);
    const { getMembership } = await import('@/lib/billing/fulfillment');
    expect(getMembership(db, TARGET).plan).toBe('entry');
  });

  test('档位/天数不合法 → 400，且一行都不写', async () => {
    for (const bad of [{ plan: 'vip', days: 31 }, { plan: 'pro', days: 30 }, { plan: 'pro', days: 0 }]) {
      const res = await postMembership(
        post(`/api/v1/admin/users/${TARGET}/membership`, bad, signToken(ADMIN)),
        ctx(TARGET),
      );
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) c FROM memberships').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM admin_audit').get()).toEqual({ c: 0 });
  });

  test('目标 uid 不存在 → 404（与非白名单同形，不泄漏 uid 是否被占用）', async () => {
    const res = await postMembership(
      post('/api/v1/admin/users/99999/membership', { plan: 'pro', days: 31 }, signToken(ADMIN)),
      ctx(99999),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(''); // 空体：与非白名单闸门 404 逐字同形
  });

  // ── 跨请求幂等（钱/权益路径的双发洞）──
  test('同 op_ref 双发只写一行、到期恒 365 天（非 730）：一次重试不把会员期翻倍', async () => {
    const opRef = `admin-${ADMIN}-${Date.now()}-abcdef01`;
    const body = { plan: 'pro', days: 365, op_ref: opRef };
    const first = await (await postMembership(post(`/api/v1/admin/users/${TARGET}/membership`, body, signToken(ADMIN)), ctx(TARGET))).json();
    const second = await (await postMembership(post(`/api/v1/admin/users/${TARGET}/membership`, body, signToken(ADMIN)), ctx(TARGET))).json();

    expect(first.applied).toBe(true);
    // 第二次（重试）幂等短路：不是报错，是成功 + applied=false
    expect(second.applied).toBe(false);
    expect(second.order_no).toBe(opRef);

    // 恒 1 行，order_no 就是这把 op_ref
    expect(db.prepare('SELECT COUNT(*) c FROM memberships WHERE user_id=?').get(TARGET)).toEqual({ c: 1 });
    const row = db.prepare('SELECT started_at, expires_at, order_no FROM memberships WHERE user_id=?').get(TARGET) as
      { started_at: string; expires_at: string; order_no: string };
    expect(row.order_no).toBe(opRef);
    // 到期 = 起算 + 365 天，不是 730：证明第二次没有叠加
    const span = (Date.parse(`${row.expires_at.replace(' ', 'T')}Z`) - Date.parse(`${row.started_at.replace(' ', 'T')}Z`)) / 86400000;
    expect(Math.round(span)).toBe(365);
    // 审计只在首发落一行（幂等短路不重复落）
    expect(db.prepare("SELECT COUNT(*) c FROM admin_audit WHERE action='grant_membership'").get()).toEqual({ c: 1 });
  });

  test('op_ref 冒充别人的操作痕 → 400，不写行', async () => {
    const res = await postMembership(
      post(`/api/v1/admin/users/${TARGET}/membership`, { plan: 'pro', days: 31, op_ref: `admin-${ADMIN + 99}-1788220800000-abcdef01` }, signToken(ADMIN)),
      ctx(TARGET),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('BAD_OP_REF');
    expect(db.prepare('SELECT COUNT(*) c FROM memberships').get()).toEqual({ c: 0 });
  });
});

// ───────────────────────────── 发公道值 ─────────────────────────────

describe('POST /admin/users/{uid}/gongdao', () => {
  test('走账本入账 + 落审计；余额 ≡ Σledger', async () => {
    const res = await postGongdao(
      post(`/api/v1/admin/users/${TARGET}/gongdao`, { delta: 1500, note: '客诉补偿' }, signToken(ADMIN)),
      ctx(TARGET),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, delta: 1500, balance: 1500, applied: true });
    expect(body.ref_id).toMatch(new RegExp(`^admin-${ADMIN}-\\d{10,}-[0-9a-f]{8}$`));

    const ledger = db.prepare('SELECT delta, type FROM gongdao_ledger WHERE ref_id=?').get(body.ref_id) as
      { delta: number; type: string };
    expect(ledger).toEqual({ delta: 1500, type: '管理员调整' });

    const bal = db.prepare('SELECT balance FROM gongdao WHERE user_id=?').get(TARGET) as { balance: number };
    const sum = db.prepare('SELECT COALESCE(SUM(delta),0) s FROM gongdao_ledger WHERE user_id=?').get(TARGET) as { s: number };
    expect(bal.balance).toBe(sum.s);

    const audit = db.prepare('SELECT action, detail_json FROM admin_audit').all() as
      { action: string; detail_json: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('grant_gongdao');
    expect(JSON.parse(audit[0].detail_json)).toMatchObject({ delta: 1500, note: '客诉补偿', applied: true });
  });

  test('同 op_ref 双发只入账一次，余额不翻倍，第二次 applied=false', async () => {
    const opRef = `admin-${ADMIN}-${Date.now()}-abcdef01`;
    const body = { delta: 500, note: '重试', op_ref: opRef };
    const first = await (await postGongdao(post(`/api/v1/admin/users/${TARGET}/gongdao`, body, signToken(ADMIN)), ctx(TARGET))).json();
    const second = await (await postGongdao(post(`/api/v1/admin/users/${TARGET}/gongdao`, body, signToken(ADMIN)), ctx(TARGET))).json();

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.balance).toBe(500);
    expect(db.prepare('SELECT COUNT(*) c FROM gongdao_ledger WHERE ref_id=?').get(opRef)).toEqual({ c: 1 });
    // 两次都留审计（试过但没生效 ≠ 没试过）
    expect(db.prepare('SELECT COUNT(*) c FROM admin_audit').get()).toEqual({ c: 2 });
  });

  test('op_ref 冒充别人的操作痕 → 400，不入账', async () => {
    const res = await postGongdao(
      post(`/api/v1/admin/users/${TARGET}/gongdao`, { delta: 100, note: 'x', op_ref: `admin-${ADMIN + 99}-1788220800000-abcdef01` }, signToken(ADMIN)),
      ctx(TARGET),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('BAD_OP_REF');
    expect(db.prepare('SELECT COUNT(*) c FROM gongdao_ledger').get()).toEqual({ c: 0 });
  });

  test('数额非正 / 备注为空 → 400，不入账不落审计', async () => {
    for (const bad of [{ delta: 0, note: 'x' }, { delta: -5, note: 'x' }, { delta: 1.5, note: 'x' }, { delta: 10, note: '  ' }]) {
      const res = await postGongdao(post(`/api/v1/admin/users/${TARGET}/gongdao`, bad, signToken(ADMIN)), ctx(TARGET));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) c FROM gongdao_ledger').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM admin_audit').get()).toEqual({ c: 0 });
  });
});

// ───────────────────────────── 审计列表 ─────────────────────────────

describe('GET /admin/audit', () => {
  test('倒序给出最近操作，两类动作都在', async () => {
    await postGongdao(post(`/api/v1/admin/users/${TARGET}/gongdao`, { delta: 10, note: 'a' }, signToken(ADMIN)), ctx(TARGET));
    await postMembership(post(`/api/v1/admin/users/${TARGET}/membership`, { plan: 'entry', days: 31 }, signToken(ADMIN)), ctx(TARGET));

    const body = await (await listAudit(get('/api/v1/admin/audit', signToken(ADMIN)))).json();
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].action).toBe('grant_membership'); // 最新在前
    expect(body.rows[1].action).toBe('grant_gongdao');
    expect(body.rows.every((r: { operator_uid: number }) => r.operator_uid === ADMIN)).toBe(true);
  });
});
