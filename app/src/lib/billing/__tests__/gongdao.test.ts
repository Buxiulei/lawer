// app/src/lib/billing/__tests__/gongdao.test.ts
// 公道值账本核心行为锁死（钱的地基）：入账/结算/退款/幂等/透支入负/门槛/管理员调整/记账。
// 核心函数末位注入 :memory: db（无需 getDb 单例）。
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate';
import {
  canStartTurn,
  getGongdao,
  gongdaoExhaustedMessage,
  gongdaoGate,
  gongdaoGrant,
  gongdaoSettle,
  gongdaoRefund,
  adminAdjustGongdao,
  recordTokenUsage,
} from '../index';
import { GONGDAO_LEDGER_TYPE } from '../pricing';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(
    db.prepare('INSERT INTO users (email) VALUES (?)').run('t@t.com').lastInsertRowid,
  );
  return { db, uid };
}

/** 对账：gongdao.balance 必须恒等于 gongdao_ledger delta 之和（唯一事实源不变式）。 */
function ledgerSum(db: Database.Database, uid: number): number {
  return (
    db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM gongdao_ledger WHERE user_id=?').get(uid) as { s: number }
  ).s;
}

describe('gongdaoGrant 入账', () => {
  test('入账：余额增、流水记正 delta，balance == SUM(ledger)', () => {
    const { db, uid } = makeDb();
    expect(gongdaoGrant(uid, 3000, GONGDAO_LEDGER_TYPE.membership, 'order-1', null, db)).toBe(true);
    expect(getGongdao(uid, db)).toBe(3000);
    expect(ledgerSum(db, uid)).toBe(3000);
  });

  test('幂等：同 (type, refId) 二次入账被唯一索引挡下，余额只加一次', () => {
    const { db, uid } = makeDb();
    expect(gongdaoGrant(uid, 500, GONGDAO_LEDGER_TYPE.recharge, 'pay-9', null, db)).toBe(true);
    expect(gongdaoGrant(uid, 500, GONGDAO_LEDGER_TYPE.recharge, 'pay-9', null, db)).toBe(false);
    expect(getGongdao(uid, db)).toBe(500);
    const n = (db.prepare("SELECT COUNT(*) c FROM gongdao_ledger WHERE ref_id='pay-9'").get() as { c: number }).c;
    expect(n).toBe(1);
  });

  test('refId=null 不去重：每次都入账', () => {
    const { db, uid } = makeDb();
    expect(gongdaoGrant(uid, 100, GONGDAO_LEDGER_TYPE.register, null, null, db)).toBe(true);
    expect(gongdaoGrant(uid, 100, GONGDAO_LEDGER_TYPE.register, null, null, db)).toBe(true);
    expect(getGongdao(uid, db)).toBe(200);
  });

  test('非正 delta 被拒（不写库、不改余额）', () => {
    const { db, uid } = makeDb();
    expect(gongdaoGrant(uid, 0, GONGDAO_LEDGER_TYPE.recharge, 'z', null, db)).toBe(false);
    expect(gongdaoGrant(uid, -5, GONGDAO_LEDGER_TYPE.recharge, 'z2', null, db)).toBe(false);
    expect(getGongdao(uid, db)).toBe(0);
    expect(ledgerSum(db, uid)).toBe(0);
  });

  test('meta 落 meta_json', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 50, GONGDAO_LEDGER_TYPE.recharge, 'm-1', { amountFen: 5000 }, db);
    const row = db.prepare("SELECT meta_json FROM gongdao_ledger WHERE ref_id='m-1'").get() as { meta_json: string };
    expect(JSON.parse(row.meta_json)).toEqual({ amountFen: 5000 });
  });
});

