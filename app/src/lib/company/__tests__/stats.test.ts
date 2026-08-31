// app/src/lib/company/__tests__/stats.test.ts
// 判据 A1 / A2 / A3（数据诚实红线的统计侧），每条自带变异臂。
//
// 变异臂在这里是**同臂对照**：用同一份夹具，把判定条件按「被改坏的那种写法」再算一遍，
// 断言那种写法会给出不同的答案。没有这一步，「样本不足所以没出数」与
// 「代码根本就不会出数」在测试输出里长得一模一样——教训「仪器错 vs 范围错」。
import { describe, it, expect } from 'vitest';

import { computeStats, saveStats, DURATION_SEGMENTS } from '../stats';

import { mkChain, newDb, seedDoc } from './fixtures';

/** 把门槛写进 pricing_config（不硬编码在判定处，这条本身就是判据的一部分）。 */
function setConfig(db: ReturnType<typeof newDb>, key: string, v: number): void {
  db.prepare('INSERT OR REPLACE INTO pricing_config (key, value_int) VALUES (?,?)').run(key, v);
}

describe('A1 样本不足：整块不出数字', () => {
  it('4 篇全文、其中 3 篇可判结果 ⇒ 无任何百分数字段', () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    // 4 篇全文，其中 3 篇有 outcome
    seedDoc(db, profileId, dossierId, { case_no: 'A1', has_fulltext: 1, summary: '正文一', outcome: '劳动者全部获支持' });
    seedDoc(db, profileId, dossierId, { case_no: 'A2', has_fulltext: 1, summary: '正文二', outcome: '劳动者部分获支持' });
    seedDoc(db, profileId, dossierId, { case_no: 'A3', has_fulltext: 1, summary: '正文三', outcome: '劳动者未获支持' });
    seedDoc(db, profileId, dossierId, { case_no: 'A4', has_fulltext: 1, summary: '正文四' });
    seedDoc(db, profileId, dossierId, { case_no: 'A5' }); // 仅列表项

    const s = computeStats(db, dossierId);
    expect(s.docs_total).toBe(5);
    expect(s.docs_fulltext).toBe(4);
    expect(s.docs_outcome_decided).toBe(3);

    // 不是给 0、不是给 null：**这个键根本不存在**。存在的键会被下游当成「有这个数」。
    expect('worker_favorable_ratio' in s).toBe(false);
    expect(s.insufficient_note).toContain('不足 5 篇不出比例');
    expect(s.insufficient_note).toContain('已入档 5 条');
    expect(s.insufficient_note).toContain('取到全文 4 篇');
    expect(s.insufficient_note).toContain('可判定结果 3 篇');
    // 整个返回值里搜不到百分号，也搜不到那个键名
    expect(JSON.stringify(s)).not.toContain('%');
    expect(JSON.stringify(s)).not.toContain('worker_favorable_ratio');
    db.close();
  });

  // 变异臂：门槛改成 3（写进 pricing_config，不改代码）⇒ 同一份夹具必须出比率。
  // 这条同时证明两件事：门槛真的是从表里读的；上面那条「没有百分数」不是因为代码压根不会算。
  it('变异臂：门槛降到 3 ⇒ 同一份夹具必须出比率', () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    seedDoc(db, profileId, dossierId, { case_no: 'A1', has_fulltext: 1, summary: '正文一', outcome: '劳动者全部获支持' });
    seedDoc(db, profileId, dossierId, { case_no: 'A2', has_fulltext: 1, summary: '正文二', outcome: '劳动者部分获支持' });
    seedDoc(db, profileId, dossierId, { case_no: 'A3', has_fulltext: 1, summary: '正文三', outcome: '劳动者未获支持' });
    setConfig(db, 'dossier.min_sample_outcome', 3);

    const s = computeStats(db, dossierId);
    expect(s.worker_favorable_ratio).toBeCloseTo(2 / 3, 4);
    expect('insufficient_note' in s).toBe(false);
    db.close();
  });
});

