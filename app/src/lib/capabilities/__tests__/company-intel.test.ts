/**
 * 对方主体情报六条能力的判据（设计稿 §2 H）。走的是能力的 `run(db, identity, args)`——
 * 与 /api/mcp 的 tools/call 调的是同一个函数，所以这里验到的就是用户的 agent 真正拿到的行为。
 *
 * 【判据 ↔ 变异臂】
 *  1) 归属红线：换一把别人的钥匙，四条隶属案件的工具一条都读不到、写不进，且库里行数纹丝不动
 *     «某一条漏判归属 ⇒ 红»（逐条调一遍，不抽查）。dossier_confirm 的对应形态是「别人的报价号」。
 *  2) 报价绝不动钱：quote 前后余额、账本行数、档案行数逐字相等，报价单 confirmed_at 为空
 *     «报价顺手建了档 / 顺手占了额 ⇒ 红»。
 *  3) 确认幂等：同一张报价确认两次，第二次 deduped=true、charged=0，账本不多一行
 *     «把 `AND confirmed_at IS NULL` 抢占去掉 ⇒ 红»——去掉之后第二次会当成一次新确认，
 *     钱虽然被账本的唯一索引兜住了，回给用户的话却变成「刚给你买好了」。
 *  4) 余额不足：402 且**整笔回滚**——不建档、不扣钱，且那张报价的 confirmed_at 被退回空，
 *     用户充完值能拿同一张报价再确认 «抢占标记留在库里 ⇒ 红»。
 *  5) 深度两块的篇数只认服务端探测缓存：没有新鲜探测就报不出价（不静默按 0 篇算），
 *     有了探测按缓存里的篇数计价 «改成收调用方传的篇数 ⇒ 报小篇数就能压价，本条红»。
 *  6) 守望连点：第二次命中同一条、**不改档位**，回包 tier 是库里真正生效的那一档
 *     «回显请求里的 tier ⇒ 红»。
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Identity } from '@/lib/auth/identity';
import { getGongdao, gongdaoGrant } from '@/lib/billing/index';
import { GONGDAO_LEDGER_TYPE, WATCH_TIER_GONGDAO } from '@/lib/billing/pricing';
import { PRICE_FALLBACK } from '@/lib/billing/pricing-config';
import { upsertProbeCache } from '@/lib/company/probe';
import { runMigrations } from '@/lib/db/migrate';

import { getCapability } from '..';

const CORE = ['venue', 'entity', 'graph', 'docs_list'];
const CORE_TOTAL =
  PRICE_FALLBACK['dossier.venue'] +
  PRICE_FALLBACK['dossier.entity'] +
  PRICE_FALLBACK['dossier.graph'] +
  PRICE_FALLBACK['dossier.docs_list'];
const SELL_FLOOR = PRICE_FALLBACK['dossier.min_docurl_to_sell'];
const NAME = '某某科技有限公司';

let db: Database.Database;
let alice: Identity;
let bob: Identity;
let caseA: number;

type Payload = Record<string, unknown>;

function call(name: string, identity: Identity, args: Record<string, unknown>): Payload {
  const cap = getCapability(name);
  if (!cap) throw new Error(`注册表里没有 ${name}`);
  return cap.run(db, identity, args) as Payload;
}

async function callAsync(name: string, identity: Identity, args: Record<string, unknown>): Promise<Payload> {
  const cap = getCapability(name);
  if (!cap) throw new Error(`注册表里没有 ${name}`);
  return (await cap.run(db, identity, args)) as Payload;
}

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function addUser(hash: string): number {
  return Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run(hash).lastInsertRowid);
}

function addKey(userId: number, hash: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO api_keys (user_id, name, key_hash, scopes) VALUES (?, '测试钥匙', ?, '[\"case:read\",\"case:write\"]')",
      )
      .run(userId, hash).lastInsertRowid,
  );
}

/** 探测缓存里放一份「有 n 篇可计费文书」的载荷（company_probe 真跑一次也是写到这里）。 */
function seedProbe(docs: number): void {
  upsertProbeCache(db, `name:${NAME}`, {
    entity_matched: true,
    entity_name: NAME,
    uscc: null,
    gs_status: '存续',
    relation_count: 2,
    litigation_count: docs + 3,
    labor_count: docs + 1,
    doc_url_count: docs,
    as_of: '2026-09-01',
  });
}

