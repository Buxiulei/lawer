// app/src/lib/company/__tests__/refund.test.ts
// 分模块退款 = 数据诚实红线绑到钱上的那一环。要害：
//   · 三条红线各自绑退款：M3 高置信边不足 / M5 样本不足或超 SLA / M6 保留条目不足（含全被丢=0）
//   · 只退该退的那一块，别的模块的钱一分不动
//   · 退实付额（账本是唯一事实源），中途调价也不会退错
//   · 重放只退一次（巡检 job 每轮无脑调用是安全的）
//   · 券付/免费的模块没有钱可退，也不该凭空退出钱来
//
// 门槛是**判据**不是文案：每条阈值测试都配一根「差一点就触发 / 恰好达标不触发」的边界，
// 少了这根，把门槛从 5 改成 0 也照样全绿。
import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../db/migrate';
import { getGongdao, gongdaoGrant } from '../../billing/index';
import { GONGDAO_LEDGER_TYPE } from '../../billing/pricing';
import { PRICE_FALLBACK } from '../../billing/pricing-config';
import { ENTITLEMENT_KIND, grantEntitlement } from '../../billing/entitlements';
import {
  DOSSIER_MODULE_FEATURE,
  confirmDossier,
  dossierChargeRef,
  getDossierBillingView,
  type DossierModule,
  type DossierOrderInput,
} from '../dossier-billing';
import {
  DOSSIER_REFUND_REASON_TEXT,
  listModuleCharges,
  refundDocsStatsIfSampleShort,
  refundDocsStatsSlaExpired,
  refundDossierModule,
  refundGraphIfLowConfidence,
  refundNote,
  refundPatternsIfKeptShort,
} from '../refund';

const GRAPH = PRICE_FALLBACK['dossier.graph'];
const ENTITY = PRICE_FALLBACK['dossier.entity'];
const PER_DOC = PRICE_FALLBACK['dossier.docs_stats_per_doc'];
const PAT_BASE = PRICE_FALLBACK['dossier.patterns_base'];

const MIN_SAMPLE = PRICE_FALLBACK['dossier.min_sample_outcome'];
const MIN_EDGES = PRICE_FALLBACK['dossier.min_graph_high_conf_edges'];
const MIN_PATTERNS = PRICE_FALLBACK['dossier.min_patterns_kept'];
/** 显式标 number：它是 order() 的默认参数，收窄成字面量类型就只能传这一个值了。 */
const DOCS: number = PRICE_FALLBACK['dossier.min_docurl_to_sell'];

const DOCS_STATS = DOCS * PER_DOC;
const PATTERNS = PAT_BASE; // 篇数 < patterns_base_docs，故为起价

const ALL: DossierModule[] = ['venue', 'entity', 'graph', 'docs_list', 'docs_stats', 'patterns'];

const order = (name: string, modules: DossierModule[] = ALL, docCount = DOCS): DossierOrderInput => ({
  name,
  modules,
  docCount,
});

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('a@t.com').lastInsertRowid);
  const other = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('b@t.com').lastInsertRowid);
  gongdaoGrant(uid, 100_000, GONGDAO_LEDGER_TYPE.recharge, 'top-a', null, db);
  gongdaoGrant(other, 100_000, GONGDAO_LEDGER_TYPE.recharge, 'top-b', null, db);
  return { db, uid, other };
}

function buyAll(db: Database.Database, uid: number, name = '北京甲科技有限公司'): number {
  const r = confirmDossier(db, uid, order(name));
  if (!r.ok) throw new Error(`建档失败：${r.message}`);
  return r.dossierId;
}

function refundRows(db: Database.Database) {
  return db
    .prepare('SELECT delta, feature, ref_id FROM gongdao_ledger WHERE type=? ORDER BY id')
    .all(GONGDAO_LEDGER_TYPE.refund) as { delta: number; feature: string; ref_id: string }[];
}

// ─────────────────── 退一块，只退那一块 ───────────────────