describe('A2 样本达标：比率 + 三个元数据', () => {
  const seedTen = (db: ReturnType<typeof newDb>) => {
    const { profileId, dossierId } = mkChain(db);
    for (let i = 0; i < 10; i++) {
      seedDoc(db, profileId, dossierId, {
        case_no: `B${i}`,
        has_fulltext: 1,
        summary: `正文${i}`,
        outcome: i < 6 ? '劳动者部分获支持' : '劳动者未获支持',
        applicant_side: i < 7 ? '劳动者' : '单位',
        fetched_at: i === 9 ? '2026-08-28' : '2026-08-20',
      });
    }
    // 另外 5 条仅列表项（有案号、判不出结果）。**必须有它们**：
    // 没有它们时 docs_total 恰好等于 docs_outcome_decided，
    // 「分母用错了」这条就分辨不出来——而分母正是本文件要守的那件事。
    for (let i = 0; i < 5; i++) {
      seedDoc(db, profileId, dossierId, { case_no: `L${i}`, fetched_at: '2026-08-20' });
    }
    return dossierId;
  };

  it('10 篇可判、6 篇获支持 ⇒ 比率 0.6（分母不是 15），sample_n/as_of/coverage_note 三项非空', () => {
    const db = newDb();
    const dossierId = seedTen(db);
    const s = computeStats(db, dossierId);

    expect(s.docs_total).toBe(15); // 全部入档条目
    expect(s.docs_outcome_decided).toBe(10); // 比率的唯一合法分母
    expect(s.worker_favorable_ratio).toBe(0.6); // 6/10，**不是** 6/15
    expect(s.sample_n).toBe(10);
    expect(s.as_of).toBe('2026-08-28'); // = MAX(fetched_at)，不是「今天」
    expect(s.source).toBe('裁判文书网·人机接力取证');
    expect(s.coverage_note).not.toBe('');
    expect(s.coverage_note).toContain('不构成该公司全部涉诉记录');

    // 申请人方分布必须同屏并列：不分程序位置的胜诉率是错的数
    expect(s.applicant_labor_n).toBe(7);
    expect(s.applicant_employer_n).toBe(3);
    db.close();
  });

  // 变异臂：抹掉采集时点（as_of 无从得知）⇒ 比率必须消失。
  // 「有数字但说不出数据截止到哪天」的统计一旦流出，就会被当成新鲜数据用，
  // 所以这条在算的这一层就执行，不推给渲染层。
  it('变异臂：as_of 无从得知 ⇒ 比率消失、四段时长也不出数', () => {
    const db = newDb();
    const dossierId = seedTen(db);
    db.prepare('UPDATE company_litigation SET fetched_at = NULL WHERE dossier_id = ?').run(dossierId);

    const s = computeStats(db, dossierId);
    expect(s.as_of).toBeNull();
    expect('worker_favorable_ratio' in s).toBe(false);
    expect(s.insufficient_note).toContain('无法说明数据截止到哪天');
    db.close();
  });

  it('saveStats 落快照后可原样读回（含 coverage_note 与 as_of）', () => {
    const db = newDb();
    const dossierId = seedTen(db);
    saveStats(db, computeStats(db, dossierId));
    const row = db
      .prepare('SELECT * FROM company_dossier_stats WHERE dossier_id = ?')
      .get(dossierId) as Record<string, unknown>;
    expect(row.docs_outcome_decided).toBe(10);
    expect(row.worker_favorable_n).toBe(6);
    expect(row.as_of).toBe('2026-08-28');
    expect(String(row.coverage_note)).toContain('偏差方向未知');
    // 落库两次仍只有一行（一档一行，覆盖式）
    saveStats(db, computeStats(db, dossierId));
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM company_dossier_stats WHERE dossier_id = ?')
      .get(dossierId) as { n: number };
    expect(n).toBe(1);
    db.close();
  });
});

