// app/src/app/api/v1/company/dossiers/__tests__/route.test.ts
// 三条端点的对外行为。要害：
//   · 报价端点**打过去不会扣钱**（这条在路由层再验一遍——lib 层对了而路由多调一次 confirm，
//     照样是「报个价就被扣了」，两层各验各的）
//   · 确认端点要 case:write（只读 key 触发不了扣费）
//   · 入参不合法一律报错，不静默按默认值报价/下单（按默认值下单＝扣走用户没打算买的钱）
//   · 不属于自己的档案与不存在的档案返回同一个 404（否则成了「这家公司有没有人建过档」的探针）
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';
import { PRICE_FALLBACK } from '@/lib/billing/pricing-config';
import { ENTITLEMENT_KIND } from '@/lib/billing/entitlements';
import { DOSSIER_MODULES } from '@/lib/company/dossier-billing';

type Handler = (req: Request) => Promise<Response>;
type IdHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const VENUE = PRICE_FALLBACK['dossier.venue'];
const ENTITY = PRICE_FALLBACK['dossier.entity'];
const GRAPH = PRICE_FALLBACK['dossier.graph'];
const DOCS_LIST = PRICE_FALLBACK['dossier.docs_list'];
const CORE_TOTAL = VENUE + ENTITY + GRAPH + DOCS_LIST;

/** 篇数恰好压在可售门槛上——低于它深度两项直接不卖（409），全套请求都用它。 */
const DOCS = PRICE_FALLBACK['dossier.min_docurl_to_sell'];
const DOCS_STATS = DOCS * PRICE_FALLBACK['dossier.docs_stats_per_doc'];
const PATTERNS = PRICE_FALLBACK['dossier.patterns_base']; // 篇数 < base_docs，取起价
const FULL = CORE_TOTAL + DOCS_STATS + PATTERNS;

let quote: Handler;
let confirm: Handler;
let detail: IdHandler;
let db: Database;
let userA: number;
let userB: number;

/** 报价与确认**逐字同形**的请求体：同一个对象打两个端点，两边字段不同名会让报的价与买的东西错位。 */
const body = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  doc_count: DOCS,
  ...extra,
});

function post(url: string, payload: unknown, auth: string): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
    body: JSON.stringify(payload),
  });
}

function get(url: string, auth: string): Request {
  return new Request(`http://localhost${url}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${auth}` },
  });
}

/** 发一把只带 case:read 的 api key，用来验扣费端点的 scope 闸门。 */
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

function balance(uid: number): number {
  const row = db.prepare('SELECT balance FROM gongdao WHERE user_id=?').get(uid) as
    | { balance: number }
    | undefined;
  return row?.balance ?? 0;
}

function ledgerRows(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM gongdao_ledger').get() as { n: number }).n;
}

function dossierRows(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM company_dossiers').get() as { n: number }).n;
}