function quote(identity: Identity, blocks: string[], caseId = caseA): Payload {
  return call('dossier_quote', identity, { case_id: caseId, name: NAME, blocks });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uidA = addUser('hash-a');
  const uidB = addUser('hash-b');
  alice = { uid: uidA, via: 'api_key', scopes: ['case:read', 'case:write'], keyId: addKey(uidA, 'kh-a') };
  bob = { uid: uidB, via: 'api_key', scopes: ['case:read', 'case:write'], keyId: addKey(uidB, 'kh-b') };
  caseA = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uidA, '甲的案子').lastInsertRowid,
  );
  gongdaoGrant(uidA, 5000, GONGDAO_LEDGER_TYPE.admin, 'seed-a', null, db);
});

describe('六条能力都在注册表里，且元数据说的和它做的是同一件事', () => {
  it('六条齐全，读的是 case:read、花钱那条是 spend + 余额前置', () => {
    for (const name of [
      'company_probe',
      'dossier_quote',
      'dossier_confirm',
      'dossier_get',
      'company_graph_get',
      'company_watch_set',
    ]) {
      expect(getCapability(name), name).toBeDefined();
    }
    expect(getCapability('dossier_quote')!.kind).toBe('read');
    expect(getCapability('dossier_confirm')!.kind).toBe('spend');
    expect(getCapability('dossier_confirm')!.precondition).toContain('balance');
    // 守望这一次调用不扣钱（月费在月度巡检里收），所以它是 write 不是 spend——
    // 标成 spend 会让调用方以为这一下就扣了钱。
    expect(getCapability('company_watch_set')!.kind).toBe('write');
  });
});

describe('归属红线：换一把别人的钥匙，一条都读不到写不进', () => {
  it('四条隶属案件的工具全回 CASE_NOT_FOUND，且库里一行都没多', async () => {
    const before = [count('service_quotes'), count('company_watches'), count('company_dossiers')];

    for (const [name, args] of [
      ['dossier_quote', { case_id: caseA, name: NAME, blocks: CORE }],
      ['dossier_get', { case_id: caseA }],
      ['company_graph_get', { case_id: caseA }],
      ['company_watch_set', { case_id: caseA, name: NAME, tier: 'daily' }],
    ] as const) {
      const res = call(name, bob, args as Record<string, unknown>);
      expect(res.ok, name).toBe(false);
      expect(res.errorCode, name).toBe('CASE_NOT_FOUND');
      expect(res.status, name).toBe(404);
      // 泄漏检查：错误里不许带出案件标题这类只有本人该看到的东西
      expect(JSON.stringify(res)).not.toContain('甲的案子');
    }
    expect([count('service_quotes'), count('company_watches'), count('company_dossiers')]).toEqual(before);
  });

  it('dossier_confirm 拿别人的报价号 → QUOTE_NOT_FOUND，且那张单没被确认', () => {
    const q = quote(alice, CORE);
    const quoteId = (q.quote as Payload).quote_id as number;

    const res = call('dossier_confirm', bob, { quote_id: quoteId });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('QUOTE_NOT_FOUND');
    expect(res.status).toBe(404);
    const row = db.prepare('SELECT confirmed_at FROM service_quotes WHERE id=?').get(quoteId) as {
      confirmed_at: string | null;
    };
    expect(row.confirmed_at).toBeNull();
    expect(count('gongdao_ledger')).toBe(1); // 只有 beforeEach 那笔入账
  });
});

describe('报价绝不动钱', () => {
  it('quote 前后余额、账本行数、档案行数逐字相等，报价单是未确认态', () => {
    const before = {
      balance: getGongdao(alice.uid, db),
      ledger: count('gongdao_ledger'),
      dossiers: count('company_dossiers'),
    };

    const res = quote(alice, CORE);
    expect(res.ok).toBe(true);
    const q = res.quote as Payload;
    expect(q.quote_id).toBeGreaterThan(0);
    expect(typeof q.expires_at).toBe('string');
    expect(q.payable_gongdao).toBe(CORE_TOTAL);
    expect((q.blocks as Payload[]).map((b) => b.block)).toEqual(CORE);
    // 回包字段一律下划线（对外契约），不许漏出仓内 camelCase
    for (const k of Object.keys(q)) expect(k, k).not.toMatch(/[A-Z]/);

    expect({
      balance: getGongdao(alice.uid, db),
      ledger: count('gongdao_ledger'),
      dossiers: count('company_dossiers'),
    }).toEqual(before);
    const row = db.prepare('SELECT service, confirmed_at FROM service_quotes WHERE id=?').get(q.quote_id) as {
      service: string;
      confirmed_at: string | null;
    };
    expect(row).toEqual({ service: 'dossier', confirmed_at: null });
  });
});

