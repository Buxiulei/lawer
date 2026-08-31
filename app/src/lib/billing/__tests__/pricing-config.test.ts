// app/src/lib/billing/__tests__/pricing-config.test.ts
// 价目配置表：表命中即为准 / 缺行回落常量 / 非法值不静默 / 改价立刻生效 / 服务名绝不出现在 skus。
//
// 本文件覆盖 pricing_config 的**两个读函数**（合并自计费侧与采集管线侧两支）：
//   readPrice(db, key)         —— 键登记在 PRICE_FALLBACK，兜底随键走，负值/小数当场抛；
//   readConfigInt(db, key, fb) —— 兜底由调用方显式给，非整数当场抛。
// 两侧共读的键，其兜底值必须一致——文件末尾那条机检就是干这个的。
import { describe, expect, it, test } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '../../db/migrate';
import {
  PRICE_FALLBACK,
  PRICE_KEYS,
  readConfigInt,
  readPrice,
  type PriceKey,
} from '../pricing-config';
import { DEFAULT_MIN_SAMPLE_OUTCOME } from '@/lib/company/stats';
import { DEFAULT_PROBE_FREE_PER_DAY } from '@/lib/company/probe';
import { estimateGongdao, SEED_DEFAULT } from '../estimate';
import {
  CUSTOM_RECHARGE_SKU_NAME,
  MEMBERSHIP_SKU_NAME,
  ensureBillingSkus,
} from '../fulfillment';
import { DOSSIER_MODULE_FEATURE, modulePrice } from '@/lib/company/dossier-billing';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function setPrice(db: Database.Database, key: string, value: number): void {
  db.prepare('INSERT OR REPLACE INTO pricing_config (key, value_int) VALUES (?,?)').run(key, value);
}

describe('readPrice · 表命中即为准，缺行回落常量', () => {
  test('空表 → 全部键回落代码常量', () => {
    const db = makeDb();
    expect(db.prepare('SELECT COUNT(*) AS n FROM pricing_config').get()).toEqual({ n: 0 });
    for (const key of PRICE_KEYS) {
      expect(readPrice(db, key), `键「${key}」未回落常量`).toBe(PRICE_FALLBACK[key]);
    }
  });

  test('写一行即以表为准；删掉该行立刻回落常量（同一个进程内，无需重启）', () => {
    const db = makeDb();
    setPrice(db, 'dossier.graph', 999);
    expect(readPrice(db, 'dossier.graph')).toBe(999);
    db.prepare("DELETE FROM pricing_config WHERE key='dossier.graph'").run();
    expect(readPrice(db, 'dossier.graph')).toBe(PRICE_FALLBACK['dossier.graph']);
  });

  test('改一个键不影响别的键', () => {
    const db = makeDb();
    setPrice(db, 'dossier.entity', 1);
    expect(readPrice(db, 'dossier.entity')).toBe(1);
    expect(readPrice(db, 'dossier.graph')).toBe(PRICE_FALLBACK['dossier.graph']);
  });

  test('0 是合法值，不能被当成「没配」而回落常量（守望·存档档位恒 0 就靠这条）', () => {
    const db = makeDb();
    setPrice(db, 'dossier.graph', 0);
    expect(readPrice(db, 'dossier.graph')).toBe(0);
    // 反向臂：真的删掉那行才回落，不然「配成 0」与「没配」就分不开了
    expect(readPrice(db, 'watch.tier.archive')).toBe(0); // 兜底本就是 0
    setPrice(db, 'watch.tier.archive', 5);
    expect(readPrice(db, 'watch.tier.archive')).toBe(5);
  });
});

