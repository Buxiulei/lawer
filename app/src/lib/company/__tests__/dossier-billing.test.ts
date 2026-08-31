// app/src/lib/company/__tests__/dossier-billing.test.ts
// 公司档案·拆包按模块报价与确认扣费（方案 v3）。要害七条：
//   ① 报价绝不动钱（余额、ledger 行数、档案行数逐字不变）
//   ② 核心四项 ≤ 700 结构守卫——把 dossier.graph 调到越线值必须变红（有变异臂）
//   ③ 赠送券 dossier_core 只覆盖核心四项一次，不双花；深度模块照常扣费
//   ④ 确认扣费幂等（重复确认只扣一次），每模块一笔独立流水（退一块不牵连另一块）
//   ⑤ 余额不足不建档、不核销券（整笔回滚，不留「已建未付」的行）
//   ⑥ 深度模块的可售门槛与依赖：不满足直接不卖，不静默替用户加勾
//   ⑦ 公道值一律经 lib/billing，lib/company 全域禁止直写 gongdao / gongdao_ledger（结构守卫）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../db/migrate';
import { getGongdao, gongdaoGrant } from '../../billing/index';
import { GONGDAO_LEDGER_TYPE, REGISTER_GRANT_GONGDAO } from '../../billing/pricing';
import { PRICE_FALLBACK } from '../../billing/pricing-config';
import { SEED } from '../../billing/estimate';
import { ENTITLEMENT_KIND, grantEntitlement, listUnconsumed } from '../../billing/entitlements';
import {
  CORE_MODULES,
  DOSSIER_MODULES,
  DOSSIER_MODULE_FEATURE,
  billableDocs,
  confirmDossier,
  coreBundleTotal,
  coreBundleWithinGuard,
  dossierChargeRef,
  getDossierBillingView,
  hasDossierAccess,
  isModuleCharged,
  modulePrice,
  quoteDossier,
  type DossierModule,
  type DossierOrderInput,
} from '../dossier-billing';

const VENUE = PRICE_FALLBACK['dossier.venue'];
const ENTITY = PRICE_FALLBACK['dossier.entity'];
const GRAPH = PRICE_FALLBACK['dossier.graph'];
const DOCS_LIST = PRICE_FALLBACK['dossier.docs_list'];
const CORE_TOTAL = VENUE + ENTITY + GRAPH + DOCS_LIST;

const PER_DOC = PRICE_FALLBACK['dossier.docs_stats_per_doc'];
const CAP = PRICE_FALLBACK['dossier.docs_stats_cap_docs'];
const PAT_BASE = PRICE_FALLBACK['dossier.patterns_base'];
const PAT_BASE_DOCS = PRICE_FALLBACK['dossier.patterns_base_docs'];
const PAT_PER_EXTRA = PRICE_FALLBACK['dossier.patterns_per_extra_doc'];
const SELL_FLOOR = PRICE_FALLBACK['dossier.min_docurl_to_sell'];

/** 恰好达到可售门槛的篇数：低于它深度模块直接不卖，用它当各处的基准篇数。
 *  显式标 number 而非让它收窄成字面量类型——它是 order() 的默认参数，收窄了就只能传这一个值。 */
const DOCS: number = SELL_FLOOR;
const DOCS_STATS_AT_FLOOR = Math.min(DOCS, CAP) * PER_DOC;
const PATTERNS_AT_FLOOR = PAT_BASE + Math.max(0, Math.min(DOCS, CAP) - PAT_BASE_DOCS) * PAT_PER_EXTRA;
const DEEP_TOTAL = DOCS_STATS_AT_FLOOR + PATTERNS_AT_FLOOR;
const ALL_TOTAL = CORE_TOTAL + DEEP_TOTAL;

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('a@t.com').lastInsertRowid);
  const other = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('b@t.com').lastInsertRowid);
  return { db, uid, other };
}

function topUp(db: Database.Database, uid: number, amount: number, ref = `top-${uid}-${amount}`) {
  gongdaoGrant(uid, amount, GONGDAO_LEDGER_TYPE.recharge, ref, null, db);
}

function setPrice(db: Database.Database, key: string, value: number): void {
  db.prepare('INSERT OR REPLACE INTO pricing_config (key, value_int) VALUES (?,?)').run(key, value);
}

function snapshot(db: Database.Database, uid: number) {
  return {
    balance: getGongdao(uid, db),
    ledgerRows: (db.prepare('SELECT COUNT(*) AS n FROM gongdao_ledger').get() as { n: number }).n,
    dossiers: (db.prepare('SELECT COUNT(*) AS n FROM company_dossiers').get() as { n: number }).n,
  };
}

const CORE: DossierModule[] = [...CORE_MODULES];
const ALL: DossierModule[] = [...DOSSIER_MODULES];

/** 一张订单：默认买全部六块、篇数恰好压在可售门槛上。 */
const order = (
  name: string,
  modules: DossierModule[] = ALL,
  docCount = DOCS,
): DossierOrderInput => ({ name, modules, docCount });

