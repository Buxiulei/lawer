// app/src/lib/dossier/__tests__/order.test.ts
// 报价页纯逻辑层的判据。三组，每组都有变异臂：
//
//   ① **对账**：前端算的合计与服务端 quoteDossier 对同一个子集算的必须逐字相等。
//      这一组不是"两边各写一遍然后互相点头"——它拿真库、真迁移、真 quoteDossier 跑，
//      两边算出来的四个数（total / coreSubtotal / payableGongdao / shortfall）不等就红。
//      前端定价漂了（比如把券的抵扣算成抵全额）在这里当场现形，而不是等用户看到
//      "页面显示 340、实际扣 200"。
//   ② **咬合**：客户端那份模块目录、退款承诺的覆盖面，与服务端那两份表双向相等，
//      任一处改了名而另一处没跟，测试**点名说是哪个键**。
//   ③ **置灰**：可售性判据与原因句——原因句里必须带着那个观测到的数。
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { gongdaoGrant } from '../../billing/index';
import { GONGDAO_LEDGER_TYPE } from '../../billing/pricing';
import {
  CORE_MODULES,
  DOSSIER_MODULES,
  DOSSIER_MODULE_LABEL,
  quoteDossier,
  type DossierModule,
  type DossierQuote,
} from '../../company/dossier-billing';
import type { ProbePayload } from '../../company/probe';
import { DOSSIER_REFUND_REASON_TEXT } from '../../company/refund';
import { runMigrations } from '../../db/migrate';
import {
  MODULE_CATALOG,
  MODULE_REFUND_PROMISE,
  REFUND_REASON_MODULE,
  billableSelection,
  defaultSelection,
  dependencyUnmet,
  isQuoteStale,
  moduleAvailability,
  moduleDisclosure,
  preChargeDisclosures,
  subjectKey,
  summarizeSelection,
} from '../order';

/** 真迁移建库（夹具不手搓表结构：手搓的那份验的就不是产线那份表了）。 */
function makeDb(balance: number) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(
    db.prepare('INSERT INTO users (email) VALUES (?)').run('quote@t.com').lastInsertRowid,
  );
  if (balance > 0) gongdaoGrant(uid, balance, GONGDAO_LEDGER_TYPE.recharge, 'top-1', null, db);
  return { db, uid };
}

const ALL: DossierModule[] = [...DOSSIER_MODULES];
/** 恰好够得着可售门槛的篇数（门槛兜底 5）。 */
const DOCS = 9;

function quoteOf(db: Database.Database, uid: number, modules: DossierModule[]): DossierQuote {
  const res = quoteDossier(db, uid, { name: '某某科技有限公司', modules, docCount: DOCS });
  if (!res.ok) throw new Error(`报价失败：${res.errorCode} ${res.message}`);
  return res.quote;
}

/* ── ① 对账：前端合计 vs 服务端合计 ───────────────────── */