describe('确认扣费与幂等', () => {
  it('第一次真扣、第二次判重放：deduped=true、charged=0、账本不多一行', () => {
    const q = quote(alice, CORE).quote as Payload;
    const quoteId = q.quote_id as number;

    const first = call('dossier_confirm', alice, { quote_id: quoteId });
    expect(first.ok).toBe(true);
    expect(first.deduped).toBe(false);
    expect(first.charged).toBe(CORE_TOTAL);
    expect(first.dossier_id).toBeGreaterThan(0);
    const balanceAfter = getGongdao(alice.uid, db);
    const ledgerAfter = count('gongdao_ledger');
    expect(balanceAfter).toBe(5000 - CORE_TOTAL);

    const second = call('dossier_confirm', alice, { quote_id: quoteId });
    expect(second.ok).toBe(true);
    // 【变异臂】把抢占那句的 `AND confirmed_at IS NULL` 去掉，这里会变成 false
    expect(second.deduped).toBe(true);
    expect(second.charged).toBe(0);
    expect(second.dossier_id).toBe(first.dossier_id);
    expect(String(second.note)).toContain('已经确认过');
    expect(getGongdao(alice.uid, db)).toBe(balanceAfter);
    expect(count('gongdao_ledger')).toBe(ledgerAfter);
    expect(count('company_dossiers')).toBe(1);
  });

  it('余额不足 → 402，且不建档、不扣钱、报价单退回未确认（充值后能拿同一张再确认）', () => {
    const poor = addUser('hash-c');
    const key = addKey(poor, 'kh-c');
    const carol: Identity = { uid: poor, via: 'api_key', scopes: ['case:read', 'case:write'], keyId: key };
    const caseC = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(poor, '丙的案子').lastInsertRowid,
    );
    gongdaoGrant(poor, 10, GONGDAO_LEDGER_TYPE.admin, 'seed-c', null, db);

    const q = quote(carol, CORE, caseC).quote as Payload;
    expect(q.shortfall).toBe(CORE_TOTAL - 10);

    const res = call('dossier_confirm', carol, { quote_id: q.quote_id });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(402);
    expect(count('company_dossiers')).toBe(0);
    expect(getGongdao(poor, db)).toBe(10);
    const row = db.prepare('SELECT confirmed_at FROM service_quotes WHERE id=?').get(q.quote_id) as {
      confirmed_at: string | null;
    };
    expect(row.confirmed_at).toBeNull();

    // 充值后同一张报价仍然可用（整笔回滚才成立的事）
    gongdaoGrant(poor, 5000, GONGDAO_LEDGER_TYPE.recharge, 'topup-c', null, db);
    const retry = call('dossier_confirm', carol, { quote_id: q.quote_id });
    expect(retry.ok).toBe(true);
    expect(retry.charged).toBe(CORE_TOTAL);
  });
});

