// app/src/lib/billing/__tests__/service-quotes.test.ts
// 耗算力服务的报价→确认→扣费。要害六条（与 dossier-billing 同构，判据逐条对齐）：
//   ① 报价绝不动钱（余额、gongdao_ledger 行数逐字不变；service_quotes 多一行是它唯一的写入）
//   ② 确认幂等：同一张报价二次确认不二扣，且回包必须说清「这次没扣」（charged=0, deduped=true）
//   ③ 过期报价一律 QUOTE_EXPIRED，且不扣任何费用
//   ④ 余额不足回 GONGDAO_EXHAUSTED，文案与网页那条**逐字同源**（gongdaoExhaustedMessage）
//   ⑤ 会员券可抵：核销留痕在 service_quotes.entitlement_id 与 entitlements.consumed_ref 两处
//   ⑥ 别人的报价、别人的案件一律 404，不区分「不存在」与「不是你的」
import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../db/migrate';
import { getGongdao, gongdaoExhaustedMessage, gongdaoGrant } from '../index';
import { GONGDAO_LEDGER_TYPE } from '../pricing';
import { PRICE_FALLBACK } from '../pricing-config';
import { ENTITLEMENT_KIND, grantEntitlement } from '../entitlements';
import { FEATURE_LABELS } from '../features';
import {
  PRICED_SERVICES,
  SERVICE_FEATURE,
  confirmService,
  quoteService,
  serviceChargeRef,
  unitsFromSeconds,
  type PricedService,
} from '../service-quotes';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('a@t.com').lastInsertRowid);
  const other = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('b@t.com').lastInsertRowid);
  const caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '本人案件').lastInsertRowid,
  );
  const otherCase = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(other, '别人的案件').lastInsertRowid,
  );
  return { db, uid, other, caseId, otherCase };
}

function topUp(db: Database.Database, uid: number, amount: number) {
  gongdaoGrant(uid, amount, GONGDAO_LEDGER_TYPE.recharge, `top-${uid}-${amount}`, null, db);
}

function snapshot(db: Database.Database, uid: number) {
  return {
    balance: getGongdao(uid, db),
    ledgerRows: (db.prepare('SELECT COUNT(*) AS n FROM gongdao_ledger').get() as { n: number }).n,
  };
}

