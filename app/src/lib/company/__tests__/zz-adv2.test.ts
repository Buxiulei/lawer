import Database from 'better-sqlite3';
import { describe, it, expect, vi } from 'vitest';

import { runMigrations } from '../../db/migrate';
import { createDossier } from '../dossier';
import { ingestDocs } from '../ingest';
import { generatePatterns } from '../patterns';
import { computeStats } from '../stats';

function seed() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare("INSERT INTO users (id, auth_status) VALUES (1, '未实名')").run();
  db.prepare("INSERT INTO cases (id, user_id, title) VALUES (1, 1, 'c')").run();
  db.prepare("INSERT INTO company_profiles (id, case_id, name) VALUES (7, 1, '甲公司')").run();
  return db;
}

describe('对抗：分母不能是 docs_total', () => {
  it('入档 15 条、可判定 4 篇 ⇒ 仍不出比率', () => {
    const db = seed();
    const d = createDossier(db, { name: '甲公司' });
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => ({
        案号: `A${i}`, 原文获取状态: '已取全文',
        裁判主文_逐字摘录: '本院认为，用人单位应当支付赔偿金。',
        结果: '劳动者全部获支持', 案由: '劳动争议',
      })),
      ...Array.from({ length: 11 }, (_, i) => ({
        案号: `B${i}`, 原文获取状态: '仅列表项_未取全文', 案由: '劳动争议',
      })),
    ];
    ingestDocs(db, { dossierId: d.id, companyProfileId: 7, rows, fetchedAt: '2026-08-28' });
    const s = computeStats(db, d.id);
    expect(s.docs_total).toBe(15);
    expect(s.docs_outcome_decided).toBe(4);
    expect('worker_favorable_ratio' in s).toBe(false);
    db.close();
  });
});

describe('对抗：白名单为空绝不调模型', () => {
  it('全是仅列表项 ⇒ chatJSON 调用次数为 0，块标 skipped', async () => {
    const db = seed();
    const d = createDossier(db, { name: '甲公司' });
    ingestDocs(db, {
      dossierId: d.id, companyProfileId: 7,
      rows: [{ 案号: 'B1', 原文获取状态: '仅列表项_未取全文', 标题: '甲公司与周某劳动争议一案' }],
      fetchedAt: '2026-08-28',
    });
    const chatJSON = vi.fn(async () => '{"patterns":[]}');
    const r = await generatePatterns(db, d.id, { chatJSON });
    expect(chatJSON).toHaveBeenCalledTimes(0);
    expect(r.skipped).toBe(true);
    const b = db.prepare("SELECT status FROM company_dossier_blocks WHERE dossier_id=? AND block='patterns'").get(d.id) as { status: string };
    expect(b.status).toBe('skipped');
    db.close();
  });
});

describe('对抗：引文必须逐字、案号必须在库', () => {
  it('同义改写 / 库外案号 / 引用别案案号 ⇒ 全丢，dropped_patterns 累加', async () => {
    const db = seed();
    const d = createDossier(db, { name: '甲公司' });
    ingestDocs(db, {
      dossierId: d.id, companyProfileId: 7,
      rows: [{ 案号: 'A1', 原文获取状态: '已取全文', 裁判主文_逐字摘录: '本院认为，用人单位应当支付违法解除劳动合同赔偿金。' }],
      fetchedAt: '2026-08-28',
    });
    const raw = JSON.stringify({
      patterns: [
        { pattern: '同义改写', evidence: [{ case_no: 'A1', quote: '法院认为公司要付赔偿金' }] },
        { pattern: '库外案号', evidence: [{ case_no: 'ZZZ9', quote: '本院认为' }] },
        { pattern: '逐字命中', evidence: [{ case_no: 'A1', quote: '用人单位应当支付违法解除劳动合同赔偿金' }] },
      ],
    });
    const r = await generatePatterns(db, d.id, { chatJSON: async () => raw });
    expect(r.kept).toBe(1);
    expect(r.dropped).toBe(2);
    const rows = db.prepare('SELECT pattern FROM company_patterns WHERE dossier_id=?').all(d.id) as { pattern: string }[];
    expect(rows.map((x) => x.pattern)).toEqual(['逐字命中']);
    const s = db.prepare('SELECT dropped_patterns FROM company_dossier_stats WHERE dossier_id=?').get(d.id) as { dropped_patterns: number };
    expect(s.dropped_patterns).toBe(2);
    // 重跑一次：编造计数累加不清零
    await generatePatterns(db, d.id, { chatJSON: async () => raw });
    const s2 = db.prepare('SELECT dropped_patterns FROM company_dossier_stats WHERE dossier_id=?').get(d.id) as { dropped_patterns: number };
    expect(s2.dropped_patterns).toBe(4);
    db.close();
  });
});

describe('对抗：外勤给了非法 outcome 值', () => {
  it('「调解结案」不进分母，且报出警告', () => {
    const db = seed();
    const d = createDossier(db, { name: '甲公司' });
    const rep = ingestDocs(db, {
      dossierId: d.id, companyProfileId: 7,
      rows: Array.from({ length: 6 }, (_, i) => ({
        案号: `C${i}`, 原文获取状态: '已取全文', 裁判主文_逐字摘录: '调解协议如下。', 结果: '调解结案',
      })),
      fetchedAt: '2026-08-28',
    });
    expect(rep.warnings.join()).toMatch(/不认识的「结果」取值：调解结案/);
    const s = computeStats(db, d.id);
    expect(s.docs_outcome_decided).toBe(0);
    expect('worker_favorable_ratio' in s).toBe(false);
    db.close();
  });
});