describe('只退该退的那一块', () => {
  test('退 M5：一条退款流水，金额恰为实付、feature 恰为该模块', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    const before = getGongdao(uid, db);

    const result = refundDossierModule(db, id, 'docs_stats', 'sample_insufficient');

    expect(result.totalRefunded).toBe(DOCS_STATS);
    expect(refundRows(db)).toEqual([
      {
        delta: DOCS_STATS,
        feature: DOSSIER_MODULE_FEATURE.docs_stats,
        ref_id: `refund-${dossierChargeRef(id, uid, 'docs_stats')}`,
      },
    ]);
    expect(getGongdao(uid, db)).toBe(before + DOCS_STATS);
  });

  test('退完之后别的五块的钱还在账上（净支出 = 全额 − 这一块）', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    const full = getDossierBillingView(db, id, uid)!.netGongdao;
    refundDossierModule(db, id, 'docs_stats', 'sample_insufficient');

    const view = getDossierBillingView(db, id, uid)!;
    expect(view.netGongdao).toBe(full - DOCS_STATS);
    expect(view.modules.filter((b) => b.refunded > 0).map((b) => b.module)).toEqual(['docs_stats']);
    // 退款不改「买过没有」：退了钱不等于这块没买过，交付明细照留
    expect(view.modules.every((b) => b.paid)).toBe(true);
  });

  test('多位付款人各退各的（档案共享，钱不共享）', () => {
    const { db, uid, other } = makeDb();
    const id = buyAll(db, uid);
    const second = confirmDossier(db, other, order('北京甲科技有限公司', ['docs_stats']));
    if (!second.ok) throw new Error('第二位买家建档失败');

    const result = refundDossierModule(db, id, 'docs_stats', 'sample_insufficient');
    expect(result.lines.map((l) => l.userId).sort()).toEqual([uid, other].sort());
    expect(result.totalRefunded).toBe(DOCS_STATS * 2);
    expect(getGongdao(other, db)).toBe(100_000); // 买了又退，回到原点
  });

  test('退款额取账本实付，不重算价——中途调价也不会退错', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    const before = getGongdao(uid, db);
    // 买完之后把单价改到 1：重算价的实现会退 1×篇数，取账本的实现照退当初实付
    db.prepare('INSERT INTO pricing_config (key, value_int) VALUES (?,?)').run(
      'dossier.docs_stats_per_doc',
      1,
    );

    const result = refundDossierModule(db, id, 'docs_stats', 'sample_insufficient');

    // 三处都钉死：返回值、账本流水金额、余额实际变化。
    // 只断返回值不够——返回值可以由「本该退多少」算出，而账本里躺的是「实际退了多少」，
    // 两者分叉正是退错钱那类事故的样子。
    expect(result.totalRefunded).toBe(DOCS_STATS);
    expect(refundRows(db).map((r) => r.delta)).toEqual([DOCS_STATS]);
    expect(getGongdao(uid, db) - before).toBe(DOCS_STATS);
  });
});

// ─────────────────── 三条红线各自绑退款 ───────────────────

describe('M3 关联谱系 · 高置信关系边不足全额退', () => {
  test(`边数 ${MIN_EDGES} → 达标，返回 null，一分钱不退`, () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    const before = getGongdao(uid, db);
    expect(refundGraphIfLowConfidence(db, id, MIN_EDGES)).toBeNull();
    expect(getGongdao(uid, db)).toBe(before);
    expect(refundRows(db)).toHaveLength(0);
  });

  test(`边数 ${MIN_EDGES - 1}（差一条）→ 触发全额退，且只退谱系块`, () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    const result = refundGraphIfLowConfidence(db, id, MIN_EDGES - 1);
    expect(result).not.toBeNull();
    expect(result!.module).toBe('graph');
    expect(result!.reason).toBe('graph_low_confidence');
    expect(result!.totalRefunded).toBe(GRAPH);
    expect(refundRows(db).map((r) => r.feature)).toEqual([DOSSIER_MODULE_FEATURE.graph]);
  });

  test('一条边都没有（0）→ 照样触发（不是「没数据就不判」）', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    expect(refundGraphIfLowConfidence(db, id, 0)!.totalRefunded).toBe(GRAPH);
  });

  test('门槛读表：把门槛调高，原本达标的边数立刻变成不达标', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    expect(refundGraphIfLowConfidence(db, id, MIN_EDGES)).toBeNull();
    db.prepare('INSERT INTO pricing_config (key, value_int) VALUES (?,?)').run(
      'dossier.min_graph_high_conf_edges',
      MIN_EDGES + 5,
    );
    expect(refundGraphIfLowConfidence(db, id, MIN_EDGES)).not.toBeNull();
  });
});