function topUp(uid: number, amount: number): void {
  db.prepare("INSERT INTO gongdao_ledger (user_id, delta, type, ref_id) VALUES (?,?,'充值',?)").run(
    uid,
    amount,
    `top-${uid}-${crypto.randomUUID()}`,
  );
  db.prepare(
    'INSERT INTO gongdao (user_id, balance) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + ?',
  ).run(uid, amount, amount);
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-dossier-${crypto.randomUUID()}.db`);

  quote = (await import('../quote/route')).POST;
  confirm = (await import('../confirm/route')).POST;
  detail = (await import('../[id]/route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  db.prepare('DELETE FROM company_dossiers').run();
  db.prepare('DELETE FROM entitlements').run();
  db.prepare('DELETE FROM gongdao_ledger').run();
  db.prepare('DELETE FROM gongdao').run();
  db.prepare('DELETE FROM pricing_config').run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM users').run();
  const insertUser = db.prepare('INSERT INTO users (phone_hash) VALUES (?)');
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  userB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);
});

describe('POST /quote · 报价不动钱', () => {
  test('打三次报价，余额、流水行数与档案行数逐字不变', async () => {
    topUp(userA, 5000);
    const before = { balance: balance(userA), rows: ledgerRows(), dossiers: dossierRows() };
    for (let i = 0; i < 3; i++) {
      const res = await quote(
        post('/api/v1/company/dossiers/quote', body('北京甲科技有限公司'), signToken(userA)),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).quote.total).toBe(FULL);
    }
    expect({ balance: balance(userA), rows: ledgerRows(), dossiers: dossierRows() }).toEqual(before);
  });

  test('未登录 401', async () => {
    const res = await quote(
      new Request('http://localhost/api/v1/company/dossiers/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body('甲')),
      }),
    );
    expect(res.status).toBe(401);
  });

  test('modules 含未知值 → 400，不静默过滤成合法子集', async () => {
    const res = await quote(
      post('/api/v1/company/dossiers/quote', body('甲', { modules: ['graph', 'graphs'] }), signToken(userA)),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_MODULES');
  });

  test('modules 为空数组 → 400（省略才是「全都要」，空数组是前端算错了）', async () => {
    const res = await quote(
      post('/api/v1/company/dossiers/quote', body('甲', { modules: [] }), signToken(userA)),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_MODULES');
  });

  test('modules 省略 = 六块都报；给两块就只报两块', async () => {
    const all = await (
      await quote(post('/api/v1/company/dossiers/quote', body('甲'), signToken(userA)))
    ).json();
    const two = await (
      await quote(
        post('/api/v1/company/dossiers/quote', body('甲', { modules: ['entity', 'graph'] }), signToken(userA)),
      )
    ).json();
    expect(all.quote.items).toHaveLength(DOSSIER_MODULES.length);
    expect(all.quote.total).toBe(FULL);
    expect(two.quote.items.map((i: { module: string }) => i.module)).toEqual(['entity', 'graph']);
    expect(two.quote.total).toBe(ENTITY + GRAPH);
  });

  test.each([
    ['负数', -1],
    ['小数', 1.5],
    ['字符串', '5'],
  ])('doc_count 是%s → 400（不静默 clamp 成 0，那会报一个用户没预期的价）', async (_label, value) => {
    const res = await quote(
      post('/api/v1/company/dossiers/quote', { name: '甲', doc_count: value }, signToken(userA)),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_DOC_COUNT');
  });

  test('doc_count 省略 → 按 0 篇算：深度两项不可售，只买核心照常出价', async () => {
    const blocked = await quote(
      post('/api/v1/company/dossiers/quote', { name: '甲' }, signToken(userA)),
    );
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error_code).toBe('DOSSIER_DOCS_BELOW_SELL_FLOOR');

    const core = await quote(
      post('/api/v1/company/dossiers/quote', { name: '甲', modules: ['venue', 'entity', 'graph', 'docs_list'] }, signToken(userA)),
    );
    expect(core.status).toBe(200);
    expect((await core.json()).quote.total).toBe(CORE_TOTAL);
  });

  test('公司名归一化后为空 → 400，一条档案都不落', async () => {
    const res = await quote(post('/api/v1/company/dossiers/quote', body('  　 '), signToken(userA)));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('COMPANY_NAME_EMPTY');
    expect(dossierRows()).toBe(0);
  });

  test('改 pricing_config 一行，下一次报价立刻变（同一进程，无需重启）', async () => {
    const before = await (
      await quote(post('/api/v1/company/dossiers/quote', body('甲'), signToken(userA)))
    ).json();
    expect(before.quote.total).toBe(FULL);

    db.prepare('INSERT INTO pricing_config (key, value_int) VALUES (?,?)').run('dossier.graph', 999);
    const after = await (
      await quote(post('/api/v1/company/dossiers/quote', body('甲'), signToken(userA)))
    ).json();
    expect(after.quote.total).toBe(FULL - GRAPH + 999);
  });
});

describe('POST /confirm · 扣费端点', () => {
  test('只读 key 触发不了扣费（403），余额不动', async () => {
    topUp(userA, 5000);
    const res = await confirm(
      post('/api/v1/company/dossiers/confirm', body('甲'), readOnlyKey(userA)),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('FORBIDDEN_SCOPE');
    expect(balance(userA)).toBe(5000);
    expect(dossierRows()).toBe(0);
  });

  test('余额够 → 200、扣满额、建一条档', async () => {
    topUp(userA, FULL);
    const res = await confirm(
      post('/api/v1/company/dossiers/confirm', body('北京甲科技有限公司'), signToken(userA)),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.paid_by).toBe('gongdao');
    expect(json.charged).toBe(FULL);
    expect(balance(userA)).toBe(0);
    expect(dossierRows()).toBe(1);
  });

  test('响应里带下单时点的报价快照（前端拿它对账，不必再打一次报价）', async () => {
    topUp(userA, FULL);
    const json = await (
      await confirm(post('/api/v1/company/dossiers/confirm', body('甲'), signToken(userA)))
    ).json();
    expect(json.quote.total).toBe(FULL);
    expect(json.quote.items).toHaveLength(DOSSIER_MODULES.length);
  });

  test('余额差 1 → 402 且一条档案都不建', async () => {
    topUp(userA, FULL - 1);
    const res = await confirm(post('/api/v1/company/dossiers/confirm', body('甲'), signToken(userA)));
    expect(res.status).toBe(402);
    expect((await res.json()).error_code).toBe('GONGDAO_INSUFFICIENT');
    expect(dossierRows()).toBe(0);
  });

  test('入参不合法在扣费之前就拦下（400，余额与档案都不动）', async () => {
    topUp(userA, 100_000);
    const res = await confirm(
      post('/api/v1/company/dossiers/confirm', body('甲', { modules: ['nope'] }), signToken(userA)),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_MODULES');
    expect(balance(userA)).toBe(100_000);
    expect(dossierRows()).toBe(0);
  });

  test('重复确认只扣一次', async () => {
    topUp(userA, 100_000);
    const first = await (
      await confirm(post('/api/v1/company/dossiers/confirm', body('甲'), signToken(userA)))
    ).json();
    const after = balance(userA);
    const second = await (
      await confirm(post('/api/v1/company/dossiers/confirm', body('甲'), signToken(userA)))
    ).json();
    expect(second.dossier_id).toBe(first.dossier_id);
    expect(second.charged).toBe(0);
    expect(second.paid_by).toBe('none');
    expect(balance(userA)).toBe(after);
    expect(dossierRows()).toBe(1);
  });

  test('有赠送券 → 核心四项不扣钱，响应写明 paid_by 与券 id；深度两项照扣', async () => {
    topUp(userA, 100_000);
    db.prepare('INSERT INTO entitlements (user_id, kind, source_ref) VALUES (?,?,?)').run(
      userA,
      ENTITLEMENT_KIND.dossierCore,
      'ORD-1',
    );
    const json = await (
      await confirm(post('/api/v1/company/dossiers/confirm', body('甲'), signToken(userA)))
    ).json();
    expect(json.paid_by).toBe('membership_credit');
    expect(json.charged).toBe(DOCS_STATS + PATTERNS);
    expect(json.entitlement_id).toBeGreaterThan(0);
    expect(balance(userA)).toBe(100_000 - DOCS_STATS - PATTERNS);
  });

  test('领域层的可售门槛在路由上原样透出（409，不被翻成 500 或静默降级）', async () => {
    topUp(userA, 100_000);
    const res = await confirm(
      post('/api/v1/company/dossiers/confirm', { name: '甲', doc_count: DOCS - 1 }, signToken(userA)),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error_code).toBe('DOSSIER_DOCS_BELOW_SELL_FLOOR');
    expect(balance(userA)).toBe(100_000);
  });

  test('报价与确认吃同一个请求体：报出来多少，就扣多少', async () => {
    topUp(userA, 100_000);
    const payload = body('北京甲科技有限公司', { modules: ['entity', 'graph'] });
    const quoted = await (
      await quote(post('/api/v1/company/dossiers/quote', payload, signToken(userA)))
    ).json();
    const confirmed = await (
      await confirm(post('/api/v1/company/dossiers/confirm', payload, signToken(userA)))
    ).json();
    expect(confirmed.charged).toBe(quoted.quote.total);
  });
});

describe('GET /{id} · 计费实况', () => {
  async function buy(uid: number): Promise<number> {
    topUp(uid, 100_000);
    const json = await (
      await confirm(post('/api/v1/company/dossiers/confirm', body('北京甲科技有限公司'), signToken(uid)))
    ).json();
    return json.dossier_id;
  }

  test('买过的人看得到逐模块实扣', async () => {
    const id = await buy(userA);
    const res = await detail(get(`/api/v1/company/dossiers/${id}`, signToken(userA)), {
      params: Promise.resolve({ id: String(id) }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.dossier.id).toBe(id);
    expect(json.billing.modules.map((b: { module: string; charged: number }) => [b.module, b.charged])).toEqual([
      ['venue', VENUE],
      ['entity', ENTITY],
      ['graph', GRAPH],
      ['docs_list', DOCS_LIST],
      ['docs_stats', DOCS_STATS],
      ['patterns', PATTERNS],
    ]);
    expect(json.billing.net_gongdao).toBe(FULL);
    expect(json.billing.paid_by_membership_credit).toBe(false);
  });

  test('别人的档案与不存在的档案返回同一个 404（不做「有没有人建过档」的探针）', async () => {
    const id = await buy(userA);
    const foreign = await detail(get(`/api/v1/company/dossiers/${id}`, signToken(userB)), {
      params: Promise.resolve({ id: String(id) }),
    });
    const missing = await detail(get('/api/v1/company/dossiers/99999', signToken(userB)), {
      params: Promise.resolve({ id: '99999' }),
    });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  test('非法 id 也走同一个 404', async () => {
    const res = await detail(get('/api/v1/company/dossiers/abc', signToken(userA)), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error_code).toBe('DOSSIER_NOT_FOUND');
  });

  test('未登录 401（先认人再谈找不找得到）', async () => {
    const id = await buy(userA);
    const res = await detail(
      new Request(`http://localhost/api/v1/company/dossiers/${id}`, { method: 'GET' }),
      { params: Promise.resolve({ id: String(id) }) },
    );
    expect(res.status).toBe(401);
  });

  test('本响应不含采集进度字段（宁可缺一个字段，也不给一个永远停在 queued 的假进度）', async () => {
    const id = await buy(userA);
    const json = await (
      await detail(get(`/api/v1/company/dossiers/${id}`, signToken(userA)), {
        params: Promise.resolve({ id: String(id) }),
      })
    ).json();
    expect(Object.keys(json.billing).sort()).toEqual(
      ['modules', 'net_gongdao', 'paid_by_membership_credit'].sort(),
    );
    expect(json.billing.modules[0]).not.toHaveProperty('progress');
  });
});
