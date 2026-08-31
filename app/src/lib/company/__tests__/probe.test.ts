// 免费前置探测（§2.3）判据 + 变异核。
// 盯死四条形态约束：零 LLM、缓存命中 0 成本不占配额、限流每日 2 次、降级绝不静默返回空。
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, it, expect, vi } from 'vitest';

import { runMigrations } from '../../db/migrate';
import { companyKey } from '../normalize';
import {
  probeCompany,
  upsertProbeCache,
  countProbesToday,
  readProbeCache,
  type ProbePayload,
} from '../probe';

const T0 = '2026-08-30 12:00:00';
const T_NEXT_DAY = '2026-08-31 09:00:00';

function seed() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare("INSERT INTO users (id, auth_status) VALUES (1, '未实名')").run();
  db.prepare("INSERT INTO users (id, auth_status) VALUES (2, '未实名')").run();
  return db;
}

function payload(over: Partial<ProbePayload> = {}): ProbePayload {
  return {
    entity_matched: true,
    entity_name: '北京甲科技有限公司',
    uscc: '91110105MA0000000A',
    gs_status: '存续',
    relation_count: 5,
    relation_breakdown: { 股权: 3, 同法代: 1, 同址: 1 },
    litigation_count: 23,
    labor_count: 11,
    doc_url_count: 7,
    as_of: '2026-08-30',
    ...over,
  };
}

describe('缓存命中：0 成本、不占配额、不限次', () => {
  it('命中即返回四数字，配额一点不掉，重复查也不落事件', async () => {
    const db = seed();
    const key = companyKey({ name: '北京甲科技有限公司' });
    upsertProbeCache(db, key, payload(), { fetchedAt: '2026-08-30 10:00:00' });

    for (let i = 0; i < 5; i += 1) {
      const r = await probeCompany(db, { name: '北京甲科技有限公司', userId: 1 }, { now: T0 });
      expect(r.status).toBe('hit');
      expect(r.cache_state).toBe('fresh');
      expect(r.payload?.litigation_count).toBe(23);
      expect(r.payload?.labor_count).toBe(11);
      expect(r.payload?.doc_url_count).toBe(7);
      expect(r.quota_left).toBe(2); // 命中不占配额
    }
    expect(countProbesToday(db, 1, T0)).toBe(0); // 一次事件都没落
    db.close();
  });

  it('全角/空白变体命中同一份缓存（归一化单一入口，探测复用同一把键）', async () => {
    const db = seed();
    // 用半角无空格写缓存（键 = name:北京甲科技有限公司）
    upsertProbeCache(db, companyKey({ name: '北京甲科技有限公司' }), payload(), { fetchedAt: T0 });
    // 用「全角空格 + 前后空白」变体查：NFKC + 去空白后应归到同一把键
    const r = await probeCompany(db, { name: ' 北京　甲科技有限公司 ', userId: 1 }, { now: T0 });
    expect(r.status).toBe('hit');
    db.close();
  });

  it('繁体/后缀变体**不**命中简体缓存（合并裁决：归一化不做繁简与后缀等价）', async () => {
    // 反向臂。归一化按误差方向取保守（见 ../normalize.ts 文件头）：认不出来就当成另一家，
    // 代价是白跑一次采集；反过来误合的代价是把 B 家的数字摆给查 A 家的人看，且不报错。
    // 这条转绿成 'hit' 就意味着有人把归一化放宽了——放宽会让存量 company_key 集体改值。
    const db = seed();
    upsertProbeCache(db, companyKey({ name: '北京甲科技有限公司' }), payload(), { fetchedAt: T0 });
    const r = await probeCompany(db, { name: '北京甲科技有限責任公司', userId: 1 }, { now: T0 });
    expect(r.status).not.toBe('hit');
    db.close();
  });
});

describe('缓存过期（超 TTL）算未命中', () => {
  it('25 小时前的缓存不再命中', async () => {
    const db = seed();
    const key = companyKey({ name: '北京甲科技有限公司' });
    upsertProbeCache(db, key, payload(), { fetchedAt: '2026-08-29 09:00:00' }); // 距 T0 27h
    const r = await probeCompany(db, { name: '北京甲科技有限公司', userId: 1 }, { now: T0 });
    expect(r.status).toBe('no_collector'); // 未命中、无采集器 → 如实降级
    expect(r.cache_state).toBe('none');
    db.close();
  });
});