describe('M5 涉诉深度统计 · 样本不足或超 SLA 全额退', () => {
  test(`可判定篇数 ${MIN_SAMPLE} → 达标，返回 null`, () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    expect(refundDocsStatsIfSampleShort(db, id, MIN_SAMPLE)).toBeNull();
    expect(refundRows(db)).toHaveLength(0);
  });

  test(`可判定篇数 ${MIN_SAMPLE - 1}（差一篇）→ 触发全额退`, () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    const result = refundDocsStatsIfSampleShort(db, id, MIN_SAMPLE - 1);
    expect(result!.reason).toBe('sample_insufficient');
    expect(result!.totalRefunded).toBe(DOCS_STATS);
  });

  test('零篇 → 触发全额退', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    expect(refundDocsStatsIfSampleShort(db, id, 0)!.totalRefunded).toBe(DOCS_STATS);
  });

  test('超 SLA 未交付 → 无条件全额退（是否超期由巡检 job 判，本函数只执行退）', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    const result = refundDocsStatsSlaExpired(db, id);
    expect(result.reason).toBe('sla_expired');
    expect(result.totalRefunded).toBe(DOCS_STATS);
    // 不退不删别的模块：主体体检的钱还在账上
    expect(getDossierBillingView(db, id, uid)!.modules.find((b) => b.module === 'entity')!.refunded).toBe(0);
  });
});

describe('M6 人事套路归纳 · 保留条目不足全额退', () => {
  test(`保留 ${MIN_PATTERNS} 条 → 达标，返回 null`, () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    expect(refundPatternsIfKeptShort(db, id, MIN_PATTERNS)).toBeNull();
    expect(refundRows(db)).toHaveLength(0);
  });

  test(`保留 ${MIN_PATTERNS - 1} 条（差一条）→ 触发全额退`, () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    const result = refundPatternsIfKeptShort(db, id, MIN_PATTERNS - 1);
    expect(result!.reason).toBe('patterns_insufficient');
    expect(result!.module).toBe('patterns');
    expect(result!.totalRefunded).toBe(PATTERNS);
  });

  test('全部被丢（0 条）→ 触发全额退（这是最该退的那种，不是「无事发生」）', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    expect(refundPatternsIfKeptShort(db, id, 0)!.totalRefunded).toBe(PATTERNS);
  });

  test('M6 退了不牵连 M5：两块各自结算', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    refundPatternsIfKeptShort(db, id, 0);
    const view = getDossierBillingView(db, id, uid)!;
    expect(view.modules.find((b) => b.module === 'patterns')!.refunded).toBe(PATTERNS);
    expect(view.modules.find((b) => b.module === 'docs_stats')!.refunded).toBe(0);
  });
});

// ─────────────────── 幂等与边界 ───────────────────

describe('退款重放只退一次', () => {
  test('连退两次：第二次 refunded=false，余额与流水都不再变', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    const first = refundDossierModule(db, id, 'docs_stats', 'sample_insufficient');
    const balance = getGongdao(uid, db);
    const rows = refundRows(db).length;

    const second = refundDossierModule(db, id, 'docs_stats', 'sample_insufficient');

    expect(first.lines[0].refunded).toBe(true);
    expect(second.lines[0].refunded).toBe(false);
    expect(second.totalRefunded).toBe(0);
    expect(getGongdao(uid, db)).toBe(balance);
    expect(refundRows(db)).toHaveLength(rows);
  });

  test('巡检 job 每轮无脑重调三条判据也安全（三次全跑，钱只退一遍）', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    const before = getGongdao(uid, db);
    for (let i = 0; i < 3; i++) {
      refundGraphIfLowConfidence(db, id, 0);
      refundDocsStatsIfSampleShort(db, id, 0);
      refundPatternsIfKeptShort(db, id, 0);
    }
    expect(getGongdao(uid, db)).toBe(before + GRAPH + DOCS_STATS + PATTERNS);
    expect(refundRows(db)).toHaveLength(3);
  });
});