describe('合计对账：前端把服务端给的行加起来，结果必须与服务端对同一子集报的价逐字相等', () => {
  /**
   * 变异臂（任一条都让本组变红）：
   *   · summarizeSelection 里的 payableGongdao 改成恒等于 total（券白送了）；
   *   · coreSubtotal 把 isCore 判断去掉（券抵扣范围扩到深度两块）；
   *   · shortfall 忘了 Math.max(0, …)（余额够时给出一个负缺口，按钮永远可点）。
   * 这一组的价值全在"另一条臂是真的服务端"——两边各写一份然后互相断言，
   * 只能证明两份一样，证明不了哪一份对。
   */
  const SUBSETS: DossierModule[][] = [
    ['venue'],
    ['entity', 'graph'],
    [...CORE_MODULES],
    ['docs_stats'],
    ['docs_stats', 'patterns'],
    [...DOSSIER_MODULES],
  ];

  for (const subset of SUBSETS) {
    it(`子集 [${subset.join(',')}]：total / coreSubtotal / payableGongdao / shortfall 四个数全等`, () => {
      const { db, uid } = makeDb(3000);
      const catalog = quoteOf(db, uid, ALL);
      const mine = summarizeSelection(catalog, subset);
      const server = quoteOf(db, uid, subset);

      expect(mine.total).toBe(server.total);
      expect(mine.coreSubtotal).toBe(server.coreSubtotal);
      expect(mine.payableGongdao).toBe(server.payableGongdao);
      expect(mine.shortfall).toBe(server.shortfall);
      db.close();
    });
  }

  it('余额不足时缺口也对得上（缺口按 payableGongdao 算，不是按 total）', () => {
    const { db, uid } = makeDb(100);
    const catalog = quoteOf(db, uid, ALL);
    const mine = summarizeSelection(catalog, ALL);
    const server = quoteOf(db, uid, ALL);
    expect(mine.shortfall).toBe(server.shortfall);
    expect(mine.shortfall).toBeGreaterThan(0);
    db.close();
  });

  it('券可用时，抵掉的恰好是核心那一段（深度两块照常扣）', async () => {
    const { db, uid } = makeDb(3000);
    const { ENTITLEMENT_KIND, grantEntitlement } = await import('../../billing/entitlements');
    grantEntitlement(db, uid, ENTITLEMENT_KIND.dossierCore, 'test-grant');

    const catalog = quoteOf(db, uid, ALL);
    const mine = summarizeSelection(catalog, ALL);
    const server = quoteOf(db, uid, ALL);

    expect(catalog.membershipCreditAvailable).toBe(true);
    expect(mine.payableGongdao).toBe(server.payableGongdao);
    expect(mine.payableGongdao).toBe(mine.total - mine.coreSubtotal);
    expect(mine.deepSubtotal).toBeGreaterThan(0);
    db.close();
  });

  it('赠送额守护：扣完撑不起一次首诊时出黄条，但不阻断（shortfall 仍为 0）', () => {
    const { db, uid } = makeDb(400); // 核心四项 340，扣完只剩 60 < 首诊 300
    const catalog = quoteOf(db, uid, [...CORE_MODULES]);
    const mine = summarizeSelection(catalog, [...CORE_MODULES]);
    expect(mine.shortfall).toBe(0);
    expect(mine.intakeAtRisk).toBe(true);
    expect(mine.balanceAfter).toBeLessThan(mine.intakeReserve);
    db.close();
  });
});

/* ── 依赖：前端拦的与服务端拒的是同一件事 ─────────────── */

describe('依赖（人事套路归纳要涉诉深度统计）：前端说不能下单 ⇔ 服务端 409', () => {
  it('只勾 patterns：前端给出原因句，服务端同时 409 DOSSIER_DEPENDENCY_UNMET', () => {
    const { db, uid } = makeDb(3000);
    const catalog = quoteOf(db, uid, ALL);

    const note = dependencyUnmet('patterns', ['patterns'], catalog.items);
    expect(note).not.toBeNull();
    expect(note).toContain('涉诉深度统计');

    const server = quoteDossier(db, uid, {
      name: '某某科技有限公司',
      modules: ['patterns'],
      docCount: DOCS,
    });
    expect(server.ok).toBe(false);
    if (!server.ok) expect(server.errorCode).toBe('DOSSIER_DEPENDENCY_UNMET');
    db.close();
  });

  it('两块一起勾：前端不拦，服务端也报得出价', () => {
    const { db, uid } = makeDb(3000);
    const catalog = quoteOf(db, uid, ALL);
    expect(dependencyUnmet('patterns', ['docs_stats', 'patterns'], catalog.items)).toBeNull();
    expect(quoteOf(db, uid, ['docs_stats', 'patterns']).items).toHaveLength(2);
    db.close();
  });
});

/* ── ② 咬合：客户端目录 vs 服务端表 ───────────────────── */

describe('客户端模块目录与服务端两份表双向相等（改了一处没改另一处，这里点名）', () => {
  /**
   * 变异臂：把 MODULE_CATALOG 里 patterns 的 label 改成「HR 套路归纳」，这条会红并点名 patterns。
   * 不这样咬的话，页面上写一个名、账单里写另一个名，两边各自看着都对。
   */
  it('模块集合与顺序一致', () => {
    expect(MODULE_CATALOG.map((c) => c.module)).toEqual([...DOSSIER_MODULES]);
  });

  it('每一块的 label 与 isCore 与服务端逐条相等', () => {
    for (const card of MODULE_CATALOG) {
      expect(`${card.module}:${card.label}`).toBe(
        `${card.module}:${DOSSIER_MODULE_LABEL[card.module]}`,
      );
      expect(`${card.module}:${card.isCore}`).toBe(
        `${card.module}:${CORE_MODULES.includes(card.module)}`,
      );
    }
  });

  it('每一块都有一句「这一块给什么」，没有空壳卡', () => {
    for (const card of MODULE_CATALOG) {
      expect(card.delivers.trim().length).toBeGreaterThan(10);
    }
  });
});

