// app/src/lib/cases/__tests__/intake.test.ts
// 首诊提交必须**真的写进库**——这一组盯的是 P0 的第一层：
// 用户填完六步、点「进入驾驶舱」，此前服务器上一个字都没有。
// 所以这里不验「函数返回了 ok」，一律回头查表：字段落没落、时间线有没有、
// 三件事在不在、别人的案件能不能写。
import { describe, expect, it } from 'vitest';

import { submitIntake } from '@/lib/cases';
import { INTAKE_STAGE_ACTIONS } from '@/lib/cases/intake-actions';
import { makeFixture } from './fixtures';

/** 一份填满的首诊，字段名照 lib/cases 的入参 */
function fullIntake(over: Record<string, unknown> = {}) {
  return {
    stage: '已收通知',
    companyName: '华衡永泰供应链管理有限公司',
    employedFrom: '2021-04-12',
    monthlyWageFen: 2_200_000,
    position: '仓储主管',
    contractCount: '只签过一次',
    events: [
      { date: '2026-08-28', text: '部门开会说要优化' },
      { date: '2026-09-01', text: 'HR 约谈让我签自愿离职' },
      { date: '', text: '权限被收走' },
    ],
    freeText: '我没签。',
    companyDocs: { terminationNotice: '有', settlementAgreement: '没有', otherPaper: '不确定' },
    companyWording: 'HR 说公司要优化，让我主动辞职，给 N，三天内答复。',
    goals: ['违法解除赔偿金（2N）', '拖欠的工资'],
    bottomLine: '低于 2N 不签，工资必须结清。',
    now: new Date('2026-09-02T10:00:00+08:00'),
    ...over,
  };
}