describe('A3 四段时长各自独立，且没有「平均时长」这回事', () => {
  const seedSegments = (db: ReturnType<typeof newDb>) => {
    const { profileId, dossierId } = mkChain(db);
    // 仲裁段 8 篇：天数 10,20,30,40,50,60,70,80 ⇒ 中位数 45
    const arbDays = [10, 20, 30, 40, 50, 60, 70, 80];
    arbDays.forEach((d, i) => {
      const filed = new Date(Date.UTC(2025, 0, 1));
      const judged = new Date(Date.UTC(2025, 0, 1 + d));
      seedDoc(db, profileId, dossierId, {
        case_no: `ARB${i}`,
        stage: '仲裁',
        filed_at: filed.toISOString().slice(0, 10),
        judged_at: judged.toISOString().slice(0, 10),
      });
    });
    // 二审段只有 2 篇
    [15, 25].forEach((d, i) => {
      seedDoc(db, profileId, dossierId, {
        case_no: `T2-${i}`,
        stage: '二审',
        filed_at: '2025-03-01',
        judged_at: new Date(Date.UTC(2025, 2, 1 + d)).toISOString().slice(0, 10),
      });
    });
    return dossierId;
  };

  it('仲裁段 n=8 出中位数；二审段 n=2 独立显示样本不足，其它段不受牵连', () => {
    const db = newDb();
    const dossierId = seedSegments(db);
    const s = computeStats(db, dossierId);

    const arb = s.durations.find((d) => d.segment === '仲裁受理→裁决')!;
    expect(arb.n).toBe(8);
    expect(arb.median_days).toBe(45);
    expect('insufficient_note' in arb).toBe(false);

    const t2 = s.durations.find((d) => d.segment === '二审立案→判决')!;
    expect(t2.n).toBe(2);
    expect('median_days' in t2).toBe(false);
    expect(t2.insufficient_note).toContain('不足 5 篇不出时长');

    // 一段不足不牵连其它段：一审/执行两段各自 n=0、各自不足，仲裁段照常出数
    const t1 = s.durations.find((d) => d.segment === '一审立案→判决')!;
    expect(t1.n).toBe(0);
    expect('median_days' in t1).toBe(false);
    expect(arb.median_days).toBe(45);

    // 四段齐全、顺序固定，且**没有第五项**
    expect(s.durations.map((d) => d.segment)).toEqual([...DURATION_SEGMENTS]);
    db.close();
  });

  it('响应里根本没有「平均时长」这个键（合成一个总均值就是造一个没人经历过的数）', () => {
    const db = newDb();
    const dossierId = seedSegments(db);
    const json = JSON.stringify(computeStats(db, dossierId));
    for (const forbidden of ['avg_duration', 'average', 'avg_days', 'mean_days', '平均时长']) {
      expect(json).not.toContain(forbidden);
    }
    db.close();
  });

  // 变异臂：把四段合成一段来算（「被改坏的那种写法」），断言它给出的是**另一个数**。
  // 没有这条，上面那些断言可能只是在描述一个恰好也成立的巧合。
  it('变异臂：若把四段合成一个均值，会得到一个与任何一段都不同的数', () => {
    const db = newDb();
    const dossierId = seedSegments(db);
    const s = computeStats(db, dossierId);
    const rows = db
      .prepare(
        `SELECT filed_at, judged_at FROM company_litigation
          WHERE dossier_id = ? AND filed_at IS NOT NULL AND judged_at IS NOT NULL`,
      )
      .all(dossierId) as { filed_at: string; judged_at: string }[];
    const allDays = rows.map(
      (r) => (Date.parse(`${r.judged_at}T00:00:00Z`) - Date.parse(`${r.filed_at}T00:00:00Z`)) / 86_400_000,
    );
    const mergedMean = allDays.reduce((a, b) => a + b, 0) / allDays.length;
    const arb = s.durations.find((d) => d.segment === '仲裁受理→裁决')!;
    expect(allDays.length).toBe(10); // 8 + 2，合并确实会把二审那 2 篇算进去
    expect(mergedMean).not.toBeCloseTo(arb.median_days!, 3);
    db.close();
  });
});
