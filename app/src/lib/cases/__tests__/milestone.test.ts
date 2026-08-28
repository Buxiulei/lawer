// app/src/lib/cases/__tests__/milestone.test.ts
// 批 6 里程碑（契约 docs/contracts/case-milestone.md §六·二）的三条守卫 + 值域钉死。
//
// 【这三条为什么是正向断言】原裁定措辞是「断言服务端不存在任何绕过确认流的写点」——
// 那是**否定性存在断言**：找不到就绿，而"找不到"和"找错地方"外部同形，
// 更糟的是**实现被整段删掉时它照样绿**。改成下面三条，每条都断言一个能被观测到的正事实。
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import * as cases from '../index';
import { makeFixture } from './fixtures';

/** 建一条普通事件，返回它的 id */
function addPlainEvent(db: ReturnType<typeof makeFixture>['db'], caseId: number, userId: number) {
  const r = cases.addTimelineEvent(db, {
    caseId,
    userId,
    happenedAt: '2026-08-20T00:00:00.000Z',
    kind: '公司动作',
    title: '发了解除通知',
  });
  if (!r.ok) throw new Error('前置失败：普通事件没建起来');
  return r.event.id;
}

describe('守卫 a：通用写路径设不上 milestone', () => {
  test('走 addTimelineEvent 落库的行，milestone 恒为 NULL', () => {
    const { db, userA, caseA } = makeFixture();
    const id = addPlainEvent(db, caseA, userA);

    const got = cases.getCase(db, { caseId: caseA, userId: userA });
    expect(got.ok).toBe(true);
    const row = got.ok ? got.timeline.find((e) => e.id === id) : undefined;
    expect(row).toBeDefined();
    // 【断言的是运行时事实，不是类型】类型在运行时不存在；这里验的是"真的没写进去"。
    expect(row!.milestone).toBeNull();
  });

  test('就算调用方硬塞 milestone 字段，通用路径也不该把它带进库', () => {
    const { db, userA, caseA } = makeFixture();
    // 故意多传一个契约里不存在的字段（模拟前端/agent 手滑或存心）
    const r = cases.addTimelineEvent(db, {
      caseId: caseA,
      userId: userA,
      happenedAt: '2026-08-20T00:00:00.000Z',
      kind: '公司动作',
      title: '硬塞',
      ...({ milestone: '立案' } as Record<string, unknown>),
    });
    expect(r.ok).toBe(true);
    const got = cases.getCase(db, { caseId: caseA, userId: userA });
    const row = got.ok ? got.timeline.find((e) => e.title === '硬塞') : undefined;
    expect(row!.milestone).toBeNull();
  });
});

describe('守卫 b：唯一写点自己也拦', () => {
  test('缺确认凭据 → 400 MILESTONE_NOT_CONFIRMED', () => {
    const { db, userA, caseA } = makeFixture();
    const id = addPlainEvent(db, caseA, userA);
    const r = cases.confirmMilestone(db, { caseId: caseA, userId: userA, eventId: id, milestone: '协商' });
    expect(r).toMatchObject({ ok: false, status: 400, errorCode: 'MILESTONE_NOT_CONFIRMED' });
  });

  test('凭据不是 true（给个真值冒充）也拦', () => {
    const { db, userA, caseA } = makeFixture();
    const id = addPlainEvent(db, caseA, userA);
    for (const forged of ['true', 1, {}, 'yes']) {
      const r = cases.confirmMilestone(db, {
        caseId: caseA,
        userId: userA,
        eventId: id,
        milestone: '协商',
        userConfirmed: forged,
      });
      expect(r, String(forged)).toMatchObject({ ok: false, errorCode: 'MILESTONE_NOT_CONFIRMED' });
    }
  });

  test('凭据齐了、值非法 → 400 INVALID_MILESTONE', () => {
    const { db, userA, caseA } = makeFixture();
    const id = addPlainEvent(db, caseA, userA);
    // '已立案' 是 stage 的词，不是里程碑的词——正是子集方案会放过的那类错
    for (const bad of ['已立案', '仲裁准备', '约谈中', '结案', '', 'Filed']) {
      const r = cases.confirmMilestone(db, {
        caseId: caseA,
        userId: userA,
        eventId: id,
        milestone: bad,
        userConfirmed: true,
      });
      expect(r, bad).toMatchObject({ ok: false, status: 400, errorCode: 'INVALID_MILESTONE' });
    }
  });

  test('凭据齐、值合法 → 真的写进去了（否则上面三条全绿也只证明它什么都不做）', () => {
    const { db, userA, caseA } = makeFixture();
    for (const ok of cases.CASE_MILESTONES) {
      const id = addPlainEvent(db, caseA, userA);
      const r = cases.confirmMilestone(db, {
        caseId: caseA,
        userId: userA,
        eventId: id,
        milestone: ok,
        userConfirmed: true,
      });
      expect(r, ok).toMatchObject({ ok: true });
      if (r.ok) expect(r.event.milestone).toBe(ok);
    }
  });

  test('事件不属于本案 → 404，不是静默无操作', () => {
    const { db, userA, caseA, caseB, userB } = makeFixture();
    const idInB = addPlainEvent(db, caseB, userB);
    const r = cases.confirmMilestone(db, {
      caseId: caseA,
      userId: userA,
      eventId: idInB,
      milestone: '协商',
      userConfirmed: true,
    });
    expect(r).toMatchObject({ ok: false, status: 404, errorCode: 'EVENT_NOT_FOUND' });
  });
});