describe('未命中 + 无采集器：如实降级，不空不报错', () => {
  it('no_collector：给出人话理由、不返回空 payload、不占配额', async () => {
    const db = seed();
    const r = await probeCompany(db, { name: '查无此库的公司', userId: 1 }, { now: T0 });
    expect(r.status).toBe('no_collector');
    expect(r.payload).toBeUndefined();
    expect(r.reason && r.reason.length).toBeGreaterThan(0);
    expect(r.reason).toMatch(/不是「查无此公司」/); // 明确否掉「静默空=查无」的误读
    expect(r.quota_left).toBe(2); // 没采集到，不扣补贴额度
    expect(countProbesToday(db, 1, T0)).toBe(0);
    db.close();
  });
});

describe('未命中 + 采集器在场：真采一次，占配额、写缓存', () => {
  it('collected → payload + 配额 -1 + 缓存落地；再查同公司命中缓存（0 成本）', async () => {
    const db = seed();
    const collect = vi.fn(async () => payload());
    const r = await probeCompany(
      db,
      { name: '北京甲科技有限公司', userId: 1 },
      { now: T0, collect },
    );
    expect(r.status).toBe('collected');
    expect(r.payload?.litigation_count).toBe(23);
    expect(r.quota_left).toBe(1);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(countProbesToday(db, 1, T0)).toBe(1);

    const cached = readProbeCache(db, companyKey({ name: '北京甲科技有限公司' }), { now: T0 });
    expect(cached.fresh).toBe(true);
    expect(cached.payload?.doc_url_count).toBe(7);

    // 第二次查：命中缓存，采集器不再被调，配额不再掉
    const r2 = await probeCompany(
      db,
      { name: '北京甲科技有限公司', userId: 1 },
      { now: T0, collect },
    );
    expect(r2.status).toBe('hit');
    expect(collect).toHaveBeenCalledTimes(1);
    expect(r2.quota_left).toBe(1);
    db.close();
  });
});

describe('限流：登录后每用户每日 2 次 — 变异核', () => {
  it('第 3 次真采集被拦为 quota_exhausted，采集器不被调、缓存不落', async () => {
    const db = seed();
    const collect = vi.fn(async (key: string) => payload({ entity_name: key }));
    await probeCompany(db, { name: 'A公司', userId: 1 }, { now: T0, collect });
    await probeCompany(db, { name: 'B公司', userId: 1 }, { now: T0, collect });
    expect(countProbesToday(db, 1, T0)).toBe(2);

    const r = await probeCompany(db, { name: 'C公司', userId: 1 }, { now: T0, collect });
    expect(r.status).toBe('quota_exhausted');
    expect(r.quota_left).toBe(0);
    expect(r.payload).toBeUndefined();
    expect(r.reason).toMatch(/不是「查无此公司」/);
    expect(collect).toHaveBeenCalledTimes(2); // C 没有触发采集
    expect(readProbeCache(db, companyKey({ name: 'C公司' }), { now: T0 }).fresh).toBe(false);
    db.close();
  });

  it('配额耗尽仍服务缓存命中（降级 = 仅缓存命中，不是全停）', async () => {
    const db = seed();
    const collect = vi.fn(async (key: string) => payload({ entity_name: key }));
    await probeCompany(db, { name: 'A公司', userId: 1 }, { now: T0, collect });
    await probeCompany(db, { name: 'B公司', userId: 1 }, { now: T0, collect });
    // 配额已尽，但 A 有 24h 内缓存 → 仍命中
    const r = await probeCompany(db, { name: 'A公司', userId: 1 }, { now: T0, collect });
    expect(r.status).toBe('hit');
    expect(r.payload).toBeDefined();
    db.close();
  });

  it('限流按用户各算各的：用户 1 用尽不影响用户 2', async () => {
    const db = seed();
    const collect = vi.fn(async (key: string) => payload({ entity_name: key }));
    await probeCompany(db, { name: 'A公司', userId: 1 }, { now: T0, collect });
    await probeCompany(db, { name: 'B公司', userId: 1 }, { now: T0, collect });
    const r1 = await probeCompany(db, { name: 'C公司', userId: 1 }, { now: T0, collect });
    expect(r1.status).toBe('quota_exhausted');
    const r2 = await probeCompany(db, { name: 'C公司', userId: 2 }, { now: T0, collect });
    expect(r2.status).toBe('collected'); // 另一个用户配额独立
    db.close();
  });

  it('配额次日重置', async () => {
    const db = seed();
    const collect = vi.fn(async (key: string) => payload({ entity_name: key }));
    await probeCompany(db, { name: 'A公司', userId: 1 }, { now: T0, collect });
    await probeCompany(db, { name: 'B公司', userId: 1 }, { now: T0, collect });
    expect((await probeCompany(db, { name: 'C公司', userId: 1 }, { now: T0, collect })).status).toBe(
      'quota_exhausted',
    );
    // 次日
    const r = await probeCompany(db, { name: 'C公司', userId: 1 }, { now: T_NEXT_DAY, collect });
    expect(r.status).toBe('collected');
    expect(countProbesToday(db, 1, T_NEXT_DAY)).toBe(1);
    db.close();
  });

  it('限流读表不硬编码：probe_free_per_day=1 时第 2 次即耗尽', async () => {
    const db = seed();
    db.prepare("INSERT INTO pricing_config (key, value_int) VALUES ('dossier.probe_free_per_day', 1)").run();
    const collect = vi.fn(async (key: string) => payload({ entity_name: key }));
    expect((await probeCompany(db, { name: 'A公司', userId: 1 }, { now: T0, collect })).status).toBe(
      'collected',
    );
    expect((await probeCompany(db, { name: 'B公司', userId: 1 }, { now: T0, collect })).status).toBe(
      'quota_exhausted',
    );
    db.close();
  });
});