describe('深度两块的篇数只认服务端探测缓存', () => {
  it('没有新鲜探测 → 报不出价（DOSSIER_PROBE_REQUIRED），核心四块照报', () => {
    const deep = quote(alice, [...CORE, 'docs_stats']);
    expect(deep.ok).toBe(false);
    expect(deep.errorCode).toBe('DOSSIER_PROBE_REQUIRED');
    expect(String(deep.message)).toContain('company_probe');
    expect(quote(alice, CORE).ok).toBe(true);
  });

  it('探测缓存里有多少篇就按多少篇计价（工具入参里根本没有「篇数」这个字段）', () => {
    seedProbe(SELL_FLOOR);
    const res = quote(alice, [...CORE, 'docs_stats']);
    expect(res.ok).toBe(true);
    const q = res.quote as Payload;
    expect(q.billable_docs).toBe(SELL_FLOOR);
    const stats = (q.blocks as Payload[]).find((b) => b.block === 'docs_stats')!;
    expect(stats.gongdao).toBe(SELL_FLOOR * PRICE_FALLBACK['dossier.docs_stats_per_doc']);
    // 报小篇数压价这条路根本不存在：schema 里没有这个入参……
    const schema = getCapability('dossier_quote')!.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toEqual(['case_id', 'name', 'uscc', 'blocks']);
    // ……而且**硬塞一个也不管用**（只查 schema 挡不住"没声明却照收"的实现）。
    // 一大一小各塞一次：价钱必须与不塞时逐字相同。
    for (const hack of [1, 9999]) {
      const forged = call('dossier_quote', alice, {
        case_id: caseA,
        name: NAME,
        blocks: [...CORE, 'docs_stats'],
        doc_count: hack,
      });
      const fq = forged.quote as Payload;
      expect(fq.billable_docs, `doc_count=${hack}`).toBe(SELL_FLOOR);
      expect((fq.blocks as Payload[]).find((b) => b.block === 'docs_stats')!.gongdao).toBe(stats.gongdao);
    }
  });

  it('blocks 写了不认识的块名 → 400，不静默过滤成一个用户没选过的单', () => {
    const res = call('dossier_quote', alice, { case_id: caseA, name: NAME, blocks: ['graph', 'graphs'] });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_BLOCKS');
    expect(count('service_quotes')).toBe(0);
  });
});

describe('免费探测与读档', () => {
  it('company_probe 不扣钱、不建档；采集器缺席时如实降级，不拿空结果冒充查无此公司', async () => {
    const res = await callAsync('company_probe', alice, { name: NAME });
    expect(res.ok).toBe(true);
    const probe = res.probe as Payload;
    expect(probe.status).toBe('no_collector');
    expect(String(probe.reason)).toBeTruthy();
    expect(probe.payload).toBeUndefined();
    expect(count('gongdao_ledger')).toBe(1);
    expect(count('company_dossiers')).toBe(0);
  });

  it('company_probe 名字为空 → COMPANY_NAME_EMPTY（三段式说明），不是一个空结果', async () => {
    const res = await callAsync('company_probe', alice, { name: '   ' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('COMPANY_NAME_EMPTY');
  });

  it('dossier_get 还没建过档 → status=none（不是错误）；company_graph_get 无主体 → graph=null', () => {
    const d = call('dossier_get', alice, { case_id: caseA });
    expect(d.ok).toBe(true);
    expect(d.status).toBe('none');
    expect(d.dossier).toBeNull();

    const g = call('company_graph_get', alice, { case_id: caseA });
    expect(g.ok).toBe(true);
    expect(g.graph).toBeNull();
  });
});

describe('守望：连点去重、不改档位、不扣钱', () => {
  it('第二次命中同一条，tier 仍是库里生效的那一档，回包月费照它算', () => {
    const first = call('company_watch_set', alice, { case_id: caseA, name: NAME, tier: 'daily' });
    expect(first.ok).toBe(true);
    const w1 = first.watch as Payload;
    expect(w1.created).toBe(true);
    expect(w1.tier).toBe('daily');
    expect(w1.monthly_gongdao).toBe(WATCH_TIER_GONGDAO.daily);

    const second = call('company_watch_set', alice, { case_id: caseA, name: NAME, tier: 'weekly' });
    const w2 = second.watch as Payload;
    expect(w2.id).toBe(w1.id);
    expect(w2.created).toBe(false);
    // 【变异臂】改成回显请求里的 tier，这里会读到 'weekly'，而库里那条仍是每日档
    expect(w2.tier).toBe('daily');
    expect(w2.monthly_gongdao).toBe(WATCH_TIER_GONGDAO.daily);
    expect(count('company_watches')).toBe(1);
    // 这一步不扣钱：月费在月度巡检里收
    expect(getGongdao(alice.uid, db)).toBe(5000);
  });

  it('认不出的档位 → 400，不静默按最勤那档建', () => {
    const res = call('company_watch_set', alice, { case_id: caseA, name: NAME, tier: 'hourly' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_WATCH_TIER');
    expect(count('company_watches')).toBe(0);
  });
});
