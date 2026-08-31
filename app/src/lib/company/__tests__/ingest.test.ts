// app/src/lib/company/__tests__/ingest.test.ts
// 判据 A7（同一份 JSONL 导两次）+ 导入侧的「不推断」红线。
//
// 夹具里的三行**逐字抄自外勤实产**（D18 宜信系劳动争议判例清单，13 个中文键），
// 不是我照着契约手搓的样子——否则测的是我对格式的印象，不是外勤真的会给什么。
import { describe, it, expect } from 'vitest';

import { ingestDocs, parseJsonl, type RelayDoc } from '../ingest';

import { mkChain, newDb } from './fixtures';

/** 逐字抄自外勤实产的三行（键序与取值原样保留）。 */
const REAL_LINES = [
  '{"案号": "（2026）甘01民终2972号", "年份": "2026", "审理机关": "甘肃省兰州市中级人民法院", "程序": "民事二审", "标题": "某公司、周某劳动争议一案", "案由": "", "裁判主文_逐字摘录": "", "金额_摘自主文": [], "原文获取状态": "仅列表项_未取全文", "全文字数": 0, "检索式": "宜信-全文劳动争议", "主体归属": "未命中_疑同名", "归属依据": "标题与全文前800字未出现已知宜信系主体名"}',
  '{"案号": "（2023）辽02民终3815号", "年份": "2023", "审理机关": "辽宁省大连市中级人民法院", "程序": "民事二审", "标题": "杨某、某咨询（北京）有限公司劳动争议民事二审民事裁定书", "案由": "", "裁判主文_逐字摘录": "", "金额_摘自主文": [], "原文获取状态": "仅列表项_未取全文", "全文字数": 0, "检索式": "宜信-全文劳动争议", "主体归属": "命中宜信系", "归属依据": "宜信普惠"}',
  '{"案号": "（2023）京03民终4721号", "年份": "2023", "审理机关": "北京市第三中级人民法院", "程序": "民事二审", "标题": "鲁某与某融资租赁有限公司等劳动争议二审民事判决书", "案由": "劳动争议", "裁判主文_逐字摘录": "驳回鲁某的诉讼请求。本院对一审法院查明的事实予以确认。", "金额_摘自主文": [], "原文获取状态": "已取全文", "全文字数": 6931, "检索式": "宜信-全文劳动争议", "主体归属": "命中宜信系", "归属依据": "宜信惠琮"}',
].join('\n');

function rowsOf(text: string): RelayDoc[] {
  const { rows, bad } = parseJsonl(text);
  expect(bad).toEqual([]);
  return rows;
}

describe('A7 幂等：同一份 JSONL 导两次', () => {
  it('第二次 inserted=0、库里行数不变', () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    const rows = rowsOf(REAL_LINES);

    const first = ingestDocs(db, {
      dossierId,
      companyProfileId: profileId,
      rows,
      fetchedAt: '2026-08-28',
    });
    expect(first.total).toBe(3);
    expect(first.skippedNotSubject).toBe(1); // 「未命中_疑同名」那行不入库
    expect(first.inserted).toBe(2);
    expect(first.duplicated).toBe(0);

    const second = ingestDocs(db, {
      dossierId,
      companyProfileId: profileId,
      rows,
      fetchedAt: '2026-08-29',
    });
    expect(second.inserted).toBe(0); // ← changes 判定，不是「尝试了几行」
    expect(second.duplicated).toBe(2);

    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM company_litigation WHERE dossier_id = ?')
      .get(dossierId) as { n: number };
    expect(n).toBe(2);
    db.close();
  });

  // 同一档案换一个 profile 再导一次：案件维度那把唯一键管不住，
  // 全靠 uq_company_litigation_dossier 兜住。少了它 docs_total 当场翻倍——
  // 而那个数是比率的分母之一。
  it('同一档案换 profile 再导 ⇒ 仍不翻倍（档案维度唯一键兜底）', () => {
    const db = newDb();
    const a = mkChain(db, '甲公司有限公司');
    // 第二个案件、第二个 profile，指向同一份档案
    const userId = Number(
      db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('h-other').lastInsertRowid,
    );
    const caseId = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(userId, '另一个案件')
        .lastInsertRowid,
    );
    const profile2 = Number(
      db.prepare('INSERT INTO company_profiles (case_id, name, dossier_id) VALUES (?,?,?)')
        .run(caseId, '甲公司有限公司', a.dossierId).lastInsertRowid,
    );

    const rows = rowsOf(REAL_LINES);
    ingestDocs(db, { dossierId: a.dossierId, companyProfileId: a.profileId, rows, fetchedAt: '2026-08-28' });
    const again = ingestDocs(db, {
      dossierId: a.dossierId,
      companyProfileId: profile2,
      rows,
      fetchedAt: '2026-08-28',
    });
    expect(again.inserted).toBe(0);

    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM company_litigation WHERE dossier_id = ?')
      .get(a.dossierId) as { n: number };
    expect(n).toBe(2);
    db.close();
  });
});