function mustOk<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`期望成功，实得失败：${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

function mustFail<T extends { ok: boolean }>(r: T): Extract<T, { ok: false }> {
  if (r.ok) throw new Error(`期望失败，实得成功：${JSON.stringify(r)}`);
  return r as Extract<T, { ok: false }>;
}

function consumeRows(db: Database.Database) {
  return db
    .prepare('SELECT feature, ref_id, -delta AS amount FROM gongdao_ledger WHERE type=? ORDER BY id')
    .all(GONGDAO_LEDGER_TYPE.consume) as { feature: string; ref_id: string; amount: number }[];
}

/**
 * 展开算式的**自洽**判据：把等号左边真算一遍，看它等不等于右边印出来的总价。
 *
 * 【为什么不能用 toContain 断子串】「240 起（含前 20 篇）+ (5−20)×4 = 240」里
 * 240、20、5、4 每个子串都在，按子串断言一路全绿——而这条式子本身算不通（左边是 180）。
 * formula 这个字段存在的全部意义就是让用户能自己验算一遍，算不通就是它唯一的失败模式，
 * 也就必须是判据本身。
 *
 * 解析先把中文说明整段剥掉，剩下的每一项要么是裸数、要么是 `(a−b)×c` 或 `a × b`；
 * 出现看不懂的项就当场报红，不静默按 0 放行（那会让「式子写坏了」和「式子没问题」同形）。
 */
function formulaSides(formula: string): { lhs: number; rhs: number } {
  const parts = formula.split('=');
  expect(parts, `展开算式没有唯一的等号：「${formula}」`).toHaveLength(2);
  const expr = parts[0]
    .replace(/（[^）]*）/g, '') // 剥掉「（含前 20 篇，本次 5 篇）」这类说明
    .replace(/[起篇]/g, '')
    .replace(/−/g, '-')
    .replace(/×/g, '*');
  const lhs = expr.split('+').reduce((sum, raw) => {
    const term = raw.trim();
    const bracket = /^\((\d+)-(\d+)\)\*(\d+)$/.exec(term); // (21−20)×4
    if (bracket) return sum + (Number(bracket[1]) - Number(bracket[2])) * Number(bracket[3]);
    const product = /^(\d+)\s*\*\s*(\d+)$/.exec(term); // 5 篇 × 70
    if (product) return sum + Number(product[1]) * Number(product[2]);
    expect(term, `展开算式「${formula}」里有解析不了的项：「${term}」`).toMatch(/^\d+$/);
    return sum + Number(term);
  }, 0);
  const rhs = Number(parts[1].trim());
  expect(rhs, `展开算式「${formula}」等号右边不是一个数`).not.toBeNaN();
  return { lhs, rhs };
}

// ───────────────────────── 计价 ─────────────────────────

describe('计价口径', () => {
  test('核心四项 = 0 + 60 + 200 + 80 = 340（venue 恒 0 是信任锚）', () => {
    const { db } = makeDb();
    expect(VENUE).toBe(0);
    expect(coreBundleTotal(db)).toBe(CORE_TOTAL);
    expect(CORE_TOTAL).toBe(340);
    expect(CORE_MODULES.map((m) => modulePrice(db, m, 0))).toEqual([VENUE, ENTITY, GRAPH, DOCS_LIST]);
  });

  test('M5 按篇计价，超 cap 的篇数不入档也不计费', () => {
    const { db } = makeDb();
    expect(modulePrice(db, 'docs_stats', 3)).toBe(3 * PER_DOC);
    expect(modulePrice(db, 'docs_stats', CAP)).toBe(CAP * PER_DOC);
    expect(modulePrice(db, 'docs_stats', CAP + 100)).toBe(CAP * PER_DOC); // 封顶，不随篇数无限涨
    expect(billableDocs(db, CAP + 100)).toBe(CAP);
    expect(modulePrice(db, 'docs_stats', 0)).toBe(0);
  });

  test('M6 起价 + 每篇：骨架点「恰好 20 篇 = 240」，第 21 篇起每篇 +4', () => {
    const { db } = makeDb();
    expect(modulePrice(db, 'patterns', PAT_BASE_DOCS)).toBe(PAT_BASE);
    expect(modulePrice(db, 'patterns', PAT_BASE_DOCS - 5)).toBe(PAT_BASE); // 不足基线篇数不打折
    expect(modulePrice(db, 'patterns', PAT_BASE_DOCS + 1)).toBe(PAT_BASE + PAT_PER_EXTRA);
    expect(modulePrice(db, 'patterns', CAP)).toBe(PAT_BASE + (CAP - PAT_BASE_DOCS) * PAT_PER_EXTRA);
    expect(modulePrice(db, 'patterns', CAP + 999)).toBe(PAT_BASE + (CAP - PAT_BASE_DOCS) * PAT_PER_EXTRA);
  });

  test('负篇数按 0 处理，不会算出负价（负价会在结算时反向给用户加钱）', () => {
    const { db } = makeDb();
    expect(modulePrice(db, 'docs_stats', -5)).toBe(0);
    expect(modulePrice(db, 'patterns', -5)).toBe(PAT_BASE);
    expect(billableDocs(db, -5)).toBe(0);
  });
});

// ───────────────────── 结构守卫 G1：核心四项 ≤ 700 ─────────────────────

describe('结构守卫 · 核心四项总价不得吃光赠送额', () => {
  // 判据：核心四项总价 ≤ core_bundle_guard，且该上限 ≤ 注册赠送 − 一次首诊的预留。
  // 越线意味着「用户把核心档案买完，就再也发不起首诊」——那是产品主路径被自己的定价堵死。
  test('当前配置合规：340 ≤ 700 ≤ 1000 − 300', () => {
    const { db } = makeDb();
    const g = coreBundleWithinGuard(db);
    expect(g).toEqual({ ok: true, total: CORE_TOTAL, guard: 700, grantCeiling: 700 });
    expect(g.grantCeiling).toBe(REGISTER_GRANT_GONGDAO - SEED.intake);
  });

  // 变异臂之一：改价越线必须红。没有这条，上面那句「ok: true」与
  // 「这个函数永远返回 true」在输出上一模一样。
  test('变异臂 · 把关联谱系调到 700 → 核心合计 840 > 700 → 守卫变红', () => {
    const { db } = makeDb();
    setPrice(db, 'dossier.graph', 700);
    const g = coreBundleWithinGuard(db);
    expect(g.ok).toBe(false);
    expect(g.total).toBe(VENUE + ENTITY + 700 + DOCS_LIST);
    expect(g.total).toBeGreaterThan(g.guard);
  });

  // 变异臂之二：把上限自己抬上去也不算数——上限还得 ≤ 赠送额天花板，
  // 否则「调高守卫值」就成了绕过这条守卫的合法姿势。
  test('变异臂 · 把守卫上限抬到 800（> 赠送额天花板 700）→ 照样红', () => {
    const { db } = makeDb();
    setPrice(db, 'dossier.core_bundle_guard', 800);
    const g = coreBundleWithinGuard(db);
    expect(g.ok).toBe(false);
    expect(g.guard).toBe(800);
    expect(g.guard).toBeGreaterThan(g.grantCeiling);
  });

  test('边界：核心合计恰好等于上限仍算合规（≤ 不是 <）', () => {
    const { db } = makeDb();
    setPrice(db, 'dossier.graph', 700 - VENUE - ENTITY - DOCS_LIST);
    const g = coreBundleWithinGuard(db);
    expect(g.total).toBe(700);
    expect(g.ok).toBe(true);
  });
});

// ───────────────────────── 报价不动钱 ─────────────────────────

describe('报价绝不动钱', () => {
  test('quote 连叫三次，余额、ledger 行数、档案行数逐字不变', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 5000);
    const before = snapshot(db, uid);
    for (let i = 0; i < 3; i++) mustOk(quoteDossier(db, uid, order('北京甲科技有限公司')));
    expect(snapshot(db, uid)).toEqual(before);
  });

  test('余额为 0 也照常出价，只是标出缺口（报价不是闸门）', () => {
    const { db, uid } = makeDb();
    const q = mustOk(quoteDossier(db, uid, order('北京甲科技有限公司'))).quote;
    expect(q.total).toBe(ALL_TOTAL);
    expect(q.balance).toBe(0);
    expect(q.payableGongdao).toBe(ALL_TOTAL);
    expect(q.shortfall).toBe(ALL_TOTAL);
    expect(snapshot(db, uid).ledgerRows).toBe(0);
  });

  test('拆价可见：六块各自一行、按固定顺序，合计等于逐行之和', () => {
    const { db, uid } = makeDb();
    const q = mustOk(quoteDossier(db, uid, order('北京甲科技有限公司'))).quote;
    expect(q.items.map((i) => [i.module, i.gongdao])).toEqual([
      ['venue', VENUE],
      ['entity', ENTITY],
      ['graph', GRAPH],
      ['docs_list', DOCS_LIST],
      ['docs_stats', DOCS_STATS_AT_FLOOR],
      ['patterns', PATTERNS_AT_FLOOR],
    ]);
    expect(q.total).toBe(q.items.reduce((s, i) => s + i.gongdao, 0));
    expect(q.coreSubtotal).toBe(CORE_TOTAL);
  });

  test('乱序与重复的模块清单被归一到固定顺序、各只报一次', () => {
    const { db, uid } = makeDb();
    const q = mustOk(
      quoteDossier(db, uid, order('甲', ['patterns', 'graph', 'docs_stats', 'graph'])),
    ).quote;
    expect(q.items.map((i) => i.module)).toEqual(['graph', 'docs_stats', 'patterns']);
  });

  test('可以只买核心四项（深度两项可能样本不足，不打包硬卖）', () => {
    const { db, uid } = makeDb();
    const q = mustOk(quoteDossier(db, uid, order('北京甲科技有限公司', CORE, 0))).quote;
    expect(q.items).toHaveLength(4);
    expect(q.total).toBe(CORE_TOTAL);
  });

  test('空模块清单被拒，且文案说明核心与深度可以分开买', () => {
    const { db, uid } = makeDb();
    const r = mustFail(quoteDossier(db, uid, order('北京甲科技有限公司', [])));
    expect(r.errorCode).toBe('DOSSIER_MODULES_EMPTY');
    expect(r.message).toContain('分开买');
  });

  test('公司名只有空白 → 400，且不落任何行（空 key 会让所有这类请求共用一条档案）', () => {
    const { db, uid } = makeDb();
    const r = mustFail(quoteDossier(db, uid, order('   　 ')));
    expect(r.errorCode).toBe('COMPANY_NAME_EMPTY');
    expect(snapshot(db, uid).dossiers).toBe(0);
  });

  test('扣费前就报出 SLA、可售门槛、计费篇数与首诊预留（用户得先知道自己在买什么）', () => {
    const { db, uid } = makeDb();
    const q = mustOk(quoteDossier(db, uid, order('北京甲科技有限公司', ALL, CAP + 50))).quote;
    expect(q.litigationSlaDays).toBe(PRICE_FALLBACK['dossier.litigation_sla_days']);
    expect(q.minDocurlToSell).toBe(SELL_FLOOR);
    expect(q.billableDocs).toBe(CAP); // 超 cap 的篇数不入档，报价页就得说清
    expect(q.intakeReserve).toBe(SEED.intake);
  });

  test('按篇计价的两块给出展开算式，不给黑盒总数', () => {
    const { db, uid } = makeDb();
    const q = mustOk(quoteDossier(db, uid, order('甲', ['docs_stats', 'patterns'], DOCS))).quote;
    const stats = q.items.find((i) => i.module === 'docs_stats')!;
    const patterns = q.items.find((i) => i.module === 'patterns')!;
    expect(stats.formula).toContain(`${DOCS} 篇`);
    expect(stats.formula).toContain(String(DOCS_STATS_AT_FLOOR));
    expect(patterns.formula).toContain(String(PATTERNS_AT_FLOOR));
    // 固定价的四块没有算式（给个假算式只会让人以为它按什么在浮动）
    expect(q.items.filter((i) => i.formula !== undefined).map((i) => i.module)).toEqual([
      'docs_stats',
      'patterns',
    ]);
  });

  // M6 的算式在基线篇数以内曾印成「240 起（含前 20 篇）+ (5−20)×4 = 240」：
  // 式子里挂着一个 −60 的项，右边却还是 240。用户按它验算必然对不上，而这个字段
  // 存在的意义就是让人验算。四个点各盖一种形态：远低于基线 / 贴着基线 / 恰好基线 / 越过基线。
  test('M6 展开算式自洽：等号左边算一遍就等于右边（5 / 19 / 20 / 21 篇四点）', () => {
    const { db, uid } = makeDb();
    for (const docs of [SELL_FLOOR, PAT_BASE_DOCS - 1, PAT_BASE_DOCS, PAT_BASE_DOCS + 1]) {
      const q = mustOk(quoteDossier(db, uid, order('甲', ['docs_stats', 'patterns'], docs))).quote;
      const patterns = q.items.find((i) => i.module === 'patterns')!;
      const { lhs, rhs } = formulaSides(patterns.formula!);
      expect(lhs, `${docs} 篇：算式左边算出 ${lhs}，右边却印 ${rhs}——用户照着验算对不上`).toBe(rhs);
      expect(rhs, `${docs} 篇：算式印的总价与实际单价不符`).toBe(modulePrice(db, 'patterns', docs));
      expect(rhs).toBe(patterns.gongdao);
    }
  });

  // priceBasis 是**出口到前端的口径标签**，而实际怎么算钱在 modulePrice、给不给算式在 priceFormula。
  // 三处若各写各的，改了口径表只会让页面上的口径与真实算法各说各话——两边都不报错。
  // 本条把三者钉在一起：口径表里任改一格（free/fixed/per_doc/base_plus_per_doc 互换）都必红。
  test('计价口径单一真源：priceBasis、实际算法、展开算式三处对得上', () => {
    const { db, uid } = makeDb();
    const q = mustOk(quoteDossier(db, uid, order('甲', ALL, DOCS))).quote;
    expect(q.items).toHaveLength(DOSSIER_MODULES.length);
    for (const it of q.items) {
      const variesWithDocs = modulePrice(db, it.module, 0) !== modulePrice(db, it.module, CAP);
      const perDoc = it.priceBasis === 'per_doc' || it.priceBasis === 'base_plus_per_doc';
      expect(
        perDoc,
        `「${it.label}」口径写的是 ${it.priceBasis}，价格却${variesWithDocs ? '' : '不'}随篇数变`,
      ).toBe(variesWithDocs);

      if (perDoc) {
        // 按篇的必须给出算式，且算得通、印的总价就是实际单价
        const { lhs, rhs } = formulaSides(it.formula!);
        expect(lhs, `「${it.label}」的展开算式自己算不通`).toBe(rhs);
        expect(rhs).toBe(it.gongdao);
      } else {
        expect(it.formula, `「${it.label}」是定额却给了展开算式`).toBeUndefined();
      }

      // free 与 fixed 的差别只在「是不是 0」——不钉这一条，两者互换全绿，
      // 而 venue 恒 0 是本产品的信任锚，它被改标成定额得有人喊一声。
      if (it.priceBasis === 'free') {
        expect(modulePrice(db, it.module, 0), `「${it.label}」标着免费却要钱`).toBe(0);
      }
      if (it.priceBasis === 'fixed') {
        expect(modulePrice(db, it.module, 0), `「${it.label}」标着定额却是 0（那口径叫 free）`).toBeGreaterThan(0);
      }
    }
  });

  test('改价立刻反映到下一次报价（改表不改代码、不重启进程）', () => {
    const { db, uid } = makeDb();
    expect(mustOk(quoteDossier(db, uid, order('甲', CORE, 0))).quote.total).toBe(CORE_TOTAL);
    setPrice(db, 'dossier.graph', 111);
    expect(mustOk(quoteDossier(db, uid, order('甲', CORE, 0))).quote.total).toBe(
      CORE_TOTAL - GRAPH + 111,
    );
  });
});

// ────────────────── 深度模块：可售门槛与依赖 ──────────────────

describe('深度模块不明知故犯地卖', () => {
  test('文书篇数低于可售门槛 → 409，核心四项不受影响', () => {
    const { db, uid } = makeDb();
    const r = mustFail(quoteDossier(db, uid, order('甲', ALL, SELL_FLOOR - 1)));
    expect(r.status).toBe(409);
    expect(r.errorCode).toBe('DOSSIER_DOCS_BELOW_SELL_FLOOR');
    expect(r.message).toContain(String(SELL_FLOOR - 1));
    // 同样的篇数，只买核心照样成交
    expect(mustOk(quoteDossier(db, uid, order('甲', CORE, SELL_FLOOR - 1))).quote.total).toBe(CORE_TOTAL);
  });

  test('恰好达到门槛就卖（边界是 ≥，不是 >）', () => {
    const { db, uid } = makeDb();
    expect(mustOk(quoteDossier(db, uid, order('甲', ALL, SELL_FLOOR))).quote.total).toBe(ALL_TOTAL);
  });

  test('只勾 M6 不勾 M5 → 409，且文案说明该怎么办（不静默替用户加勾）', () => {
    const { db, uid } = makeDb();
    const r = mustFail(quoteDossier(db, uid, order('甲', ['patterns'])));
    expect(r.status).toBe(409);
    expect(r.errorCode).toBe('DOSSIER_DEPENDENCY_UNMET');
    expect(r.message).toMatch(/一并勾选|先单独购买/);
  });

  test('此前已买过 M5，之后单买 M6 放行', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 10_000);
    mustOk(confirmDossier(db, uid, order('甲', ['docs_stats'])));
    const q = mustOk(quoteDossier(db, uid, order('甲', ['patterns']))).quote;
    expect(q.total).toBe(PATTERNS_AT_FLOOR);
  });
});

// ───────────────────────── 余额闸 ─────────────────────────

describe('余额不足不建档', () => {
  test('余额比应付少 1 → 402、还差 1、company_dossiers 一行都没有', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, ALL_TOTAL - 1);
    const r = mustFail(confirmDossier(db, uid, order('北京甲科技有限公司')));
    expect(r.status).toBe(402);
    expect(r.errorCode).toBe('GONGDAO_INSUFFICIENT');
    expect(r.message).toContain('还差 1');
    expect(snapshot(db, uid)).toMatchObject({ balance: ALL_TOTAL - 1, dossiers: 0, ledgerRows: 1 });
  });

  test('恰好够 → 成功，余额清零', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, ALL_TOTAL);
    mustOk(confirmDossier(db, uid, order('北京甲科技有限公司')));
    expect(getGongdao(uid, db)).toBe(0);
  });

  test('错误文案三段式：差多少 / 为什么 / 怎么办', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 10);
    const r = mustFail(confirmDossier(db, uid, order('北京甲科技有限公司')));
    expect(r.message).toContain(`需要 ${ALL_TOTAL}`);
    expect(r.message).toContain('余额 10');
    expect(r.message).toMatch(/充值|只买/);
    expect(r.message).toContain('没有扣任何费用');
  });

  test('一单多模块一起判：不会「每块都够、合起来不够」地放行到第二块才透支', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, GRAPH + ENTITY); // 够买其中任意一块，不够两块加起来
    const r = mustFail(confirmDossier(db, uid, order('甲', ['entity', 'graph', 'docs_list'], 0)));
    expect(r.status).toBe(402);
    expect(getGongdao(uid, db)).toBe(GRAPH + ENTITY); // 一分钱没动
    expect(snapshot(db, uid).dossiers).toBe(0);
  });
});

// ───────────────────────── 幂等与逐模块流水 ─────────────────────────

describe('确认扣费幂等', () => {
  test('同一用户对同一家公司重复确认：只扣一次、只建一条档', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 10_000);
    const first = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司')));
    const balanceAfterFirst = getGongdao(uid, db);
    const second = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司')));

    expect(second.dossierId).toBe(first.dossierId);
    expect(first.charged).toBe(ALL_TOTAL);
    expect(second.charged).toBe(0);
    expect(second.paidBy).toBe('none');
    expect(getGongdao(uid, db)).toBe(balanceAfterFirst);
    expect(snapshot(db, uid).dossiers).toBe(1);
  });

  test('公司名写法不同（全角/空格/大小写）归一到同一条档案，不重复收费', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 10_000);
    const a = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司')));
    const b = mustOk(confirmDossier(db, uid, order(' 北京甲科技有限公司 ')));
    expect(b.dossierId).toBe(a.dossierId);
    expect(b.charged).toBe(0);
  });

  test('先买核心，再补买深度：只扣深度的钱', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 10_000);
    const a = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司', CORE, 0)));
    expect(a.charged).toBe(CORE_TOTAL);
    const b = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司', ALL)));
    expect(b.charged).toBe(DEEP_TOTAL);
    expect(b.dossierId).toBe(a.dossierId);
    expect(getGongdao(uid, db)).toBe(10_000 - ALL_TOTAL);
  });

  test('定额为 0 的模块（M1 仲裁地实操）买过之后也算买过，不会被再卖一次', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 10_000);
    const first = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司', ['venue'], 0)));
    expect(first.charged).toBe(0);

    // 判「买没买过」看有没有那笔流水，不看金额大于 0——
    // 按金额判，这块会显示成未购买，然后被再卖一次。
    const q = mustOk(quoteDossier(db, uid, order('北京甲科技有限公司', ['venue'], 0))).quote;
    expect(q.items[0].alreadyPaid).toBe(true);
    expect(q.items[0].gongdao).toBe(0);
    expect(q.total).toBe(0);
    expect(isModuleCharged(db, first.dossierId, uid, 'venue')).toBe(true);
    expect(getDossierBillingView(db, first.dossierId, uid)!.modules[0].paid).toBe(true);
  });

  // 上一条钉的是 venue，而 venue 原价本来就是 0——它证不了「已付过的模块报价钉零」这件事。
  // 这条用两块非零的模块钉：余额刚好只够剩下那一块，若已付的模块再按原价报出来，
  // 合计、实付、缺口会一起虚高，用户会在明明够钱的单子上看到「还差 260」。
  test('已付过的模块再报价钉零：合计、实付、缺口都不虚高', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, ENTITY + GRAPH + DOCS_LIST);
    mustOk(confirmDossier(db, uid, order('甲', ['entity', 'graph'], 0)));

    const q = mustOk(quoteDossier(db, uid, order('甲', ['entity', 'graph', 'docs_list'], 0))).quote;
    expect(q.items.map((i) => [i.module, i.alreadyPaid, i.gongdao])).toEqual([
      ['entity', true, 0],
      ['graph', true, 0],
      ['docs_list', false, DOCS_LIST],
    ]);
    expect(q.total).toBe(DOCS_LIST);
    expect(q.payableGongdao).toBe(DOCS_LIST);
    expect(q.balance).toBe(DOCS_LIST);
    expect(q.shortfall).toBe(0);
  });

  test('逐模块各一笔流水，feature 与幂等键都分得开（退一块不牵连另一块的前提）', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 10_000);
    const { dossierId } = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司')));
    expect(consumeRows(db)).toEqual([
      { feature: DOSSIER_MODULE_FEATURE.venue, ref_id: dossierChargeRef(dossierId, uid, 'venue'), amount: VENUE },
      { feature: DOSSIER_MODULE_FEATURE.entity, ref_id: dossierChargeRef(dossierId, uid, 'entity'), amount: ENTITY },
      { feature: DOSSIER_MODULE_FEATURE.graph, ref_id: dossierChargeRef(dossierId, uid, 'graph'), amount: GRAPH },
      {
        feature: DOSSIER_MODULE_FEATURE.docs_list,
        ref_id: dossierChargeRef(dossierId, uid, 'docs_list'),
        amount: DOCS_LIST,
      },
      {
        feature: DOSSIER_MODULE_FEATURE.docs_stats,
        ref_id: dossierChargeRef(dossierId, uid, 'docs_stats'),
        amount: DOCS_STATS_AT_FLOOR,
      },
      {
        feature: DOSSIER_MODULE_FEATURE.patterns,
        ref_id: dossierChargeRef(dossierId, uid, 'patterns'),
        amount: PATTERNS_AT_FLOOR,
      },
    ]);
  });

  test('幂等键含用户 id：第二位买家买同一家公司是另一笔，不被第一位的流水挡掉', () => {
    const { db, uid, other } = makeDb();
    topUp(db, uid, 10_000);
    topUp(db, other, 10_000, 'top-other');
    const a = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司', ['graph'], 0)));
    const b = mustOk(confirmDossier(db, other, order('北京甲科技有限公司', ['graph'], 0)));
    expect(b.dossierId).toBe(a.dossierId); // 同一条档案（公司维度的平台资产）
    expect(b.charged).toBe(GRAPH); // 各付各的
    expect(getGongdao(other, db)).toBe(10_000 - GRAPH);
  });

  test('第一位付款人的凭据不被第二位覆盖（paid_by/paid_ref 只盖一次）', () => {
    const { db, uid, other } = makeDb();
    topUp(db, uid, 10_000);
    topUp(db, other, 10_000, 'top-other');
    const a = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司', ['graph'], 0)));
    mustOk(confirmDossier(db, other, order('北京甲科技有限公司', ['entity'], 0)));
    const row = db.prepare('SELECT paid_by, paid_ref FROM company_dossiers WHERE id=?').get(a.dossierId) as {
      paid_by: string;
      paid_ref: string;
    };
    expect(row.paid_by).toBe('gongdao');
    expect(row.paid_ref).toBe(`dossier-${a.dossierId}-u${uid}`);
  });
});

// ───────────────────────── 会员赠送券 ─────────────────────────

describe('会员赠送券只覆盖核心四项一次', () => {
  test('只买核心 + 有券：余额一分不动、券被核销、两处留痕', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 10_000);
    grantEntitlement(db, uid, ENTITLEMENT_KIND.dossierCore, 'ORD-1');
    const before = getGongdao(uid, db);

    const r = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司', CORE, 0)));
    expect(r.paidBy).toBe('membership_credit');
    expect(r.charged).toBe(0);
    expect(getGongdao(uid, db)).toBe(before);
    expect(listUnconsumed(db, uid, ENTITLEMENT_KIND.dossierCore)).toHaveLength(0);

    // 留痕一：档案上写明这单是券付的，凭据是哪张券
    const row = db.prepare('SELECT paid_by, paid_ref FROM company_dossiers WHERE id=?').get(r.dossierId) as {
      paid_by: string | null;
      paid_ref: string | null;
    };
    expect(row.paid_by).toBe('membership_credit');
    expect(row.paid_ref).toBe(String(r.entitlementId));

    // 留痕二：券上写明用去了哪条档案
    const ent = db.prepare('SELECT consumed_ref FROM entitlements WHERE id=?').get(r.entitlementId) as {
      consumed_ref: string | null;
    };
    expect(ent.consumed_ref).toBe(`dossier-${r.dossierId}`);
  });

  test('券付的核心块落 delta=0 标记行：账本余额不动，但「买过没有」照样查得到', () => {
    const { db, uid } = makeDb();
    grantEntitlement(db, uid, ENTITLEMENT_KIND.dossierCore, 'ORD-1');
    const r = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司', CORE, 0)));
    expect(consumeRows(db).map((x) => x.amount)).toEqual([0, 0, 0, 0]);
    expect(getGongdao(uid, db)).toBe(0);
    for (const m of CORE_MODULES) expect(isModuleCharged(db, r.dossierId, uid, m)).toBe(true);
  });

  test('零余额 + 一张券 = 核心四项买得下来（券不该被余额闸挡住）', () => {
    const { db, uid } = makeDb();
    grantEntitlement(db, uid, ENTITLEMENT_KIND.dossierCore, 'ORD-1');
    const r = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司', CORE, 0)));
    expect(r.paidBy).toBe('membership_credit');
    expect(getGongdao(uid, db)).toBe(0);
  });

  test('券只覆盖核心：同单里的深度两项照常扣钱', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 10_000);
    grantEntitlement(db, uid, ENTITLEMENT_KIND.dossierCore, 'ORD-1');
    const r = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司')));
    expect(r.paidBy).toBe('membership_credit');
    expect(r.charged).toBe(DEEP_TOTAL);
    expect(getGongdao(uid, db)).toBe(10_000 - DEEP_TOTAL);
  });

  // 券只覆盖核心四项，所以一张**只买深度**的单不该碰它。少了这条断言，把 confirmDossier 里
  // 那道 `payableCore.length > 0` 拿掉全绿：券会被静默核销掉，用户付了深度两项的全款，
  // 手上那张核心券却凭空少了一张——账面上什么都不会发生。
  test('只买深度两项不吃券：券原封不动，钱照常扣', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 10_000);
    grantEntitlement(db, uid, ENTITLEMENT_KIND.dossierCore, 'ORD-1');

    const r = mustOk(confirmDossier(db, uid, order('甲', ['docs_stats', 'patterns'])));
    expect(r.entitlementId).toBeNull();
    expect(r.paidBy).toBe('gongdao');
    expect(r.charged).toBe(DEEP_TOTAL);
    expect(listUnconsumed(db, uid, ENTITLEMENT_KIND.dossierCore)).toHaveLength(1);
    // 券还在，随后买核心四项照样能用它
    const core = mustOk(confirmDossier(db, uid, order('甲', CORE, DOCS)));
    expect(core.paidBy).toBe('membership_credit');
    expect(core.charged).toBe(0);
  });

  test('一张券只兑一次：第二家公司照常扣钱（不双花）', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 10_000);
    grantEntitlement(db, uid, ENTITLEMENT_KIND.dossierCore, 'ORD-1');
    mustOk(confirmDossier(db, uid, order('北京甲科技有限公司', CORE, 0)));
    const second = mustOk(confirmDossier(db, uid, order('北京乙科技有限公司', CORE, 0)));
    expect(second.paidBy).toBe('gongdao');
    expect(second.charged).toBe(CORE_TOTAL);
    expect(getGongdao(uid, db)).toBe(10_000 - CORE_TOTAL);
  });

  test('对同一家公司重复确认不会再核销一张券（重放不吃券）', () => {
    const { db, uid } = makeDb();
    grantEntitlement(db, uid, ENTITLEMENT_KIND.dossierCore, 'ORD-1');
    grantEntitlement(db, uid, ENTITLEMENT_KIND.dossierCore, 'ORD-2');
    const first = mustOk(confirmDossier(db, uid, order('甲', CORE, 0)));
    const second = mustOk(confirmDossier(db, uid, order('甲', CORE, 0)));
    expect(second.paidBy).toBe('none');
    expect(second.entitlementId).toBeNull();
    expect(listUnconsumed(db, uid, ENTITLEMENT_KIND.dossierCore)).toHaveLength(1);
    expect(first.entitlementId).not.toBeNull();
  });

  test('券可用但深度模块的钱不够 → 整笔回滚：不建档、券还在（不留「已建未付」的行）', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, DEEP_TOTAL - 1);
    grantEntitlement(db, uid, ENTITLEMENT_KIND.dossierCore, 'ORD-1');

    const r = mustFail(confirmDossier(db, uid, order('北京甲科技有限公司')));
    expect(r.status).toBe(402);
    expect(r.message).toContain(`需要 ${DEEP_TOTAL}`); // 应付额已扣掉券覆盖的核心
    expect(snapshot(db, uid)).toMatchObject({ balance: DEEP_TOTAL - 1, dossiers: 0 });
    expect(listUnconsumed(db, uid, ENTITLEMENT_KIND.dossierCore)).toHaveLength(1); // 券被回滚回来
    expect(consumeRows(db)).toEqual([]);
  });

  test('报价页如实告知有券可用，并把券抵扣后的实付额单列', () => {
    const { db, uid } = makeDb();
    let q = mustOk(quoteDossier(db, uid, order('甲'))).quote;
    expect(q.membershipCreditAvailable).toBe(false);
    expect(q.payableGongdao).toBe(ALL_TOTAL);

    grantEntitlement(db, uid, ENTITLEMENT_KIND.dossierCore, 'ORD-1');
    q = mustOk(quoteDossier(db, uid, order('甲'))).quote;
    expect(q.membershipCreditAvailable).toBe(true);
    expect(q.total).toBe(ALL_TOTAL); // 原价照旧列出
    expect(q.payableGongdao).toBe(ALL_TOTAL - CORE_TOTAL); // 实付额扣掉券覆盖的核心
    expect(q.shortfall).toBe(ALL_TOTAL - CORE_TOTAL); // 缺口按实付额算，不按原价算
  });
});

// ───────────────────────── 视图与归属 ─────────────────────────

describe('计费实况视图与归属', () => {
  test('付过费的人看得到；没关系的人看不到（不存在与无权同形）', () => {
    const { db, uid, other } = makeDb();
    topUp(db, uid, 10_000);
    const { dossierId } = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司')));
    expect(hasDossierAccess(db, dossierId, uid)).toBe(true);
    expect(hasDossierAccess(db, dossierId, other)).toBe(false);
    expect(getDossierBillingView(db, dossierId, other)).toBeNull();
    expect(getDossierBillingView(db, 99999, uid)).toBeNull();
  });

  test('券付的第二位买家也看得到（凭据在券上，不在账本里）', () => {
    const { db, uid, other } = makeDb();
    topUp(db, uid, 10_000);
    const { dossierId } = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司', ['graph'], 0)));
    grantEntitlement(db, other, ENTITLEMENT_KIND.dossierCore, 'ORD-OTHER');
    mustOk(confirmDossier(db, other, order('北京甲科技有限公司', CORE, 0)));
    expect(hasDossierAccess(db, dossierId, other)).toBe(true);
    expect(getDossierBillingView(db, dossierId, other)!.paidByMembershipCredit).toBe(true);
  });

  test('逐模块列出实扣与已退，净支出 = 扣 − 退；六块一块不少', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 10_000);
    const { dossierId } = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司')));
    const view = getDossierBillingView(db, dossierId, uid)!;
    expect(view.modules.map((b) => [b.module, b.paid, b.charged, b.refunded])).toEqual([
      ['venue', true, VENUE, 0],
      ['entity', true, ENTITY, 0],
      ['graph', true, GRAPH, 0],
      ['docs_list', true, DOCS_LIST, 0],
      ['docs_stats', true, DOCS_STATS_AT_FLOOR, 0],
      ['patterns', true, PATTERNS_AT_FLOOR, 0],
    ]);
    expect(view.netGongdao).toBe(ALL_TOTAL);
  });

  test('没买的模块在视图里是 paid=false，不会被当成买过', () => {
    const { db, uid } = makeDb();
    topUp(db, uid, 10_000);
    const { dossierId } = mustOk(confirmDossier(db, uid, order('北京甲科技有限公司', ['entity'], 0)));
    const view = getDossierBillingView(db, dossierId, uid)!;
    expect(view.modules.filter((b) => b.paid).map((b) => b.module)).toEqual(['entity']);
    expect(view.netGongdao).toBe(ENTITY);
  });
});

// ─────────────── 结构守卫 · 公道值不许绕过 lib/billing 直写 ───────────────

/**
 * 幂等、事务、负余额语义全长在 lib/billing 的 gongdaoSettle / gongdaoRefund / gongdaoGrant 里。
 * 在 lib/company 里自己拼一条 `INSERT INTO gongdao_ledger`，这三件事一次全丢，
 * 而**账面上什么都不会发生**——多扣一次可以退，少扣、双扣、扣完余额没跟着变，
 * 只有对账才发现。所以这条按「写语句」扫源码，不靠人记得。
 *
 * 读是允许的（isModuleCharged / chargedAmount / refundedAmount 都要 SELECT 账本）：
 * 读账本不会让账本说谎，禁读只会逼人把读也搬进 lib/billing，换来一层没有意义的转发。
 */
const DIRECT_WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+`?(gongdao|gongdao_ledger)`?\b/gi;

function findDirectWrites(src: string): string[] {
  return [...src.matchAll(DIRECT_WRITE_RE)].map((m) => m[0].replace(/\s+/g, ' '));
}

describe('结构守卫 · 公道值全走 lib/billing', () => {
  const COMPANY_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

  function productionFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue; // 测试可以自己造账本行来铺场景
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) productionFiles(full, out);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  test('lib/company 下没有任何一处直写 gongdao / gongdao_ledger', () => {
    const files = productionFiles(COMPANY_DIR);
    expect(files.length, 'lib/company 一个生产文件都没扫到——目录定位坏了').toBeGreaterThan(2);
    const offenders: string[] = [];
    for (const file of files) {
      for (const hit of findDirectWrites(fs.readFileSync(file, 'utf-8'))) {
        offenders.push(`${path.basename(file)}: ${hit}`);
      }
    }
    expect(
      offenders,
      `这些地方绕过了 lib/billing 直写公道值账本，幂等/事务/负余额语义会一起丢：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  // 对照臂：没有它，「扫不出违规」与「正则写错了 / 文件没读到」输出一模一样。
  test('扫描器本身是活的：写法各异的直写都抓得住，纯读取不误伤', () => {
    expect(findDirectWrites("db.prepare('INSERT INTO gongdao_ledger (user_id) VALUES (?)')")).toHaveLength(1);
    expect(findDirectWrites("db.prepare('INSERT OR IGNORE INTO gongdao_ledger (a) VALUES (?)')")).toHaveLength(1);
    expect(findDirectWrites("db.prepare('UPDATE gongdao SET balance = balance - ?')")).toHaveLength(1);
    expect(findDirectWrites("db.prepare('DELETE FROM gongdao WHERE user_id=?')")).toHaveLength(1);
    expect(findDirectWrites("db.prepare('SELECT 1 FROM gongdao_ledger WHERE ref_id=?')")).toEqual([]);
  });

  test('正向臂：扣费与退款确实是从 lib/billing 引进来的，不是本地另起的同名函数', async () => {
    const billing = await import('../../billing/index');
    expect(typeof billing.gongdaoSettle).toBe('function');
    expect(typeof billing.gongdaoRefund).toBe('function');
    const src = fs.readFileSync(path.join(COMPANY_DIR, 'dossier-billing.ts'), 'utf-8');
    expect(src).toMatch(/import\s*\{\s*gongdaoSettle\s*\}\s*from\s*'\.\.\/billing\/index'/);
  });
});