describe('gongdaoSettle 结算', () => {
  test('原子扣减：余额减、流水记负 delta、feature 落库', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 100, GONGDAO_LEDGER_TYPE.register, null, null, db);
    gongdaoSettle(uid, 23, 'intake-1', 'intake', null, db);
    expect(getGongdao(uid, db)).toBe(77);
    expect(ledgerSum(db, uid)).toBe(77);
    const row = db.prepare("SELECT delta, feature, type FROM gongdao_ledger WHERE ref_id='intake-1'").get() as
      { delta: number; feature: string; type: string };
    expect(row).toEqual({ delta: -23, feature: 'intake', type: GONGDAO_LEDGER_TYPE.consume });
  });

  test('幂等：同 refId 二次结算只扣一次', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 100, GONGDAO_LEDGER_TYPE.register, null, null, db);
    gongdaoSettle(uid, 30, 'job-x', 'draft', null, db);
    gongdaoSettle(uid, 30, 'job-x', 'draft', null, db); // 重放：唯一索引挡下
    expect(getGongdao(uid, db)).toBe(70);
    const n = (db.prepare("SELECT COUNT(*) c FROM gongdao_ledger WHERE ref_id='job-x'").get() as { c: number }).c;
    expect(n).toBe(1);
  });

  test('透支软拦截：余额 5 结算 23 → -18，随后 gate 拦截', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 5, GONGDAO_LEDGER_TYPE.register, null, null, db);
    expect(gongdaoGate(uid, db)).toBe(true);
    gongdaoSettle(uid, 23, 'last', 'intake', null, db);
    expect(getGongdao(uid, db)).toBe(-18);
    expect(ledgerSum(db, uid)).toBe(-18);
    expect(gongdaoGate(uid, db)).toBe(false); // 负余额被 gate 拦
  });

  test('cost=0（失败无消耗）：落幂等标记但余额不变', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 100, GONGDAO_LEDGER_TYPE.register, null, null, db);
    gongdaoSettle(uid, 0, 'fail-0', 'intake', null, db);
    expect(getGongdao(uid, db)).toBe(100);
    const row = db.prepare("SELECT delta FROM gongdao_ledger WHERE ref_id='fail-0'").get() as { delta: number };
    expect(row.delta).toBe(0); // 幂等标记行
  });

  test('结算用户尚无 gongdao 行：UPSERT 建行入负', () => {
    const { db, uid } = makeDb();
    gongdaoSettle(uid, 10, 'no-row', 'intake', null, db);
    expect(getGongdao(uid, db)).toBe(-10);
  });
});

describe('gongdaoRefund 定额退款', () => {
  test('退还并回补余额，流水 type=退款、ref=refund-<chargeRef>', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 3000, GONGDAO_LEDGER_TYPE.membership, 'o-1', null, db);
    gongdaoSettle(uid, 2000, 'attest-7', 'attest', null, db); // 定额预扣
    expect(gongdaoRefund(uid, 2000, 'attest-7', 'attest', db)).toBe(true);
    expect(getGongdao(uid, db)).toBe(3000);
    const row = db.prepare("SELECT delta, type, feature FROM gongdao_ledger WHERE ref_id='refund-attest-7'").get() as
      { delta: number; type: string; feature: string };
    expect(row).toEqual({ delta: 2000, type: GONGDAO_LEDGER_TYPE.refund, feature: 'attest' });
  });

  test('幂等：同 chargeRef 只退一次', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 3000, GONGDAO_LEDGER_TYPE.membership, 'o-1', null, db);
    gongdaoSettle(uid, 1000, 'export-3', 'export', null, db);
    expect(gongdaoRefund(uid, 1000, 'export-3', 'export', db)).toBe(true);
    expect(gongdaoRefund(uid, 1000, 'export-3', 'export', db)).toBe(false);
    expect(getGongdao(uid, db)).toBe(3000);
    expect(ledgerSum(db, uid)).toBe(3000);
    const n = (db.prepare("SELECT COUNT(*) c FROM gongdao_ledger WHERE ref_id='refund-export-3'").get() as { c: number }).c;
    expect(n).toBe(1);
  });

  test('amount 非正：不写库、返回 false', () => {
    const { db, uid } = makeDb();
    expect(gongdaoRefund(uid, 0, 'x', 'export', db)).toBe(false);
    expect(gongdaoRefund(uid, -10, 'y', 'export', db)).toBe(false);
    expect(ledgerSum(db, uid)).toBe(0);
  });
});

describe('gongdaoGate 门槛', () => {
  test('无行=0 → false；≥1 → true；=0 → false', () => {
    const { db, uid } = makeDb();
    expect(gongdaoGate(uid, db)).toBe(false); // 无行
    gongdaoGrant(uid, 1, GONGDAO_LEDGER_TYPE.register, null, null, db);
    expect(gongdaoGate(uid, db)).toBe(true);
    gongdaoSettle(uid, 1, 'g', 'intake', null, db);
    expect(getGongdao(uid, db)).toBe(0);
    expect(gongdaoGate(uid, db)).toBe(false); // =0 不足
  });
});

