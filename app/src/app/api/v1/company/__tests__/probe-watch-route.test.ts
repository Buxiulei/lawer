// app/src/app/api/v1/company/__tests__/probe-watch-route.test.ts
// 报价页新接的两条端点的对外行为。要害：
//   · 探测降级**不返回空载荷**（空会被读成「查无此公司」，而实际是「这一刻没去查」）
//   · 缓存命中不占配额（命中的边际成本为 0，扣补贴额度是收错了钱）
//   · 加守望要 case:write（它让这个账号下个月产生一笔月费，与会花钱的动作同级）
//   · 连点去重命中时回的档位是**库里那一行的**，不是请求里那个——回显请求档位会让
//     页面显示「已按每周档盯着」而库里其实是每日档，用户下月收到的是另一个数字
//   · 别人的案件与不存在的案件返回同一个 404
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';
import { WATCH_TIER_GONGDAO } from '@/lib/billing/pricing';

type Handler = (req: Request) => Promise<Response>;
type IdHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let probe: Handler;
let watch: IdHandler;
let db: Database;
let userA: number;
let userB: number;
let caseA: number;

function post(url: string, payload: unknown, auth: string): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
    body: JSON.stringify(payload),
  });
}

const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

/** 只带 case:read 的 key，用来验加守望的 scope 闸门。 */
function readOnlyKey(uid: number): string {
  const key = generateApiKey();
  db.prepare('INSERT INTO api_keys (user_id, name, key_hash, scopes) VALUES (?,?,?,?)').run(
    uid,
    '只读',
    hashApiKey(key),
    JSON.stringify(['case:read']),
  );
  return key;
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-probe-watch-${crypto.randomUUID()}.db`);

  probe = (await import('../probe/route')).POST;
  watch = (await import('../../cases/[id]/watch/route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  db.prepare('DELETE FROM company_watches').run();
  db.prepare('DELETE FROM company_probe_events').run();
  db.prepare('DELETE FROM company_probe_cache').run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM cases').run();
  db.prepare('DELETE FROM users').run();
  const insertUser = db.prepare('INSERT INTO users (phone_hash) VALUES (?)');
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  userB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);
  caseA = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(userA, '甲的案件')
      .lastInsertRowid,
  );
});

describe('POST /company/probe · 免费探测', () => {
  test('采集器不在场时如实降级：有 reason、没有 payload、不占配额', async () => {
    const res = await probe(
      post('/api/v1/company/probe', { name: '北京甲科技有限公司' }, signToken(userA)),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { probe: Record<string, unknown> };
    expect(json.probe.status).toBe('no_collector');
    // 空壳 payload 会被读成「查无此公司」——没有就是没有，不给一个全 0 的顶上
    expect(json.probe.payload).toBeUndefined();
    expect(String(json.probe.reason)).toContain('这一刻没去查');
    const used = db.prepare('SELECT COUNT(*) AS n FROM company_probe_events').get() as { n: number };
    expect(used.n).toBe(0);
  });

  test('缓存命中：出四个数、不占配额、不限次', async () => {
    const payload = {
      entity_matched: true,
      entity_name: '北京甲科技有限公司',
      uscc: null,
      gs_status: '存续',
      relation_count: 6,
      litigation_count: 23,
      labor_count: 14,
      doc_url_count: 9,
      as_of: '2026-08-28',
    };
    const { companyKey } = await import('@/lib/company/normalize');
    db.prepare(
      "INSERT INTO company_probe_cache (company_key, payload_json, fetched_at) VALUES (?,?,datetime('now'))",
    ).run(companyKey({ name: '北京甲科技有限公司' }), JSON.stringify(payload));

    for (let i = 0; i < 3; i++) {
      const res = await probe(
        post('/api/v1/company/probe', { name: '北京甲科技有限公司' }, signToken(userA)),
      );
      const json = (await res.json()) as { probe: { status: string; payload: typeof payload } };
      expect(json.probe.status).toBe('hit');
      expect(json.probe.payload.doc_url_count).toBe(9);
    }
    const used = db.prepare('SELECT COUNT(*) AS n FROM company_probe_events').get() as { n: number };
    expect(used.n).toBe(0);
  });

  test('公司名与代码都空 ⇒ 400，且说得出怎么办', async () => {
    const res = await probe(post('/api/v1/company/probe', { name: '   ' }, signToken(userA)));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error_code: string; message: string };
    expect(json.error_code).toBe('COMPANY_NAME_EMPTY');
    expect(json.message).toContain('公司全称');
  });

  test('没凭据 ⇒ 401（探测免费但不匿名，配额按用户算）', async () => {
    const res = await probe(
      new Request('http://localhost/api/v1/company/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '甲' }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /cases/:id/watch · 一键加守望', () => {
  test('建一条活跃盯梢，回的档位与月费对得上价目表', async () => {
    const res = await watch(
      post(`/api/v1/cases/${caseA}/watch`, { name: '甲科技有限公司', tier: 'weekly' }, signToken(userA)),
      ctx(caseA),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      watch: { created: boolean; tier: string; monthly_gongdao: number };
    };
    expect(json.watch.created).toBe(true);
    expect(json.watch.tier).toBe('weekly');
    expect(json.watch.monthly_gongdao).toBe(WATCH_TIER_GONGDAO.weekly);
  });

  test('连点去重：第二次不新建，且回的是**库里那条**的档位，不是这次请求的档位', async () => {
    await watch(
      post(`/api/v1/cases/${caseA}/watch`, { name: '甲科技有限公司', tier: 'daily' }, signToken(userA)),
      ctx(caseA),
    );
    const again = await watch(
      post(`/api/v1/cases/${caseA}/watch`, { name: '甲科技有限公司', tier: 'archive' }, signToken(userA)),
      ctx(caseA),
    );
    const json = (await again.json()) as { watch: { created: boolean; tier: string } };
    expect(json.watch.created).toBe(false);
    // 请求里写的是 archive（0），库里那条仍是 daily（199）——回显请求档位就是报了个假价
    expect(json.watch.tier).toBe('daily');

    const rows = db.prepare('SELECT COUNT(*) AS n FROM company_watches').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  test('只读凭据触发不了加守望（它会让下个月产生一笔月费）', async () => {
    const res = await watch(
      post(`/api/v1/cases/${caseA}/watch`, { name: '甲科技有限公司' }, readOnlyKey(userA)),
      ctx(caseA),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('FORBIDDEN_SCOPE');
  });

  test('别人的案件与不存在的案件返回同一个 404', async () => {
    const others = await watch(
      post(`/api/v1/cases/${caseA}/watch`, { name: '甲科技有限公司' }, signToken(userB)),
      ctx(caseA),
    );
    const ghost = await watch(
      post('/api/v1/cases/999999/watch', { name: '甲科技有限公司' }, signToken(userA)),
      ctx(999999),
    );
    expect(others.status).toBe(404);
    expect(ghost.status).toBe(404);
    expect((await others.json()).error_code).toBe((await ghost.json()).error_code);
  });

  test('未知档 ⇒ 400，不静默落到默认的每日档', async () => {
    const res = await watch(
      post(`/api/v1/cases/${caseA}/watch`, { name: '甲科技有限公司', tier: '每周' }, signToken(userA)),
      ctx(caseA),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_WATCH_TIER');
    const rows = db.prepare('SELECT COUNT(*) AS n FROM company_watches').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test('主体名字为空 ⇒ 400（没有名字就去不了重，同一家会被重复建、重复收费）', async () => {
    const res = await watch(
      post(`/api/v1/cases/${caseA}/watch`, { name: '  ' }, signToken(userA)),
      ctx(caseA),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('WATCH_NAME_EMPTY');
  });
});