function mustOk<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`期望成功，实得失败：${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

function mustFail<T extends { ok: boolean }>(r: T): Extract<T, { ok: false }> {
  if (r.ok) throw new Error(`期望失败，实得成功：${JSON.stringify(r)}`);
  return r as Extract<T, { ok: false }>;
}

/** 把某张报价的到期点改到过去（不动别的列），造「报价过期」这一态。 */
function expire(db: Database.Database, quoteId: number) {
  db.prepare("UPDATE service_quotes SET expires_at='2000-01-01 00:00:00' WHERE id=?").run(quoteId);
}

const OCR_PER_PAGE = PRICE_FALLBACK['ocr.per_page'];

describe('计价口径', () => {
  test('五个可计价服务各自读自己的键，单价×数量即报价额', () => {
    const { db, uid, caseId } = makeDb();
    const expected: Record<PricedService, number> = {
      ocr: PRICE_FALLBACK['ocr.per_page'],
      asr: PRICE_FALLBACK['asr.per_minute'],
      video: PRICE_FALLBACK['video.per_minute'],
      doc_review: PRICE_FALLBACK['doc_review.per_doc'],
      brief: PRICE_FALLBACK['brief.per_item'],
    };
    for (const service of PRICED_SERVICES) {
      const r = mustOk(quoteService(db, { userId: uid, caseId, service, payload: { units: 3 } }));
      expect(r.quote.breakdown.unitPrice, service).toBe(expected[service]);
      expect(r.quote.amount, service).toBe(expected[service] * 3);
      // 中文名只有一处事实源（features），报价页与账单不会各叫各的
      expect(r.quote.breakdown.label, service).toBe(FEATURE_LABELS[SERVICE_FEATURE[service]]);
    }
  });

  test('改 pricing_config 即刻生效，不必改代码不必重启', () => {
    const { db, uid, caseId } = makeDb();
    db.prepare('INSERT OR REPLACE INTO pricing_config (key, value_int) VALUES (?,?)').run('ocr.per_page', 99);
    const r = mustOk(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units: 2 } }));
    expect(r.quote.amount).toBe(198);
  });

  test('分钟取整只有一处口径：不足一分钟按一分钟，89 秒是 2 分钟', () => {
    expect(unitsFromSeconds(1)).toBe(1);
    expect(unitsFromSeconds(60)).toBe(1);
    expect(unitsFromSeconds(61)).toBe(2);
    expect(unitsFromSeconds(89)).toBe(2);
    expect(unitsFromSeconds(0)).toBe(1);
  });

  test('数量不是正整数一律 400，不静默按 1 报价', () => {
    const { db, uid, caseId } = makeDb();
    for (const units of [0, -1, 1.5, Number.NaN]) {
      const f = mustFail(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units } }));
      expect(f.errorCode, `units=${units}`).toBe('INVALID_UNITS');
      expect(f.status).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_quotes').get()).toEqual({ n: 0 });
  });
});

describe('① 报价绝不动钱', () => {
  test('报价前后余额与账本行数逐字相等，只多一行 service_quotes', () => {
    const { db, uid, caseId } = makeDb();
    topUp(db, uid, 1000);
    const before = snapshot(db, uid);

    const r = mustOk(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units: 4 } }));
    expect(r.quote.amount).toBe(OCR_PER_PAGE * 4);

    expect(snapshot(db, uid)).toEqual(before);
    const row = db.prepare('SELECT * FROM service_quotes WHERE id=?').get(r.quote.quoteId) as {
      confirmed_at: string | null;
      order_ref: string | null;
      entitlement_id: number | null;
      payload_json: string;
    };
    // 未确认的报价不带任何扣费痕迹——带了就说明有人在报价里扣了钱
    expect(row.confirmed_at).toBeNull();
    expect(row.order_ref).toBeNull();
    expect(row.entitlement_id).toBeNull();
    // 计价入参原样留存，事后能复算这个价
    expect(JSON.parse(row.payload_json)).toEqual({ units: 4 });
  });

  test('余额为 0 也能报价（报价免费，余额闸只在确认时判）', () => {
    const { db, uid, caseId } = makeDb();
    expect(getGongdao(uid, db)).toBe(0);
    const r = mustOk(quoteService(db, { userId: uid, caseId, service: 'asr', payload: { units: 10 } }));
    expect(r.quote.amount).toBeGreaterThan(0);
  });
});

describe('② 确认扣费与幂等', () => {
  test('确认扣一次；同一张报价二次确认不二扣，且回包写明这次没扣', () => {
    const { db, uid, caseId } = makeDb();
    topUp(db, uid, 1000);
    const q = mustOk(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units: 4 } })).quote;

    const first = mustOk(confirmService(db, uid, q.quoteId));
    expect(first.charged).toBe(q.amount);
    expect(first.deduped).toBe(false);
    expect(first.paidBy).toBe('gongdao');
    expect(first.orderRef).toBe(serviceChargeRef(q.quoteId, uid));
    expect(getGongdao(uid, db)).toBe(1000 - q.amount);
    const afterFirst = snapshot(db, uid);

    const second = mustOk(confirmService(db, uid, q.quoteId));
    // 钱没错还不够：回包若照报 charged=q.amount，调用方就会告诉用户「已扣 20」而账上没这一笔
    expect(second.charged).toBe(0);
    expect(second.deduped).toBe(true);
    expect(second.orderRef).toBe(first.orderRef);
    expect(snapshot(db, uid)).toEqual(afterFirst);
  });

  test('扣费落在 svc- 幂等键与登记过的 feature 上（用量明细不出「其他」）', () => {
    const { db, uid, caseId } = makeDb();
    topUp(db, uid, 1000);
    const q = mustOk(quoteService(db, { userId: uid, caseId, service: 'asr', payload: { units: 3 } })).quote;
    mustOk(confirmService(db, uid, q.quoteId));

    const rows = db
      .prepare('SELECT feature, ref_id, -delta AS amount FROM gongdao_ledger WHERE type=?')
      .all(GONGDAO_LEDGER_TYPE.consume) as { feature: string; ref_id: string; amount: number }[];
    expect(rows).toEqual([
      { feature: 'asr', ref_id: `svc-${q.quoteId}-u${uid}`, amount: q.amount },
    ]);
    expect(rows[0].ref_id.startsWith('svc-')).toBe(true);
    expect(FEATURE_LABELS[rows[0].feature]).toBeTruthy();
  });

  test('两张不同的报价各扣各的（幂等键含报价 id，不会互相挡掉）', () => {
    const { db, uid, caseId } = makeDb();
    topUp(db, uid, 1000);
    const a = mustOk(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units: 1 } })).quote;
    const b = mustOk(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units: 1 } })).quote;
    mustOk(confirmService(db, uid, a.quoteId));
    mustOk(confirmService(db, uid, b.quoteId));
    expect(getGongdao(uid, db)).toBe(1000 - a.amount - b.amount);
  });
});

describe('③ 过期报价', () => {
  test('过期即 409 QUOTE_EXPIRED，一分钱不扣、确认位不被占', () => {
    const { db, uid, caseId } = makeDb();
    topUp(db, uid, 1000);
    const q = mustOk(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units: 4 } })).quote;
    expire(db, q.quoteId);
    const before = snapshot(db, uid);

    const f = mustFail(confirmService(db, uid, q.quoteId));
    expect(f.errorCode).toBe('QUOTE_EXPIRED');
    expect(f.status).toBe(409);
    // 自述三段式：怎么办那一段必须说清「重新报价免费」，否则用户以为白花了一次钱
    expect(f.message).toContain('重新报');
    expect(snapshot(db, uid)).toEqual(before);
    expect(
      db.prepare('SELECT confirmed_at FROM service_quotes WHERE id=?').get(q.quoteId),
    ).toEqual({ confirmed_at: null });
  });

  test('已确认的报价过期后二次确认仍判重放，不改判成 QUOTE_EXPIRED', () => {
    const { db, uid, caseId } = makeDb();
    topUp(db, uid, 1000);
    const q = mustOk(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units: 1 } })).quote;
    mustOk(confirmService(db, uid, q.quoteId));
    expire(db, q.quoteId);
    const again = mustOk(confirmService(db, uid, q.quoteId));
    expect(again.deduped).toBe(true);
    expect(again.charged).toBe(0);
  });
});

describe('④ 余额不足', () => {
  test('余额不足回 402 GONGDAO_EXHAUSTED，文案与网页那条逐字同源；不扣不占位', () => {
    const { db, uid, caseId } = makeDb();
    topUp(db, uid, 3); // 报的是 4 页 × 单价，肯定不够
    const q = mustOk(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units: 4 } })).quote;
    const before = snapshot(db, uid);

    const f = mustFail(confirmService(db, uid, q.quoteId));
    expect(f.status).toBe(402);
    expect(f.errorCode).toBe('GONGDAO_EXHAUSTED');
    // 不是「长得像」，是同一个函数产出的同一句话——网页改文案，这里跟着改
    expect(f.message).toBe(gongdaoExhaustedMessage(3));

    expect(snapshot(db, uid)).toEqual(before);
    // 余额闸在事务内、扣费之前：抢占的确认标记必须跟着回滚，不留「已确认未付」的行
    expect(
      db.prepare('SELECT confirmed_at, order_ref FROM service_quotes WHERE id=?').get(q.quoteId),
    ).toEqual({ confirmed_at: null, order_ref: null });
  });

  test('补足余额后同一张报价可以确认成功（上一次失败没把它作废）', () => {
    const { db, uid, caseId } = makeDb();
    const q = mustOk(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units: 4 } })).quote;
    mustFail(confirmService(db, uid, q.quoteId));
    topUp(db, uid, 1000);
    const ok = mustOk(confirmService(db, uid, q.quoteId));
    expect(ok.charged).toBe(q.amount);
  });
});

describe('⑤ 会员券抵扣', () => {
  test('有券即核销、不扣公道值；两处同时留痕，且照落一条 delta=0 标记行', () => {
    const { db, uid, caseId } = makeDb();
    topUp(db, uid, 1000);
    grantEntitlement(db, uid, ENTITLEMENT_KIND.serviceExtract, 'ord-x');
    const q = mustOk(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units: 4 } })).quote;

    const r = mustOk(confirmService(db, uid, q.quoteId));
    expect(r.paidBy).toBe('entitlement');
    expect(r.charged).toBe(0);
    expect(r.amount).toBe(q.amount); // 原价照记：「多少钱的服务被券抵了」是对账要的数
    expect(getGongdao(uid, db)).toBe(1000);

    // 留痕一：报价行上记着核销掉的券
    expect(
      db.prepare('SELECT entitlement_id FROM service_quotes WHERE id=?').get(q.quoteId),
    ).toEqual({ entitlement_id: r.entitlementId });
    // 留痕二：券上记着用去了哪
    expect(
      db.prepare('SELECT consumed_ref FROM entitlements WHERE id=?').get(r.entitlementId),
    ).toEqual({ consumed_ref: serviceChargeRef(q.quoteId, uid) });
    // 「这单买过没有」对券付与钱付是同一个判据：都有那笔流水（券付 delta=0）
    expect(
      db.prepare('SELECT delta FROM gongdao_ledger WHERE ref_id=?').get(serviceChargeRef(q.quoteId, uid)),
    ).toEqual({ delta: 0 });
  });

  test('券只抵一单：第二张报价照常扣钱（不静默免单）', () => {
    const { db, uid, caseId } = makeDb();
    topUp(db, uid, 1000);
    grantEntitlement(db, uid, ENTITLEMENT_KIND.serviceExtract, 'ord-x');
    const a = mustOk(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units: 4 } })).quote;
    const b = mustOk(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units: 4 } })).quote;
    mustOk(confirmService(db, uid, a.quoteId));
    const second = mustOk(confirmService(db, uid, b.quoteId));
    expect(second.paidBy).toBe('gongdao');
    expect(second.charged).toBe(b.amount);
    expect(getGongdao(uid, db)).toBe(1000 - b.amount);
  });
});

describe('⑥ 归属闸', () => {
  test('给别人的案件报价一律 CASE_NOT_FOUND，不落行', () => {
    const { db, uid, otherCase } = makeDb();
    const f = mustFail(
      quoteService(db, { userId: uid, caseId: otherCase, service: 'ocr', payload: { units: 1 } }),
    );
    expect(f.errorCode).toBe('CASE_NOT_FOUND');
    expect(f.status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_quotes').get()).toEqual({ n: 0 });
  });

  test('确认别人的报价一律 QUOTE_NOT_FOUND，且不动那张报价', () => {
    const { db, uid, other, caseId } = makeDb();
    topUp(db, other, 1000);
    const q = mustOk(quoteService(db, { userId: uid, caseId, service: 'ocr', payload: { units: 1 } })).quote;
    const f = mustFail(confirmService(db, other, q.quoteId));
    expect(f.errorCode).toBe('QUOTE_NOT_FOUND');
    expect(f.status).toBe(404);
    expect(getGongdao(other, db)).toBe(1000);
    expect(
      db.prepare('SELECT confirmed_at FROM service_quotes WHERE id=?').get(q.quoteId),
    ).toEqual({ confirmed_at: null });
  });

  test('不存在的报价号同码同待遇（不能拿它探测别人下过什么单）', () => {
    const { db, uid } = makeDb();
    expect(mustFail(confirmService(db, uid, 999_999)).errorCode).toBe('QUOTE_NOT_FOUND');
  });
});