/**
 * 对话闸的唯一入口（主理人 2026-09-03「拦」第 5 条）。路由只调它、不自己读表，
 * 所以门槛的边界得在这一层逐分钱地钉住——路由那边的判据验的是"拦没拦"，
 * 验不出"门槛是几"（那要靠一个恰好卡在边界上的余额）。
 *
 * 【变异臂】
 *  · M-G2 门槛写成 `balance >= 0` ⇒「余额 0 拦」红
 *  · M-G8 门槛写成 `balance > 1`  ⇒「余额 1 放行」红
 *  · M-G9 canStartTurn 不回 balance（只回 bool）⇒ 编译期就断（402 文案说不出余额）
 */
describe('canStartTurn 对话闸', () => {
  test('余额 1 放行、0 拦、-5 拦，且每次都把余额一并交出来', () => {
    const { db, uid } = makeDb();
    // 无行 = 0：拦，且报的余额就是 0（不是 undefined，也不是 null）
    expect(canStartTurn(uid, db)).toEqual({ ok: false, balance: 0 });

    gongdaoGrant(uid, 1, GONGDAO_LEDGER_TYPE.register, 'seed-1', null, db);
    expect(canStartTurn(uid, db), '1 是门槛本身，必须放行').toEqual({ ok: true, balance: 1 });

    gongdaoSettle(uid, 1, 'turn-1', 'companion', null, db);
    expect(canStartTurn(uid, db), '0 不够开新的一轮').toEqual({ ok: false, balance: 0 });

    // 透支入负（最后一单允许，之后就该被这道闸收住）
    gongdaoSettle(uid, 5, 'turn-2', 'companion', null, db);
    expect(canStartTurn(uid, db)).toEqual({ ok: false, balance: -5 });
  });

  test('gongdaoGate 是同一道判定的布尔外壳（两处门槛不许各是各的）', () => {
    const { db, uid } = makeDb();
    for (const amount of [0, 1, 2, 300]) {
      if (amount > 0) gongdaoGrant(uid, amount, GONGDAO_LEDGER_TYPE.recharge, `g-${amount}`, null, db);
      expect(gongdaoGate(uid, db)).toBe(canStartTurn(uid, db).ok);
    }
  });
});

describe('gongdaoExhaustedMessage 拦下时说的那句话', () => {
  test('自述三段式：余额多少 / 为什么缺 / 怎么办，且余额是传进来的那个数', () => {
    for (const balance of [0, -5, -1200]) {
      const message = gongdaoExhaustedMessage(balance);
      expect(message, `balance=${balance}`).toContain(`余额 ${balance}`);
      expect(message).toContain('token'); // 为什么缺
      expect(message).toContain('兑换'); // 怎么办①
      expect(message).toContain('充值'); // 怎么办②
    }
  });
});