describe('readPrice · 非法值不静默', () => {
  test('负值抛错而不是回落常量——静默回落会让「改错一个数」完全看不见', () => {
    const db = makeDb();
    setPrice(db, 'dossier.graph', -480);
    expect(() => readPrice(db, 'dossier.graph')).toThrow(/负值|非法/);
  });

  test('小数抛错（公道值/天数/篇数都没有小数语义）', () => {
    const db = makeDb();
    setPrice(db, 'dossier.entity', 60.5);
    expect(() => readPrice(db, 'dossier.entity')).toThrow(/非法/);
  });

  test('错误文案三段式：缺什么 / 为什么不行 / 怎么办', () => {
    const db = makeDb();
    setPrice(db, 'dossier.docs_stats_per_doc', -1);
    let message = '';
    try {
      readPrice(db, 'dossier.docs_stats_per_doc');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('dossier.docs_stats_per_doc'); // 缺什么：哪个键
    expect(message).toContain('-1'); // 缺什么：实际值
    expect(message).toMatch(/反向给用户加钱|负数/); // 为什么不行
    expect(message).toMatch(/删掉该行|改成合法值/); // 怎么办
  });
});

describe('改价即时生效 · 唯一读价入口是 modulePrice', () => {
  test('改一行表，下一次算价立刻变（改价不改代码、不重启进程）', () => {
    const db = makeDb();
    expect(modulePrice(db, 'graph', 0)).toBe(PRICE_FALLBACK['dossier.graph']);
    setPrice(db, 'dossier.graph', 180);
    expect(modulePrice(db, 'graph', 0)).toBe(180);
  });

  test('按篇计价的两块也全走表：单价、cap、起价、增量单价改哪个都立刻反映', () => {
    const db = makeDb();
    setPrice(db, 'dossier.docs_stats_per_doc', 10);
    setPrice(db, 'dossier.docs_stats_cap_docs', 4);
    expect(modulePrice(db, 'docs_stats', 100)).toBe(40); // min(100,4)×10，超 cap 的不计费

    setPrice(db, 'dossier.patterns_base', 100);
    setPrice(db, 'dossier.patterns_base_docs', 2);
    setPrice(db, 'dossier.patterns_per_extra_doc', 7);
    expect(modulePrice(db, 'patterns', 100)).toBe(100 + (4 - 2) * 7); // 篇数同样先被 cap 截断
  });

  // 定额**不经估算器**：估算器答的是「按历史 token 消耗猜下一次要花多少」，
  // 而这六块是查表得来的确定价。若哪天有人把档案模块接进 estimateGongdao，
  // 这条会红——那正是要停下来想清楚的时刻（报出来的猜测数与结算实扣数不是一回事）。
  test('拿模块 feature 键去问估算器，得到的是通用兜底种子，不是这块的定额', () => {
    const db = makeDb();
    const feature = DOSSIER_MODULE_FEATURE.graph;
    expect(estimateGongdao(db, feature)).toEqual({ gongdao: SEED_DEFAULT, basis: 'seed', sampleN: 0 });
    expect(SEED_DEFAULT).not.toBe(PRICE_FALLBACK['dossier.graph']); // 两个数确实分得开，不是巧合相等
  });

  test('attest / export 有意未入表：写了同名行也不改变它们的定额', () => {
    const db = makeDb();
    setPrice(db, 'attest', 1);
    expect(estimateGongdao(db, 'attest').gongdao).toBe(2000);
  });
});

describe('结构守卫 · 服务定额绝不塞进 skus', () => {
  // 这条守的是一条真实事故路径：fulfillment.resolveSkuKind 按 name 判定 SKU 语义，
  // 未知 name 一律兜底为「散充」按 amount_fen×100 入账。往 skus 里塞一行服务档位，
  // 用户经下单路径碰到它就会被当成充值订单履约——收了钱当充值入账，服务不交付。
  const FORBIDDEN = ['档案', '守望', '背调', '谱系', '判例', '体检', '涉诉', '套路'];

  test('ensureBillingSkus 种完之后，skus 里没有任何一行含服务名', () => {
    const db = makeDb();
    ensureBillingSkus(db);
    const names = (db.prepare('SELECT name FROM skus').all() as { name: string }[]).map((r) => r.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      for (const word of FORBIDDEN) {
        expect(name, `SKU「${name}」含服务名「${word}」——服务定额必须走 pricing_config`).not.toContain(word);
      }
    }
  });

  // 对照臂：证明上面那条是活的。禁词表若写错（比如全是空串），上一条会对任何 SKU 都放行。
  test('禁词表本身有效：塞一行服务名进来必须被这套判据抓住', () => {
    const bogus = '档案·主体体检';
    expect(FORBIDDEN.some((w) => bogus.includes(w))).toBe(true);
  });

  test('SKU 全集就是三档月卡 + 散充（多出任何一行都要先想清楚它会被怎么履约）', () => {
    const db = makeDb();
    ensureBillingSkus(db);
    const names = (db.prepare('SELECT name FROM skus ORDER BY name').all() as { name: string }[])
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(
      [
        MEMBERSHIP_SKU_NAME.entry,
        MEMBERSHIP_SKU_NAME.standard,
        MEMBERSHIP_SKU_NAME.pro,
        CUSTOM_RECHARGE_SKU_NAME,
        '散充·10元',
        '散充·30元',
        '散充·50元',
      ].sort(),
    );
  });
});

describe('键表完整性', () => {
  test('PRICE_KEYS 与 PRICE_FALLBACK 同源，且每个键都有非负整数兜底', () => {
    expect(PRICE_KEYS.sort()).toEqual((Object.keys(PRICE_FALLBACK) as PriceKey[]).sort());
    for (const key of PRICE_KEYS) {
      const v = PRICE_FALLBACK[key];
      expect(Number.isInteger(v), `键「${key}」兜底值不是整数`).toBe(true);
      expect(v, `键「${key}」兜底值为负`).toBeGreaterThanOrEqual(0);
    }
  });

  test('六个模块的计价所需的键一个不缺（缺一个就编译不过，这里再钉一遍值域）', () => {
    for (const key of [
      'dossier.venue',
      'dossier.entity',
      'dossier.graph',
      'dossier.docs_list',
      'dossier.docs_stats_per_doc',
      'dossier.docs_stats_cap_docs',
      'dossier.patterns_base',
      'dossier.patterns_base_docs',
      'dossier.patterns_per_extra_doc',
    ] as PriceKey[]) {
      expect(PRICE_KEYS, `计价键「${key}」不在表里`).toContain(key);
    }
    // M1 恒 0 是产品承诺（信任锚：预生成辖区卡，用户侧零 LLM 调用）
    expect(PRICE_FALLBACK['dossier.venue']).toBe(0);
  });
});

// ───────────────── readConfigInt（采集管线侧的读法）─────────────────
// 判据：表里有行取表、缺行回落**调用方给的**兜底、改表立刻生效、脏值当场炸。
describe('readConfigInt', () => {
  it('缺行回落调用方给的兜底值', () => {
    const db = makeDb();
    expect(readConfigInt(db, 'dossier.graph', 480)).toBe(480);
    db.close();
  });

  it('有行以表为准，且改表**不重启进程**即刻生效', () => {
    const db = makeDb();
    db.prepare('INSERT INTO pricing_config (key, value_int) VALUES (?,?)').run('dossier.graph', 999);
    expect(readConfigInt(db, 'dossier.graph', 480)).toBe(999);

    db.prepare('UPDATE pricing_config SET value_int = ? WHERE key = ?').run(123, 'dossier.graph');
    expect(readConfigInt(db, 'dossier.graph', 480)).toBe(123); // 同一个进程里立刻变

    db.prepare('DELETE FROM pricing_config WHERE key = ?').run('dossier.graph');
    expect(readConfigInt(db, 'dossier.graph', 480)).toBe(480); // 删行即回落常量
    db.close();
  });

  it('非整数当场抛错（静默取整会让门槛在边界上安静失效）', () => {
    const db = makeDb();
    db.prepare('INSERT INTO pricing_config (key, value_int) VALUES (?,?)').run(
      'dossier.min_sample_outcome',
      4.7,
    );
    expect(() => readConfigInt(db, 'dossier.min_sample_outcome', 5)).toThrow(/不是整数/);
    db.close();
  });
});

// ───────────────── 两侧兜底一致（合并后新增）─────────────────
describe('结构守卫 · 同一个键在两条读路径上不能是两个数', () => {
  // 计费侧走 readPrice 取 PRICE_FALLBACK，采集管线侧走 readConfigInt 取自己模块里的常量。
  // 表里有行时两边一致（同一行）；**表空着时才见真章**——两处兜底一旦分叉，
  // 「按几篇算够样本」在退款判定与统计判定上就是两个数，而且线上什么都不会报错。
  test('dossier.min_sample_outcome：退款侧与统计侧兜底相等', () => {
    expect(DEFAULT_MIN_SAMPLE_OUTCOME).toBe(PRICE_FALLBACK['dossier.min_sample_outcome']);
  });

  test('dossier.probe_free_per_day：价目表与探测限流兜底相等', () => {
    expect(DEFAULT_PROBE_FREE_PER_DAY).toBe(PRICE_FALLBACK['dossier.probe_free_per_day']);
  });

  test('两条读路径读同一行时结果相同（表命中即同源，兜底分叉才是风险）', () => {
    const db = makeDb();
    setPrice(db, 'dossier.min_sample_outcome', 9);
    expect(readPrice(db, 'dossier.min_sample_outcome')).toBe(9);
    expect(readConfigInt(db, 'dossier.min_sample_outcome', DEFAULT_MIN_SAMPLE_OUTCOME)).toBe(9);
  });
});