describe('退款承诺的覆盖面与 refund.ts 的退款路径咬合', () => {
  /**
   * 变异臂：在 refund.ts 里新加一条退款事由（DOSSIER_REFUND_REASON_TEXT 多一个键）
   * 而不在 REFUND_REASON_MODULE 里登记，这条会红并点名那个新事由。
   * 新开一条退款路径而报价页只字不提，是**没人会发现**的那种漏：
   * 页面照常渲染、别的测试照常绿，只有用户永远不知道这块本来能退。
   */
  it('退款事由的键集两边完全一致', () => {
    expect(Object.keys(REFUND_REASON_MODULE).sort()).toEqual(
      Object.keys(DOSSIER_REFUND_REASON_TEXT).sort(),
    );
  });

  it('凡是有退款路径的模块，扣费前都给出了退款承诺；没有路径的不许乱许诺', () => {
    const refundable = new Set(Object.values(REFUND_REASON_MODULE));
    for (const card of MODULE_CATALOG) {
      const promised = MODULE_REFUND_PROMISE[card.module] !== null;
      expect(`${card.module}:${promised}`).toBe(`${card.module}:${refundable.has(card.module)}`);
    }
  });
});

/* ── ③ 置灰：可售性与原因句 ───────────────────────────── */

function payload(over: Partial<ProbePayload> = {}): ProbePayload {
  return {
    entity_matched: true,
    entity_name: '某某科技有限公司',
    uscc: null,
    gs_status: '存续',
    relation_count: 6,
    litigation_count: 23,
    labor_count: 14,
    doc_url_count: DOCS,
    as_of: '2026-08-28',
    ...over,
  };
}

describe('可售性：置灰必须带原因句，且句里带着观测到的那个数', () => {
  /**
   * 变异臂：把 moduleAvailability 里 `probe.relation_count === 0` 那一支删掉，
   * 或把 reason 换成「暂不可用」四个字，这一组会红。
   * 「暂不可用」等于没说：用户分不清是这家真没有、还是我们没查到、还是系统坏了。
   */
  it('关联主体 0 个 ⇒ 关联谱系置灰，原因句里写出那个 0', () => {
    const a = moduleAvailability('graph', payload({ relation_count: 0 }), null);
    expect(a.sellable).toBe(false);
    if (!a.sellable) {
      expect(a.reason).toContain('0 个');
      // 「查不到」不等于「没有」，这句区分不许省
      expect(a.reason).toContain('不等于');
    }
  });

  it('涉诉记录 0 条 ⇒ 涉诉清单置灰；同一份探测下别的核心块不受牵连', () => {
    const p = payload({ litigation_count: 0, labor_count: 0, doc_url_count: 0 });
    expect(moduleAvailability('docs_list', p, null).sellable).toBe(false);
    expect(moduleAvailability('entity', p, null).sellable).toBe(true);
    expect(moduleAvailability('venue', p, null).sellable).toBe(true);
    expect(moduleAvailability('graph', p, null).sellable).toBe(true);
  });

  it('主体没匹配上 ⇒ 六块全置灰，且原因句指向"换个写法或填代码"，不是"这家很干净"', () => {
    const p = payload({
      entity_matched: true,
      relation_count: 0,
      litigation_count: 0,
      labor_count: 0,
      doc_url_count: 0,
    });
    const miss = { ...p, entity_matched: false };
    for (const card of MODULE_CATALOG) {
      const a = moduleAvailability(card.module, miss, null);
      expect(`${card.module}:${a.sellable}`).toBe(`${card.module}:false`);
      if (!a.sellable) expect(a.reason).toContain('统一社会信用代码');
    }
  });

  it('还没探测过 ⇒ 核心四块照常可买，深度两块置灰且说的是「还没查」不是「没有」', () => {
    for (const card of MODULE_CATALOG) {
      const a = moduleAvailability(card.module, null, null);
      expect(`${card.module}:${a.sellable}`).toBe(`${card.module}:${card.isCore}`);
      if (!a.sellable) expect(a.reason).toContain('还没查过');
    }
  });

  it('深度两块的置灰原因用服务端那句原话（门槛与篇数的判据在服务端）', () => {
    const serverSays = '低于可售门槛 5 篇：连样本门槛都够不着就收费再退款是明知故犯';
    const a = moduleAvailability('docs_stats', payload({ doc_url_count: 2 }), serverSays);
    expect(a.sellable).toBe(false);
    if (!a.sellable) expect(a.reason).toBe(serverSays);
  });
});