describe('载荷体检：脏载荷进不了全站共享缓存 — 变异核', () => {
  const bad: [string, Partial<ProbePayload>, RegExp][] = [
    ['劳动争议多于涉诉总数', { litigation_count: 23, labor_count: 24 }, /自相矛盾/],
    ['有文书链接多于劳动争议', { labor_count: 11, doc_url_count: 12 }, /自相矛盾/],
    ['as_of 缺席', { as_of: '' }, /as_of/],
    ['未命中却报非零计数', { entity_matched: false, litigation_count: 5, labor_count: 0, doc_url_count: 0 }, /自相矛盾/],
    ['计数为负', { relation_count: -1 }, /非负整数/],
    ['计数带小数', { relation_count: 1.5 }, /非负整数/],
  ];
  it.each(bad)('%s → 抛错、缓存不落、配额不占', async (_name, over, re) => {
    const db = seed();
    const collect = vi.fn(async () => payload(over));
    await expect(
      probeCompany(db, { name: '脏载荷公司', userId: 1 }, { now: T0, collect }),
    ).rejects.toThrow(re);
    // 关键：脏载荷既没进缓存，也没扣配额（否则一次坏采集会污染全站 + 白烧用户额度）
    expect(readProbeCache(db, companyKey({ name: '脏载荷公司' }), { now: T0 }).fresh).toBe(false);
    expect(countProbesToday(db, 1, T0)).toBe(0);
    db.close();
  });

  it('对照臂：干净的「未命中」载荷（全 0）是合法的，可入缓存', async () => {
    const db = seed();
    const clean = payload({
      entity_matched: false,
      entity_name: null,
      uscc: null,
      gs_status: null,
      relation_count: 0,
      relation_breakdown: undefined,
      litigation_count: 0,
      labor_count: 0,
      doc_url_count: 0,
    });
    const r = await probeCompany(
      db,
      { name: '真没这家的公司', userId: 1 },
      { now: T0, collect: async () => clean },
    );
    expect(r.status).toBe('collected');
    expect(r.payload?.entity_matched).toBe(false);
    expect(readProbeCache(db, companyKey({ name: '真没这家的公司' }), { now: T0 }).fresh).toBe(true);
    db.close();
  });
});

describe('降级绝不返回空 payload（静默空是最危险的失败）', () => {
  it('no_collector / quota_exhausted 都是「有 reason、无 payload」，不是空对象', async () => {
    const db = seed();
    const r1 = await probeCompany(db, { name: '无缓存公司', userId: 1 }, { now: T0 });
    expect(r1.status).toBe('no_collector');
    expect(r1.payload).toBeUndefined();
    expect((r1.reason ?? '').trim().length).toBeGreaterThan(10);

    const collect = async (key: string) => payload({ entity_name: key });
    await probeCompany(db, { name: 'A公司', userId: 2 }, { now: T0, collect });
    await probeCompany(db, { name: 'B公司', userId: 2 }, { now: T0, collect });
    const r2 = await probeCompany(db, { name: 'C公司', userId: 2 }, { now: T0, collect });
    expect(r2.status).toBe('quota_exhausted');
    expect(r2.payload).toBeUndefined();
    expect((r2.reason ?? '').trim().length).toBeGreaterThan(10);
    db.close();
  });
});

describe('零 LLM（结构守卫）', () => {
  it('probe.ts 不 import 任何模型、不引用归纳符号', () => {
    const src = readFileSync(new URL('../probe.ts', import.meta.url), 'utf8');
    // 具体符号/导入路径，不扫「LLM」字样（注释里就写着「零 LLM」）
    expect(src).not.toMatch(/chatJSON|PatternLlm|generatePatterns|from '[^']*\/llm/);
    // probeCompany 的 opts 只认 now / collect，没有 llm 注入点
    expect(src).not.toMatch(/llm\??:/);
  });
});