describe('守卫 c：写 milestone 列的 SQL 恰好一条', () => {
  // 【为什么只数写、不数读】契约原文写的是"触碰该列的 SQL"，但 listTimelineEvents 的
  // SELECT 也正当地触碰它。按字面数会恒为 2，判据永远红——**这是落地时才暴露的措辞问题**。
  // 真正要防的是"另开一个写入后门"，所以数的是 INSERT/UPDATE。
  //
  // 【为什么是 toBe(1) 不是 ≤1】`≤1` 同时容忍"零个"，而零个意味着这条契约根本没被实现——
  // 上界式断言在实现被删光时静默变绿，精确式两个方向都红。
  test('lib/db/cases.ts 里写该列的语句数 === 1', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/db/cases.ts'),
      'utf8',
    );
    const writes = src
      .split('\n')
      .filter((line) => /(INSERT INTO|UPDATE)\s+timeline_events/i.test(line) && /milestone/.test(line));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/UPDATE timeline_events SET milestone/);
  });

  test('这条守卫自己没瞎——把匹配规则指向不存在的列时必须数出 0', () => {
    // 若上一条的正则写错了地方（比如路径错、文件读空），它会恒为 0 而不是 1；
    // 这条反过来证明"数得出东西"这件事本身是真的。
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/db/cases.ts'), 'utf8');
    expect(src.length).toBeGreaterThan(1000); // 文件真的读到了
    const nonexistent = src
      .split('\n')
      .filter((l) => /(INSERT INTO|UPDATE)\s+timeline_events/i.test(l) && /milestone_xyz/.test(l));
    expect(nonexistent).toHaveLength(0);
  });
});

describe('值域与全量表', () => {
  test('CASE_MILESTONES 逐字钉死（改一个字要来改这条，不许顺手改）', () => {
    expect([...cases.CASE_MILESTONES]).toEqual([
      '协商', '仲裁申请', '立案', '开庭', '裁决', '一审', '二审', '执行',
    ]);
  });

  test('里程碑词表与 stage 词表不重叠——它们是两种东西，不是一套词的两半', () => {
    const stages = new Set<string>(cases.CASE_STAGES);
    const overlap = cases.CASE_MILESTONES.filter((m) => stages.has(m));
    // '开庭' / '裁决' / '一审' / '二审' / '执行' 两边同名是巧合（同一个词表达同一件事），
    // 这里断言的是**没有一字之差的近义对**：'立案' 不能因为 stage 里有 '已立案' 就被当成它。
    expect(overlap).toEqual(['开庭', '裁决', '一审', '二审', '执行']);
    expect(stages.has('立案')).toBe(false);
    expect(stages.has('协商')).toBe(false);
    expect(stages.has('仲裁申请')).toBe(false);
  });

  test('MILESTONE_OF_STAGE 覆盖每一个 stage（编译期已保证，这里防有人用断言绕过）', () => {
    for (const s of cases.CASE_STAGES) {
      expect(Object.prototype.hasOwnProperty.call(cases.MILESTONE_OF_STAGE, s), s).toBe(true);
    }
    expect(Object.keys(cases.MILESTONE_OF_STAGE)).toHaveLength(cases.CASE_STAGES.length);
  });

  test('表里的每个非空值都是合法里程碑', () => {
    for (const [stage, m] of Object.entries(cases.MILESTONE_OF_STAGE)) {
      if (m !== null) expect(cases.CASE_MILESTONES, stage).toContain(m);
    }
  });
});