describe('首诊落库', () => {
  it('六步内容确实进了这个人的案件：字段、公司、时间线、三件事', () => {
    const f = makeFixture();
    const res = submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake() });
    expect(res.ok).toBe(true);

    const row = f.db.prepare('SELECT * FROM cases WHERE id = ?').get(f.caseA) as Record<string, unknown>;
    expect(row.stage).toBe('已收通知');
    expect(row.employed_from).toBe('2021-04-12');
    expect(row.monthly_wage_fen).toBe(2_200_000);
    expect(row.position).toBe('仓储主管');
    expect(row.contract_count).toBe('只签过一次');
    expect(row.goal).toBe('违法解除赔偿金（2N）、拖欠的工资');
    expect(row.bottom_line).toBe('低于 2N 不签，工资必须结清。');

    // 公司名 = 仲裁里的被申请人，落 company_profiles
    const profiles = f.db
      .prepare('SELECT name, role FROM company_profiles WHERE case_id = ?')
      .all(f.caseA) as { name: string; role: string }[];
    expect(profiles).toEqual([
      { name: '华衡永泰供应链管理有限公司', role: '签约主体' },
    ]);

    // 三条事件 + 整段自述 + 公司说法 + 公司给过哪些文件 = 6 条
    const timeline = f.db
      .prepare('SELECT kind, title, detail, happened_at FROM timeline_events WHERE case_id = ? ORDER BY id')
      .all(f.caseA) as { kind: string; title: string; detail: string | null; happened_at: string }[];
    expect(timeline).toHaveLength(6);
    expect(timeline.map((t) => t.title)).toContain('HR 约谈让我签自愿离职');
    expect(timeline.map((t) => t.title)).toContain('我把经过整段记了下来');
    expect(timeline.map((t) => t.title)).toContain('公司口头给的说法');
    expect(timeline.find((t) => t.title === '公司已经给过哪些文件')?.detail).toContain(
      '《解除劳动合同通知书》：有',
    );
    // 带日期的事件按用户填的那天记，不是按提交时刻；且**库里的日期部分就是用户填的那天**
    // （落零点会因为 UTC 归一变成前一天，见 intake.ts 的 dayNoonIso）
    expect(timeline.find((t) => t.title === '部门开会说要优化')?.happened_at).toBe(
      '2026-08-28 04:00:00',
    );
    expect(timeline.some((t) => t.kind === '我方动作')).toBe(true);

    // 「现在做这三件事」= 库里的三张行动卡，不只是屏幕上的三行字
    const actions = f.db
      .prepare('SELECT title, due_at, priority FROM action_items WHERE case_id = ? AND title != ? ORDER BY priority DESC')
      .all(f.caseA, '去打社保记录') as { title: string; due_at: string | null; priority: number }[];
    expect(actions.map((a) => a.title)).toEqual(
      INTAKE_STAGE_ACTIONS['已收通知'].map((s) => s.title),
    );
    // 种子表里越靠前越急 → priority 越大；驾驶舱「只推一件事」推的就是它
    expect(actions[0].priority).toBeGreaterThan(actions[2].priority);
    expect(actions[0].due_at).not.toBeNull();
  });

  it('仲裁时效按记下的**最早**那件事起算（偏早＝偏保守），并写明起算点是暂定的', () => {
    const f = makeFixture();
    f.db.prepare('DELETE FROM deadlines WHERE case_id = ?').run(f.caseA);
    const res = submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake() });
    expect(res.ok && res.result.deadlinesAdded).toBe(1);

    const dl = f.db
      .prepare("SELECT kind, due_at, derived_from FROM deadlines WHERE case_id = ? AND kind = '仲裁时效'")
      .get(f.caseA) as { kind: string; due_at: string; derived_from: string };
    // 2026-08-28 起一年 → 2027-08-28（周六，顺延到周一 08-30）
    expect(dl.due_at.slice(0, 10)).toBe('2027-08-30');
    expect(dl.derived_from).toContain('2026-08-28');
    expect(dl.derived_from).toContain('保守估计');
  });

  it('一条日期都没记时**不落仲裁时效**——绝不拿"今天"当起算点，那会把到期日算晚', () => {
    const f = makeFixture();
    f.db.prepare('DELETE FROM deadlines WHERE case_id = ?').run(f.caseA);
    const res = submitIntake(f.db, {
      caseId: f.caseA,
      userId: f.userA,
      ...fullIntake({ events: [{ date: '', text: '权限被收走' }] }),
    });
    expect(res.ok && res.result.deadlinesAdded).toBe(0);
    expect(
      f.db.prepare('SELECT COUNT(*) n FROM deadlines WHERE case_id = ?').get(f.caseA),
    ).toEqual({ n: 0 });
  });

  it('风声 / 约谈中 阶段也不落仲裁时效：还没有可指认的侵害日', () => {
    const f = makeFixture();
    f.db.prepare('DELETE FROM deadlines WHERE case_id = ?').run(f.caseA);
    submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake({ stage: '约谈中' }) });
    expect(
      f.db.prepare('SELECT COUNT(*) n FROM deadlines WHERE case_id = ?').get(f.caseA),
    ).toEqual({ n: 0 });
  });

  it('别人的案件写不进去，且回的是"不存在"而不是 403', () => {
    const f = makeFixture();
    const res = submitIntake(f.db, { caseId: f.caseB, userId: f.userA, ...fullIntake() });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.status).toBe(404);
    expect(res.ok === false && res.errorCode).toBe('CASE_NOT_FOUND');
    // 乙的案子一个字都没被动
    expect(
      f.db.prepare('SELECT COUNT(*) n FROM timeline_events WHERE case_id = ?').get(f.caseB),
    ).toEqual({ n: 0 });
  });

  it('重复提交不长出第二套行动卡与第二家公司（时间线相反，只追加）', () => {
    const f = makeFixture();
    submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake() });
    const again = submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake() });
    expect(again.ok && again.result.actionsAdded).toBe(0);
    expect(
      f.db.prepare('SELECT COUNT(*) n FROM company_profiles WHERE case_id = ?').get(f.caseA),
    ).toEqual({ n: 1 });
    expect(
      f.db.prepare('SELECT COUNT(*) n FROM timeline_events WHERE case_id = ?').get(f.caseA),
    ).toEqual({ n: 12 });
  });
});

describe('必填项：服务端才是权威（前端那道可以被绕过）', () => {
  const bad: [string, Record<string, unknown>, string][] = [
    ['阶段不在词表里', { stage: '随便写' }, 'INVALID_STAGE'],
    ['公司名空着', { companyName: '   ' }, 'INVALID_COMPANY_NAME'],
    ['入职日期空着', { employedFrom: '' }, 'INVALID_EMPLOYED_FROM'],
    ['入职日期不是真日子', { employedFrom: '2026-02-31' }, 'INVALID_EMPLOYED_FROM'],
    ['入职日期在未来', { employedFrom: '2027-01-01' }, 'INVALID_EMPLOYED_FROM'],
    ['月工资不是正整数分', { monthlyWageFen: 0 }, 'INVALID_MONTHLY_WAGE'],
    ['月工资传了字符串', { monthlyWageFen: '22000' }, 'INVALID_MONTHLY_WAGE'],
    ['一项诉求都没选', { goals: [] }, 'INVALID_GOALS'],
  ];

  for (const [name, over, code] of bad) {
    it(`${name} → ${code}，且库里一个字都不写`, () => {
      const f = makeFixture();
      const res = submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake(over) });
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.errorCode).toBe(code);
      const row = f.db.prepare('SELECT * FROM cases WHERE id = ?').get(f.caseA) as Record<string, unknown>;
      expect(row.employed_from).toBeNull();
      expect(row.monthly_wage_fen).toBeNull();
      expect(
        f.db.prepare('SELECT COUNT(*) n FROM timeline_events WHERE case_id = ?').get(f.caseA),
      ).toEqual({ n: 0 });
    });
  }
});