describe('adminAdjustGongdao 管理员调整（不可致负）', () => {
  test('正负均可、备注入 meta_json、每次都记（不去重）', () => {
    const { db, uid } = makeDb();
    expect(adminAdjustGongdao(uid, 200, '客诉补偿', db)).toEqual({ ok: true, balance: 200 });
    expect(adminAdjustGongdao(uid, -50, '误发扣回', db)).toEqual({ ok: true, balance: 150 });
    expect(getGongdao(uid, db)).toBe(150);
    expect(ledgerSum(db, uid)).toBe(150);
    const rows = db.prepare('SELECT delta, meta_json FROM gongdao_ledger WHERE type=? ORDER BY id')
      .all(GONGDAO_LEDGER_TYPE.admin) as { delta: number; meta_json: string }[];
    expect(rows.map((r) => r.delta)).toEqual([200, -50]);
    expect(JSON.parse(rows[0].meta_json)).toEqual({ note: '客诉补偿' });
  });

  test('余额 100 时 -200 被拒：不写任何流水、余额不变', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 100, GONGDAO_LEDGER_TYPE.register, 'reg', null, db);
    expect(adminAdjustGongdao(uid, -200, '扣罚', db)).toEqual({ ok: false, balance: 100 });
    expect(getGongdao(uid, db)).toBe(100);
    const n = (db.prepare('SELECT COUNT(*) c FROM gongdao_ledger WHERE type=?').get(GONGDAO_LEDGER_TYPE.admin) as { c: number }).c;
    expect(n).toBe(0);
  });

  test('余额 100 时 -100 成功扣到 0（边界含等号）', () => {
    const { db, uid } = makeDb();
    gongdaoGrant(uid, 100, GONGDAO_LEDGER_TYPE.register, 'reg', null, db);
    expect(adminAdjustGongdao(uid, -100, '扣罚', db)).toEqual({ ok: true, balance: 0 });
    expect(getGongdao(uid, db)).toBe(0);
    expect(ledgerSum(db, uid)).toBe(0);
  });

  test('已透支入负时，任何负向调整都被拒（不许雪上加霜）', () => {
    const { db, uid } = makeDb();
    gongdaoSettle(uid, 50, 'overdraft', 'intake', null, db); // 余额 -50
    expect(adminAdjustGongdao(uid, -1, '再扣', db)).toEqual({ ok: false, balance: -50 });
    // 正向调整仍可（把负余额补回来）
    expect(adminAdjustGongdao(uid, 50, '补回', db)).toEqual({ ok: true, balance: 0 });
  });

  test('delta=0：不写流水、返回 ok:false', () => {
    const { db, uid } = makeDb();
    expect(adminAdjustGongdao(uid, 0, '空调整', db)).toEqual({ ok: false, balance: 0 });
    expect(ledgerSum(db, uid)).toBe(0);
  });
});

describe('recordTokenUsage 记账', () => {
  test('写 token_usage：四档 token 明细 + cost_li 精确换算（无费率行走 DEFAULT_RATES）', () => {
    const { db, uid } = makeDb();
    recordTokenUsage(
      uid,
      'intake',
      'unconfigured-model',
      { promptTokens: 10000, completionTokens: 3000, cacheReadTokens: 20000, cacheWriteTokens: 4000, embedTokens: 900 },
      'intake-1',
      null,
      db,
    );
    const row = db.prepare('SELECT * FROM token_usage WHERE ref_id=?').get('intake-1') as {
      prompt_tokens: number; completion_tokens: number; cache_read_tokens: number;
      cache_write_tokens: number; embed_tokens: number; cost_li: number; feature: string; model: string;
    };
    expect(row.prompt_tokens).toBe(10000);
    expect(row.completion_tokens).toBe(3000);
    expect(row.cache_read_tokens).toBe(20000);
    expect(row.cache_write_tokens).toBe(4000);
    expect(row.embed_tokens).toBe(900);
    // 兜底费率手算：10000×0.0009 + 3000×0.0027 + 20000×0.00003 + 4000×0.0009 + 900×0.0009
    //             = 9 + 8.1 + 0.6 + 3.6 + 0.81 = 22.11
    expect(row.cost_li).toBe(22110);
    expect(row.feature).toBe('intake');
    expect(row.model).toBe('unconfigured-model');
  });
});

describe('ledger 唯一索引直插防重（DB 层兜底）', () => {
  test('同 (type, ref_id) 直接 INSERT 第二条抛 UNIQUE 约束', () => {
    const { db, uid } = makeDb();
    db.prepare("INSERT INTO gongdao_ledger (user_id, delta, type, ref_id) VALUES (?,?, '消耗','dup')").run(uid, -1);
    expect(() =>
      db.prepare("INSERT INTO gongdao_ledger (user_id, delta, type, ref_id) VALUES (?,?, '消耗','dup')").run(uid, -1),
    ).toThrow();
    // 不同 type 同 ref_id 允许（唯一键是 (type, ref_id) 组合）
    expect(() =>
      db.prepare("INSERT INTO gongdao_ledger (user_id, delta, type, ref_id) VALUES (?,?, '充值','dup')").run(uid, 1),
    ).not.toThrow();
    // ref_id=NULL 不受约束，可多行
    expect(() => {
      db.prepare("INSERT INTO gongdao_ledger (user_id, delta, type, ref_id) VALUES (?,?, '管理员调整', NULL)").run(uid, 1);
      db.prepare("INSERT INTO gongdao_ledger (user_id, delta, type, ref_id) VALUES (?,?, '管理员调整', NULL)").run(uid, 1);
    }).not.toThrow();
  });
});
