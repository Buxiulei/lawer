// app/src/lib/cases/__tests__/claim-calc-all-problems.test.ts
// claim_calc 的入参校验必须**一次列全**（援助律师 09-06 实测缺口⑤）。
//
// 【为什么这条值一个判据】七种算法的必填项互不相同，「待岗」四项、「双倍工资」四项。
// 只报第一条时，模型补一个、再调一次、再被告知缺下一个——问齐四项要四个完整的工具往返，
// 而每一轮它都以为自己只差这一个。判据钉的正是「一次全给」：
//   · 三参全缺 ⇒ missing 恰好三条，且三个字段名都在里面（变异臂「只报第一个」⇒ 红）
//   · 没给 vs 给错了要分在 missing / invalid 两栏（两者要做的动作不同）
//   · message 与两张表同源，且明说「这是本次全部的问题」
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runClaimCalc } from '@/lib/cases/claims';
import { runMigrations } from '@/lib/db/migrate';

let db: Database;
let caseId: number;

function calc(args: Record<string, unknown>) {
  return runClaimCalc(args, { db, caseId });
}

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(
    db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('h', '未认证')").run().lastInsertRowid,
  );
  caseId = Number(
    db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, '案子', '风声')").run(uid).lastInsertRowid,
  );
});

afterEach(() => db.close());

describe('缺三参一次列三', () => {
  test('N 只给 kind：三个必填项一次全列出来，不是只报第一个', () => {
    const res = calc({ kind: 'N' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('不该算成功');
    expect(res.missing).toHaveLength(3);
    const joined = res.missing!.join(' ');
    for (const field of ['avg_monthly_wage_fen', 'employed_from', 'terminated_at']) {
      expect(joined).toContain(field);
    }
    expect(res.invalid).toEqual([]);
    // 人读的那份与两张表同源，且明说这是全部
    expect(res.error).toContain('缺少 3 项');
    expect(res.error).toContain('本次一个字都没有落库');
    expect(res.error).toContain('这次全部的问题');
  });

  test('N+1 只给 kind：第四项 last_month_wage_fen 也在同一轮列出来', () => {
    const res = calc({ kind: 'N+1' });
    if (res.ok) throw new Error('不该算成功');
    expect(res.missing).toHaveLength(4);
    expect(res.missing!.join(' ')).toContain('last_month_wage_fen');
  });

  test('一个字都没落库：失败的那次不留 claims 行', () => {
    calc({ kind: 'N' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM claims').get()).toEqual({ n: 0 });
  });
});

describe('「没给」与「给错了」分栏', () => {
  test('给了非法值进 invalid，没给的进 missing', () => {
    const res = calc({ kind: 'N', avg_monthly_wage_fen: -5 });
    if (res.ok) throw new Error('不该算成功');
    expect(res.invalid!.join(' ')).toContain('avg_monthly_wage_fen');
    expect(res.missing).toHaveLength(2);
    expect(res.missing!.join(' ')).not.toContain('avg_monthly_wage_fen');
    expect(res.error).toContain('不合法 1 项');
  });

  test('kind 不在词表里 ⇒ invalid 而不是 missing', () => {
    const res = calc({ kind: '离职证明' });
    if (res.ok) throw new Error('不该算成功');
    expect(res.invalid!.join(' ')).toContain('kind');
    expect(res.missing).toEqual([]);
  });
});

describe('七种非解除算法各自一次列全', () => {
  test.each([
    ['年假', 4, ['cumulative_work_years', 'avg_monthly_wage_ex_overtime_fen', 'through_date', 'arranged_days_this_year']],
    ['双倍工资', 4, ['scenario', 'anchor_date', 'claimed_at', 'months']],
    ['待岗', 3, ['normal_monthly_wage_fen', 'months', 'provides_labor']],
    ['加付赔偿金', 4, ['items', 'complaint_filed', 'order_issued', 'overdue_unpaid']],
    ['竞业补偿', 2, ['avg_monthly_wage_fen', 'agreed_months']],
    ['病假工资', 1, ['months']],
  ])('%s：一次列 %i 项', (kind, count, fields) => {
    const res = calc({ kind });
    if (res.ok) throw new Error('不该算成功');
    expect(res.missing).toHaveLength(count as number);
    const joined = res.missing!.join(' ');
    for (const f of fields as string[]) expect(joined).toContain(f);
  });

  test('加班费：基数与「至少一项时长」两条问题一次都给', () => {
    const res = calc({ kind: '加班费' });
    if (res.ok) throw new Error('不该算成功');
    expect(res.missing).toHaveLength(2);
    const joined = res.missing!.join(' ');
    expect(joined).toContain('monthly_base_fen');
    expect(joined).toContain('weekday_overtime_hours');
  });
});
