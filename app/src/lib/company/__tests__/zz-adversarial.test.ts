import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { runMigrations } from '../../db/migrate';
import { createDossier, lookupCache, setStatus, markRefreshed } from '../dossier';
import { ingestDocs } from '../ingest';
import { computeStats } from '../stats';
import { advanceDossiers } from '../runner';

function seed() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare("INSERT INTO users (id, auth_status) VALUES (1, '未实名')").run();
  db.prepare("INSERT INTO cases (id, user_id, title) VALUES (1, 1, 'c')").run();
  db.prepare("INSERT INTO company_profiles (id, case_id, name) VALUES (7, 1, '甲公司')").run();
  return db;
}

function docs(n: number, opts: { outcome?: string | null; fulltext?: boolean } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    案号: `（2024）京0105民初${1000 + i}号`,
    原文获取状态: opts.fulltext === false ? '仅列表项_未取全文' : '已取全文',
    裁判主文_逐字摘录: '本院认为，用人单位应当支付赔偿金。',
    结果: opts.outcome === null ? undefined : (opts.outcome ?? '劳动者全部获支持'),
    案由: '劳动争议',
  }));
}

describe('对抗：小样本软数字', () => {
  it('可判定 4 篇：无任何比率键', () => {
    const db = seed();
    const d = createDossier(db, { name: '甲公司' });
    ingestDocs(db, { dossierId: d.id, companyProfileId: 7, rows: docs(4), fetchedAt: '2026-08-28' });
    const s = computeStats(db, d.id);
    expect('worker_favorable_ratio' in s).toBe(false);
    // 软数字兜网：ratio 作键后缀（_ratio）、均值（avg/平均）、中位（median/中位）一律不许出现。
    // 注意别误伤合法键 durations（含子串 "ratio"）——所以钉 `_ratio` 而非裸 `ratio`。
    expect(JSON.stringify(s)).not.toMatch(/_ratio|avg|平均|median|中位/);
    db.close();
  });

  it('可判定 5 篇：出比率（证明上一条不是永远不出数）', () => {
    const db = seed();
    const d = createDossier(db, { name: '甲公司' });
    ingestDocs(db, { dossierId: d.id, companyProfileId: 7, rows: docs(5), fetchedAt: '2026-08-28' });
    expect(computeStats(db, d.id).worker_favorable_ratio).toBe(1);
    db.close();
  });

  it('门槛降到 4：4 篇也出数（证明读表生效，不是硬编码）', () => {
    const db = seed();
    db.prepare("INSERT INTO pricing_config (key, value_int) VALUES ('dossier.min_sample_outcome', 4)").run();
    const d = createDossier(db, { name: '甲公司' });
    ingestDocs(db, { dossierId: d.id, companyProfileId: 7, rows: docs(4), fetchedAt: '2026-08-28' });
    expect(computeStats(db, d.id).worker_favorable_ratio).toBe(1);
    db.close();
  });

  it('as_of 缺席（fetched_at 为空串）：即便 10 篇也不出比率', () => {
    const db = seed();
    const d = createDossier(db, { name: '甲公司' });
    ingestDocs(db, { dossierId: d.id, companyProfileId: 7, rows: docs(10), fetchedAt: '' });
    const s = computeStats(db, d.id);
    expect('worker_favorable_ratio' in s).toBe(false);
    db.close();
  });
});

describe('对抗：createDossier 丢弃第二个买家的计费凭据', () => {
  it('同 company_key 二次建档：新 chargeRef / 买家 / paid_by 全被静默丢弃', () => {
    const db = seed();
    db.prepare("INSERT INTO users (id, auth_status) VALUES (2, '未实名')").run();
    const first = createDossier(db, {
      name: '甲公司', orderedByUserId: 1, paidBy: 'gongdao', chargeRef: 'dossier-u1-abc',
    });
    const second = createDossier(db, {
      name: '甲公司', orderedByUserId: 2, paidBy: 'membership_credit', paidRef: '99', chargeRef: 'dossier-u2-xyz',
    });
    expect(second.id).toBe(first.id);
    // 第二个买家的凭据一个都没落库：退款只能按第一个买家的 chargeRef 退给第一个买家
    expect(second.charge_ref).toBe('dossier-u1-abc');
    expect(second.ordered_by_user_id).toBe(1);
    expect(second.paid_by).toBe('gongdao');
    db.close();
  });
});

describe('对抗：done 之后的增量入库不再重算统计', () => {
  it('done 档案新导入 5 篇，runner 不看它，统计快照停在旧数', async () => {
    const db = seed();
    const d = createDossier(db, { name: '甲公司' });
    ingestDocs(db, { dossierId: d.id, companyProfileId: 7, rows: docs(1), fetchedAt: '2026-08-20' });
    await advanceDossiers(db, {});           // 无 llm ⇒ patterns 未排 ⇒ stats_ready
    await advanceDossiers(db, {
      llm: { chatJSON: async () => '{"patterns":[]}' },
    });                                       // patterns 跑完 ⇒ done
    const st = db.prepare('SELECT status FROM company_dossiers WHERE id=?').get(d.id) as { status: string };
    expect(st.status).toBe('done');

    // 外勤第二窗到货：又来 5 篇
    ingestDocs(db, {
      dossierId: d.id, companyProfileId: 7,
      rows: docs(5).map((r, i) => ({ ...r, 案号: `（2025）京0105民初${i}号` })),
      fetchedAt: '2026-08-30',
    });
    const before = db.prepare('SELECT docs_total, as_of FROM company_dossier_stats WHERE dossier_id=?').get(d.id);
    const rep = await advanceDossiers(db, { llm: { chatJSON: async () => '{"patterns":[]}' } });
    const after = db.prepare('SELECT docs_total, as_of FROM company_dossier_stats WHERE dossier_id=?').get(d.id);

    expect(rep.examined).toBe(0);            // runner 根本没看这份档案
    expect(after).toEqual(before);           // 快照仍是 1 条 / 2026-08-20
    expect(computeStats(db, d.id).docs_total).toBe(6); // 库里其实已经 6 条
    db.close();
  });

  it('且该 done 档案在 TTL 内会被判缓存命中（拿旧快照收增量价）', async () => {
    const db = seed();
    const d = createDossier(db, { name: '甲公司' });
    ingestDocs(db, { dossierId: d.id, companyProfileId: 7, rows: docs(1), fetchedAt: '2026-08-20' });
    await advanceDossiers(db, { llm: { chatJSON: async () => '{"patterns":[]}' } });
    setStatus(db, d.id, 'done');
    markRefreshed(db, d.id, 'graph', '2026-08-29 00:00:00');
    expect(lookupCache(db, { name: '甲公司' }, { now: '2026-08-30 00:00:00' }).hit).toBe(true);
    db.close();
  });
});