describe('导入侧不推断：没有的就是 NULL', () => {
  it('年份不当判决日期、检索式不当案由、标题不当结果', () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    ingestDocs(db, {
      dossierId,
      companyProfileId: profileId,
      rows: rowsOf(REAL_LINES),
      fetchedAt: '2026-08-28',
    });
    const rows = db
      .prepare(
        `SELECT case_no, judged_at, filed_at, outcome, applicant_side, stage,
                has_fulltext, cause, is_labor, amount_awarded_fen, summary, fetched_at
           FROM company_litigation WHERE dossier_id = ? ORDER BY case_no`,
      )
      .all(dossierId) as Record<string, unknown>[];

    for (const r of rows) {
      expect(r.judged_at).toBeNull(); // 年份是 2023/2026，但那不是日期
      expect(r.filed_at).toBeNull();
      expect(r.outcome).toBeNull(); // 没有逐字判据就判不出结果
      expect(r.applicant_side).toBeNull(); // 谁告谁，现有格式里没有
      expect(r.amount_awarded_fen).toBeNull(); // 金额_摘自主文 是空数组，不去解析元→分
      expect(r.fetched_at).toBe('2026-08-28'); // 采集时点由调用方给，不取 now()
    }

    const kyoto = rows.find((r) => r.case_no === '（2023）京03民终4721号')!;
    expect(kyoto.has_fulltext).toBe(1);
    expect(kyoto.stage).toBe('二审');
    expect(kyoto.cause).toBe('劳动争议');
    expect(kyoto.is_labor).toBe(1);
    expect(String(kyoto.summary)).toContain('驳回鲁某的诉讼请求');

    const liaoning = rows.find((r) => r.case_no === '（2023）辽02民终3815号')!;
    expect(liaoning.has_fulltext).toBe(0);
    expect(liaoning.cause).toBeNull(); // 案由为空串 ⇒ NULL，不拿检索式顶
    expect(liaoning.is_labor).toBe(0);
    db.close();
  });

  it('民事再审不映射到任何一段（硬塞进二审会污染二审时长样本）', () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    ingestDocs(db, {
      dossierId,
      companyProfileId: profileId,
      rows: [{ 案号: 'R1', 程序: '民事再审', 主体归属: '命中宜信系' }],
      fetchedAt: '2026-08-28',
    });
    const r = db.prepare('SELECT stage FROM company_litigation WHERE case_no = ?').get('R1') as {
      stage: string | null;
    };
    expect(r.stage).toBeNull();
    db.close();
  });

  it('标为已取全文却没有逐字摘录 ⇒ 降回 has_fulltext=0 并报警告', () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    const rep = ingestDocs(db, {
      dossierId,
      companyProfileId: profileId,
      rows: [{ 案号: 'E1', 原文获取状态: '已取全文', 裁判主文_逐字摘录: '   ' }],
      fetchedAt: '2026-08-28',
    });
    expect(rep.warnings.join('\n')).toContain('无法逐条核验模型引文');
    const r = db.prepare('SELECT has_fulltext FROM company_litigation WHERE case_no = ?').get('E1') as {
      has_fulltext: number;
    };
    expect(r.has_fulltext).toBe(0);
    db.close();
  });

  it('不认识的结果取值 ⇒ outcome 留空 + 报警告（不静默兜底成某一档）', () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    const rep = ingestDocs(db, {
      dossierId,
      companyProfileId: profileId,
      rows: [{ 案号: 'O1', 结果: '双方各打五十大板' }],
      fetchedAt: '2026-08-28',
    });
    expect(rep.warnings.join('\n')).toContain('不认识的「结果」取值');
    const r = db.prepare('SELECT outcome FROM company_litigation WHERE case_no = ?').get('O1') as {
      outcome: string | null;
    };
    expect(r.outcome).toBeNull();
    db.close();
  });

  it('缺案号的行被拒收，理由三段式（缺什么/为什么/怎么办）', () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    const rep = ingestDocs(db, {
      dossierId,
      companyProfileId: profileId,
      rows: [{ 案号: '  ' } as RelayDoc, { 案号: 'K1' }],
      fetchedAt: '2026-08-28',
    });
    expect(rep.rejected).toHaveLength(1);
    expect(rep.rejected[0].reason).toContain('缺「案号」');
    expect(rep.rejected[0].reason).toContain('无法去重');
    expect(rep.rejected[0].reason).toContain('请让外勤补齐');
    expect(rep.inserted).toBe(1);
    db.close();
  });
});

describe('parseJsonl：坏行报出来，不静默跳过', () => {
  it('半截 JSON 行进 bad，好行照常解析', () => {
    const { rows, bad } = parseJsonl('{"案号":"A"}\n{"案号":\n{"案号":"B"}\n');
    expect(rows.map((r) => r.案号)).toEqual(['A', 'B']);
    expect(bad).toHaveLength(1);
    expect(bad[0].line).toBe(2);
    expect(bad[0].reason).toContain('每行一个独立 JSON 对象');
  });
});