describe('券付与免费的模块没有钱可退', () => {
  test('赠送券覆盖的核心块：退出 0，且不凭空生出一条退款流水', () => {
    const { db, uid } = makeDb();
    grantEntitlement(db, uid, ENTITLEMENT_KIND.dossierCore, 'ORD-1');
    const r = confirmDossier(db, uid, order('北京甲科技有限公司'));
    if (!r.ok) throw new Error('建档失败');
    const before = getGongdao(uid, db);

    const result = refundDossierModule(db, r.dossierId, 'graph', 'graph_low_confidence');

    expect(result.lines).toEqual([]);
    expect(result.totalRefunded).toBe(0);
    expect(getGongdao(uid, db)).toBe(before);
    expect(refundRows(db)).toHaveLength(0);
  });

  test('定额为 0 的 M1：买了也退不出钱来（delta=0 标记行不是消费）', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    expect(listModuleCharges(db, id, 'venue')).toEqual([]);
    expect(refundDossierModule(db, id, 'venue', 'sample_insufficient').totalRefunded).toBe(0);
  });

  test('没买过的模块退 0（不是报错，巡检 job 不必先查买没买）', () => {
    const { db, uid } = makeDb();
    const r = confirmDossier(db, uid, order('北京甲科技有限公司', ['entity'], 0));
    if (!r.ok) throw new Error('建档失败');
    expect(refundDossierModule(db, r.dossierId, 'patterns', 'patterns_insufficient').totalRefunded).toBe(0);
  });
});

describe('扣费流水检索', () => {
  test('前缀不撞键：dossier-1 的检索不会捞到 dossier-12 的流水', () => {
    const { db, uid } = makeDb();
    // 连买 12 家，id 依次 1..12——`dossier-1-u…` 与 `dossier-12-u…` 共前缀，
    // 前缀匹配写漏一个分隔符就会把后者的流水一并退掉。
    const ids = Array.from({ length: 12 }, (_, i) => buyAll(db, uid, `公司${i}`));
    expect(ids[0]).toBe(1);
    expect(ids).toContain(12);

    const charges = listModuleCharges(db, ids[0], 'docs_stats');
    expect(charges).toHaveLength(1);
    expect(charges[0].chargeRef).toBe(dossierChargeRef(ids[0], uid, 'docs_stats'));

    // 退第 1 条只动第 1 条：第 12 条的钱一分没退
    refundDossierModule(db, ids[0], 'docs_stats', 'sample_insufficient');
    expect(
      getDossierBillingView(db, 12, uid)!.modules.find((b) => b.module === 'docs_stats')!.refunded,
    ).toBe(0);
  });

  test('查的是本模块，不会把别的模块的流水算进来', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    expect(listModuleCharges(db, id, 'graph').map((c) => c.amount)).toEqual([GRAPH]);
    expect(listModuleCharges(db, id, 'entity').map((c) => c.amount)).toEqual([ENTITY]);
    expect(listModuleCharges(db, id, 'docs_stats').map((c) => c.amount)).toEqual([DOCS_STATS]);
  });
});

describe('退款说明', () => {
  test('一句人话，含模块中文名、事由与金额，不含英文模块名', () => {
    const { db, uid } = makeDb();
    const id = buyAll(db, uid);
    const note = refundNote(refundDossierModule(db, id, 'docs_stats', 'sample_insufficient'));
    expect(note).toContain('涉诉深度统计');
    expect(note).toContain(String(DOCS_STATS));
    expect(note).not.toMatch(/docs_stats|patterns|graph|venue/);
  });

  test('四条事由各有各的说明，且都写清「保留了什么」（退钱不等于删数据）', () => {
    const texts = Object.values(DOSSIER_REFUND_REASON_TEXT);
    expect(texts).toHaveLength(4);
    for (const t of texts) {
      expect(t, `事由说明「${t}」没说明退款范围`).toMatch(/退回|不退不删/);
      expect(t, `事由说明「${t}」没说明保留了什么`).toMatch(/保留|可查|可看|不退不删/);
    }
  });
});