describe('不可售的块永远不进合计、不进下单（与它是怎么被勾上的无关）', () => {
  /**
   * 变异臂：把 OrderQuote 里的 billableSelection 换回直接用 selected，这条会红。
   *
   * 这条堵的不是"用户点了置灰的卡"——置灰的卡根本没有勾选框。堵的是 selected 的另外两条来路：
   * 默认勾选，以及"换了一家公司重新探测后，上一次的勾还留着"。那两条路径上，一个界面上
   * 明写着「暂不可售」的块可以躺在 selected 里被一起下单，用户为一个页面说买不到的东西付了钱，
   * 而且没有任何一处会报错。
   */
  it('勾了但探测说关联主体 0 个 ⇒ 不进 billable，合计里也没有它那 200', () => {
    const { db, uid } = makeDb(3000);
    const catalog = quoteOf(db, uid, ALL);
    const picked: DossierModule[] = ['entity', 'graph'];
    const probe = payload({ relation_count: 0 });

    const billable = billableSelection(picked, probe, null);
    expect(billable).toEqual(['entity']);

    const withGraph = summarizeSelection(catalog, picked);
    const without = summarizeSelection(catalog, billable);
    expect(withGraph.total - without.total).toBe(
      catalog.items.find((it) => it.module === 'graph')!.gongdao,
    );
    db.close();
  });

  it('换了一家之后旧的勾还留着：深度两块被判不可售时，它们不会被顺手买走', () => {
    const stale: DossierModule[] = [...DOSSIER_MODULES];
    const billable = billableSelection(stale, payload({ doc_url_count: 1 }), '这家文书篇数够不着门槛。');
    expect(billable).toEqual([...CORE_MODULES]);
  });
});

/* ── 逐块披露 ─────────────────────────────────────────── */

describe('逐块披露：口径、算式、时延、退款四样都得有', () => {
  /**
   * 变异臂：moduleDisclosure 里把 slaWorkdays 恒给 null（时延承诺消失），
   * 或把 quote.litigationSlaDays 换成字面量 7（界面写死门槛），这一组会红。
   */
  it('深度两块带工作日上限（取自 quote，不是写死的 7）与退款承诺；核心四块不挂时延', () => {
    const { db, uid } = makeDb(3000);
    db.prepare('INSERT OR REPLACE INTO pricing_config (key, value_int) VALUES (?,?)').run(
      'dossier.litigation_sla_days',
      11,
    );
    const quote = quoteOf(db, uid, ALL);

    for (const item of quote.items) {
      const d = moduleDisclosure(item, quote);
      if (item.module === 'docs_stats' || item.module === 'patterns') {
        expect(`${item.module}:${d.slaWorkdays}`).toBe(`${item.module}:11`);
        expect(d.refundPromise).not.toBeNull();
        expect(d.formula).not.toBeNull();
      } else {
        expect(`${item.module}:${d.slaWorkdays}`).toBe(`${item.module}:null`);
      }
      expect(d.basisText.length).toBeGreaterThan(0);
    }
    db.close();
  });
});

describe('扣费前必须说的那几句（契约 §二）', () => {
  it('三句常驻；超出计费上限时才多出第四句', () => {
    const { db, uid } = makeDb(3000);
    const quote = quoteOf(db, uid, ALL);

    const normal = preChargeDisclosures(quote, DOCS);
    expect(normal).toHaveLength(3);
    expect(normal.join('\n')).toContain('分开买');
    expect(normal.join('\n')).toContain(`最长 ${quote.litigationSlaDays} 个工作日`);
    expect(normal.join('\n')).toContain('自动全额退还该模块费用');

    const over = preChargeDisclosures(quote, quote.billableDocs + 7);
    expect(over).toHaveLength(4);
    expect(over[3]).toContain('不入档、不处理、也不收费');
    expect(over[3]).toContain(String(quote.billableDocs));
    db.close();
  });
});

/* ── 默认勾选：两层过滤各自防一件事 ───────────────────── */

describe('默认勾选只勾「可售且没买过」的核心四块', () => {
  it('六块全可售、全没买过 ⇒ 默认恰好是核心四块，深度两块要用户自己伸手勾', () => {
    const { db, uid } = makeDb(3000);
    const quote = quoteOf(db, uid, ALL);
    expect(defaultSelection(quote, payload(), null)).toEqual([...CORE_MODULES]);
    db.close();
  });

  /**
   * 变异臂：把 defaultSelection 里 `.filter(… sellable)` 那一层删掉，这条会红。
   * 没有它，探测到 0 关联的公司照样默认勾上「关联谱系」，用户一路点下去，
   * 就为一个页面上明写着「暂不可售」的块付了钱——billableSelection 是第二道，
   * 但那道只拦扣费，屏幕上这一块仍然显示成"已选"。
   */
  it('探测说关联主体 0 个 ⇒ 关联谱系不进默认勾选', () => {
    const { db, uid } = makeDb(3000);
    const quote = quoteOf(db, uid, ALL);
    expect(defaultSelection(quote, payload({ relation_count: 0 }), null)).not.toContain('graph');
    db.close();
  });

  /**
   * 变异臂：把 `.filter(… !alreadyPaid)` 那一层删掉，这条会红。
   * 已付过的块默认再勾一次，合计里它是 0 元、看着无害，可它跟着进 confirm 的 modules——
   * 把「买过了」显示成「这次也要买」。
   */
  it('已经买过的块不进默认勾选（哪怕它 0 元、看着无害）', () => {
    const { db, uid } = makeDb(3000);
    const quote = quoteOf(db, uid, ALL);
    const paid: DossierQuote = {
      ...quote,
      items: quote.items.map((it) =>
        it.module === 'entity' ? { ...it, alreadyPaid: true, gongdao: 0 } : it,
      ),
    };
    expect(defaultSelection(paid, payload(), null)).not.toContain('entity');
    db.close();
  });
});

/* ── 报价过期：确认按钮唯一的静默失效点 ───────────────── */

describe('输入框改过而没重新查 ⇒ 屏幕上那份价是上一家的', () => {
  const KEY = subjectKey('甲公司', '');

  it('还没报过价时不算过期（按钮不该因为"没查"而失效）', () => {
    expect(isQuoteStale(null, '', '甲公司', '')).toBe(false);
    expect(isQuoteStale(null, KEY, '乙公司', '')).toBe(false);
  });

  /**
   * 变异臂：把 OrderQuote 的 disabled 里 `stale` 那一项删掉，本仓 2026-08-31 实测
   * 2656 条测试照样全绿——这条与它的渲染孪生（order-honesty 的 disabled 断言）就是补上的那颗牙。
   */
  it('公司名或代码改过 ⇒ 过期；改回去 ⇒ 又不过期', () => {
    const quote = { items: [] } as unknown as DossierQuote;
    expect(isQuoteStale(quote, KEY, '甲公司', '')).toBe(false);
    expect(isQuoteStale(quote, KEY, '乙公司', '')).toBe(true);
    // 名字没动、只补了统一社会信用代码：认的主体变了（uscc 优先），同样算过期
    expect(isQuoteStale(quote, KEY, '甲公司', '91110000X')).toBe(true);
    expect(isQuoteStale(quote, KEY, '甲公司', '')).toBe(false);
  });

  it('只差首尾空白不算改（粘贴带进来的空格不该逼用户重查一次）', () => {
    const quote = { items: [] } as unknown as DossierQuote;
    expect(isQuoteStale(quote, KEY, '  甲公司 ', '  ')).toBe(false);
  });
});
