// app/src/lib/cases/__tests__/index.test.ts
// 第一优先级是**跨用户访问必须拒绝**：案件里是解除通知、工资流水、录音，
// 串号一次就是不可逆的隐私事故。每个对外函数都必须撞一遍这条红线，一个都不能漏。
import { describe, expect, test } from 'vitest';

import * as cases from '../index';
import { makeFixture } from './fixtures';

describe('跨用户访问（红线）', () => {
  test('乙拿甲的 case_id 调任何一个函数，都只得到 CASE_NOT_FOUND', () => {
    const { db, userB, caseA, actionA } = makeFixture();

    const attempts: Record<string, cases.Result<unknown>> = {
      getCase: cases.getCase(db, { caseId: caseA, userId: userB }),
      listActions: cases.listActions(db, { caseId: caseA, userId: userB }),
      listDeadlines: cases.listDeadlines(db, { caseId: caseA, userId: userB }),
      listEvidence: cases.listEvidence(db, { caseId: caseA, userId: userB }),
      // 【为什么这条也在】listDrafts 是 2026-09-01 新加的对外函数（文书页接真数据那一刀）。
      // 文书正文里是主张金额、对公司的措辞、要递给仲裁委的原话——串号一次比证据串号更直接。
      listDrafts: cases.listDrafts(db, { caseId: caseA, userId: userB }),
      updateCase: cases.updateCase(db, { caseId: caseA, userId: userB, stage: '已解除' }),
      addTimelineEvent: cases.addTimelineEvent(db, {
        caseId: caseA,
        userId: userB,
        happenedAt: '2026-08-19T00:00:00.000Z',
        kind: '公司动作',
        title: '偷看',
      }),
      setActionStatus: cases.setActionStatus(db, { caseId: caseA, userId: userB, actionId: actionA }),
      // 【为什么这条也在】confirmMilestone 是 2026-08-28 新加的对外函数，同样吃 caseId+userId。
      // 本文件开头那句"每个对外函数都必须撞一遍这条红线，一个都不能漏"如果不跟着长，
      // **红线的覆盖面就会随每个新函数悄悄缩小，而这张表本身永远是绿的**。
      // 注意参数给足（userConfirmed + 合法 milestone）：若靠缺参数拿 400，
      // 这条断言会变成在测参数校验，而不是在测归属校验——**归属必须先于一切校验**。
      confirmMilestone: cases.confirmMilestone(db, {
        caseId: caseA,
        userId: userB,
        eventId: 1,
        milestone: '协商',
        userConfirmed: true,
      }),
    };

    for (const [name, result] of Object.entries(attempts)) {
      expect(result, name).toMatchObject({ ok: false, status: 404, errorCode: 'CASE_NOT_FOUND' });
    }
  });

  test('"不是你的"与"不存在"返回完全相同的错误，不能靠报错分辨 id 是否被占用', () => {
    const { db, userB, caseA } = makeFixture();
    const notMine = cases.getCase(db, { caseId: caseA, userId: userB });
    const nonExistent = cases.getCase(db, { caseId: 999999, userId: userB });
    expect(notMine).toEqual(nonExistent);
  });

  test('越权的写操作不能留下任何痕迹', () => {
    const { db, userA, userB, caseA, actionA } = makeFixture();

    cases.updateCase(db, { caseId: caseA, userId: userB, stage: '结案' });
    cases.addTimelineEvent(db, {
      caseId: caseA,
      userId: userB,
      happenedAt: '2026-08-19T00:00:00.000Z',
      kind: '公司动作',
      title: '偷写',
    });
    cases.setActionStatus(db, { caseId: caseA, userId: userB, actionId: actionA });

    const after = cases.getCase(db, { caseId: caseA, userId: userA });
    expect(after).toMatchObject({ ok: true });
    if (!after.ok) return;
    expect(after.case.stage).toBe('风声');
    expect(after.timeline).toHaveLength(0);
    const actions = cases.listActions(db, { caseId: caseA, userId: userA });
    expect(actions.ok && actions.actions[0].status).toBe('待办');
  });

  test('行动项属于别的案件时按不存在处理', () => {
    const { db, userB, caseB, actionA } = makeFixture();
    // 乙用自己的案件 id + 甲案件下的行动项 id
    expect(cases.setActionStatus(db, { caseId: caseB, userId: userB, actionId: actionA })).toMatchObject({
      ok: false,
      status: 404,
      errorCode: 'ACTION_NOT_FOUND',
    });
  });
});

describe('枚举与参数校验', () => {
  test('stage 必须是法定枚举值', () => {
    const { db, userA, caseA } = makeFixture();
    expect(cases.updateCase(db, { caseId: caseA, userId: userA, stage: '随便写' })).toMatchObject({
      ok: false,
      status: 400,
      errorCode: 'INVALID_STAGE',
    });
    expect(cases.updateCase(db, { caseId: caseA, userId: userA, stage: '已解除' })).toMatchObject({
      ok: true,
    });
  });

  test('一个字段都不传要报错，别静默什么都不做', () => {
    const { db, userA, caseA } = makeFixture();
    expect(cases.updateCase(db, { caseId: caseA, userId: userA })).toMatchObject({
      ok: false,
      errorCode: 'NO_FIELDS',
    });
  });

  test('timeline kind 与 happened_at 都要校验', () => {
    const { db, userA, caseA } = makeFixture();
    const base = { caseId: caseA, userId: userA, title: '收到解除通知' };
    expect(
      cases.addTimelineEvent(db, { ...base, happenedAt: '2026-08-01T00:00:00Z', kind: '瞎编' }),
    ).toMatchObject({ errorCode: 'INVALID_KIND' });
    expect(
      cases.addTimelineEvent(db, { ...base, happenedAt: '不是时间', kind: '公司动作' }),
    ).toMatchObject({ errorCode: 'INVALID_HAPPENED_AT' });
    expect(
      cases.addTimelineEvent(db, { ...base, happenedAt: '2026-08-01T00:00:00Z', kind: '公司动作', title: '   ' }),
    ).toMatchObject({ errorCode: 'INVALID_TITLE' });
  });

  test('action status 只能是三个法定值', () => {
    const { db, userA, caseA, actionA } = makeFixture();
    expect(
      cases.setActionStatus(db, { caseId: caseA, userId: userA, actionId: actionA, status: 'done' }),
    ).toMatchObject({ errorCode: 'INVALID_STATUS' });
  });
});

describe('正常流程', () => {
  test('改档案 → 加时间线 → 完成行动卡，读回来都对得上', () => {
    const { db, userA, caseA, actionA } = makeFixture();

    expect(
      cases.updateCase(db, {
        caseId: caseA,
        userId: userA,
        stage: '已收通知',
        goal: '拿到 2N',
        bottomLine: '不低于 N+1',
      }),
    ).toMatchObject({ ok: true });

    const added = cases.addTimelineEvent(db, {
      caseId: caseA,
      userId: userA,
      happenedAt: '2026-08-15T09:30:00+08:00',
      kind: '公司动作',
      title: 'HR 约谈，口头通知裁员',
      detail: '会议室只有 HR 和我，无第三人',
    });
    expect(added).toMatchObject({ ok: true });
    // 时间归一到 ADR-002 canonical（UTC 空格格式秒精度）
    expect(added.ok && added.event.happened_at).toBe('2026-08-15 01:30:00');

    expect(
      cases.setActionStatus(db, { caseId: caseA, userId: userA, actionId: actionA }),
    ).toMatchObject({ ok: true, action: { status: '完成' } });

    const detail = cases.getCase(db, { caseId: caseA, userId: userA });
    expect(detail).toMatchObject({ ok: true });
    if (!detail.ok) return;
    expect(detail.case).toMatchObject({ stage: '已收通知', goal: '拿到 2N', bottom_line: '不低于 N+1' });
    expect(detail.timeline).toHaveLength(1);

    // 待办已清空，完成态能查到
    expect(cases.listActions(db, { caseId: caseA, userId: userA, status: '待办' })).toMatchObject({
      ok: true,
      actions: [],
    });
    const completed = cases.listActions(db, { caseId: caseA, userId: userA, status: '完成' });
    expect(completed.ok && completed.actions).toHaveLength(1);
  });

  test('期限默认只列生效中的，evidence 只回元数据', () => {
    const { db, userA, caseA } = makeFixture();
    db.prepare(
      "INSERT INTO deadlines (case_id, kind, due_at, resolved_at, created_at) VALUES (?, '开庭', '2026-09-01T00:00:00.000Z', '2026-09-01T12:00:00.000Z', '2026-08-19T00:00:00.000Z')",
    ).run(caseA);

    const active = cases.listDeadlines(db, { caseId: caseA, userId: userA });
    expect(active.ok && active.deadlines).toHaveLength(1);
    const all = cases.listDeadlines(db, { caseId: caseA, userId: userA, includeResolved: true });
    expect(all.ok && all.deadlines).toHaveLength(2);

    const evidence = cases.listEvidence(db, { caseId: caseA, userId: userA });
    expect(evidence.ok && evidence.evidence[0]).toMatchObject({ name: '劳动合同', category: '合同' });
    // 落盘路径这类东西不该出现在列表里
    expect(JSON.stringify(evidence)).not.toContain('enc_path');
  });

  test('文书按案件列、新的在前，正文一并回；别人的文书一份都不掺', () => {
    const { db, userA, caseA, caseB } = makeFixture();
    const insert = db.prepare(
      "INSERT INTO drafts (case_id, kind, title, content, version, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'draft', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')",
    );
    insert.run(caseA, '异议函', '解除通知异议函', '本人不认可解除理由……');
    insert.run(caseA, '证据清单', '证据清单（第一批）', '一、劳动合同一份……');
    insert.run(caseB, '异议函', '乙的异议函', '乙的正文');

    const drafts = cases.listDrafts(db, { caseId: caseA, userId: userA });
    expect(drafts.ok && drafts.drafts.map((d) => d.title)).toEqual([
      '证据清单（第一批）',
      '解除通知异议函',
    ]);
    // 正文要回：文书页打开就要读全文，回一个空壳等于页面上一片白
    expect(drafts.ok && drafts.drafts[1].content).toBe('本人不认可解除理由……');
    expect(JSON.stringify(drafts)).not.toContain('乙的');
  });

  test('timeline_limit 会被夹在 1..200，异常值不炸', () => {
    const { db, userA, caseA } = makeFixture();
    for (let i = 0; i < 3; i++) {
      cases.addTimelineEvent(db, {
        caseId: caseA,
        userId: userA,
        happenedAt: `2026-08-0${i + 1}T00:00:00Z`,
        kind: '我方动作',
        title: `事件${i}`,
      });
    }
    expect((cases.getCase(db, { caseId: caseA, userId: userA, timelineLimit: 2 }) as { timeline: unknown[] }).timeline).toHaveLength(2);
    expect((cases.getCase(db, { caseId: caseA, userId: userA, timelineLimit: -5 }) as { timeline: unknown[] }).timeline).toHaveLength(3);
    expect((cases.getCase(db, { caseId: caseA, userId: userA, timelineLimit: 99999 }) as { timeline: unknown[] }).timeline).toHaveLength(3);
  });
});

/**
 * 写入幂等：写接口无幂等，agent 重试即双写（生产 case2 实测同一次调岗落两条）。
 * 两道去重都在 addTimelineEvent 这一个入口上。
 */
describe('时间线写入去重', () => {
  const rows = (db: import('better-sqlite3').Database, caseId: number) =>
    db.prepare('SELECT id, title FROM timeline_events WHERE case_id = ? ORDER BY id').all(caseId) as {
      id: number;
      title: string;
    }[];

  test('同 client_ref 重放：只落一行，第二次回既有行 + deduped', () => {
    const { db, userA, caseA } = makeFixture();
    const base = {
      caseId: caseA,
      userId: userA,
      happenedAt: '2026-08-15T09:30:00+08:00',
      kind: '公司动作' as const,
      title: 'HR 约谈',
      clientRef: 'op-abc-1',
    };
    const first = cases.addTimelineEvent(db, base);
    // 重放时连 happened_at 都换一下：client_ref 一致就该认成同一次操作，不看别的字段
    const again = cases.addTimelineEvent(db, { ...base, happenedAt: '2026-08-16T10:00:00+08:00' });
    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(first.deduped).toBe(false);
    expect(again.deduped).toBe(true);
    expect(again.event.id).toBe(first.event.id);
    expect(rows(db, caseA)).toHaveLength(1);
  });

  test('无 client_ref 近重复（同日+同 kind+标题去标点空白相等）：只落一行', () => {
    const { db, userA, caseA } = makeFixture();
    const first = cases.addTimelineEvent(db, {
      caseId: caseA,
      userId: userA,
      happenedAt: '2026-08-15T09:30:00+08:00',
      kind: '公司动作',
      title: 'HR 约谈，口头通知裁员',
    });
    // 同一天、同 kind，标题只差空白与标点 —— 塌缩成同一条
    const dup = cases.addTimelineEvent(db, {
      caseId: caseA,
      userId: userA,
      happenedAt: '2026-08-15T18:00:00+08:00',
      kind: '公司动作',
      title: 'HR约谈，口头通知裁员。',
    });
    expect(first.ok).toBe(true);
    expect(dup.ok).toBe(true);
    if (!first.ok || !dup.ok) return;
    expect(dup.deduped).toBe(true);
    expect(dup.event.id).toBe(first.event.id);
    expect(rows(db, caseA)).toHaveLength(1);
  });

  test('真不同的事件照常各落一行：换标题、换天、换 kind 都不算重复', () => {
    const { db, userA, caseA } = makeFixture();
    const add = (over: Record<string, unknown>) =>
      cases.addTimelineEvent(db, {
        caseId: caseA,
        userId: userA,
        happenedAt: '2026-08-15T09:30:00+08:00',
        kind: '公司动作',
        title: 'HR 约谈',
        ...over,
      });
    add({});
    add({ title: '收到解除通知' }); // 同日同 kind，标题不同 → 新事件
    add({ happenedAt: '2026-08-16T09:30:00+08:00' }); // 同标题同 kind，不同天 → 新事件
    add({ kind: '我方动作' }); // 同标题同日，不同 kind → 新事件
    expect(rows(db, caseA)).toHaveLength(4);
  });
});

/** case_update 扩了用工基本盘四项：让 agent 能零散补齐，不必重走首诊。 */
describe('case_update 用工基本盘', () => {
  const NOW = new Date('2026-09-02T00:00:00Z');
  const caseRow = (db: import('better-sqlite3').Database, id: number) =>
    db.prepare('SELECT * FROM cases WHERE id = ?').get(id) as Record<string, unknown>;

  test('四项可各自单独更新，不碰其它列', () => {
    const { db, userA, caseA } = makeFixture();
    expect(
      cases.updateCase(db, { caseId: caseA, userId: userA, employedFrom: '2021-04-12', now: NOW }),
    ).toMatchObject({ ok: true });
    expect(caseRow(db, caseA)).toMatchObject({ employed_from: '2021-04-12', monthly_wage_fen: null, position: null });

    expect(cases.updateCase(db, { caseId: caseA, userId: userA, monthlyWageFen: 2_200_000 })).toMatchObject({ ok: true });
    expect(cases.updateCase(db, { caseId: caseA, userId: userA, position: '仓储主管' })).toMatchObject({ ok: true });
    expect(cases.updateCase(db, { caseId: caseA, userId: userA, contractCount: '只签过一次' })).toMatchObject({ ok: true });

    expect(caseRow(db, caseA)).toMatchObject({
      employed_from: '2021-04-12',
      monthly_wage_fen: 2_200_000,
      position: '仓储主管',
      contract_count: '只签过一次',
    });
  });

  test('校验与首诊同口径：入职不晚于今天、月薪正整数分、字段不空', () => {
    const { db, userA, caseA } = makeFixture();
    expect(
      cases.updateCase(db, { caseId: caseA, userId: userA, employedFrom: '2027-01-01', now: NOW }),
    ).toMatchObject({ errorCode: 'INVALID_EMPLOYED_FROM' });
    expect(
      cases.updateCase(db, { caseId: caseA, userId: userA, employedFrom: '2026-02-31', now: NOW }),
    ).toMatchObject({ errorCode: 'INVALID_EMPLOYED_FROM' });
    expect(cases.updateCase(db, { caseId: caseA, userId: userA, monthlyWageFen: 0 })).toMatchObject({
      errorCode: 'INVALID_MONTHLY_WAGE',
    });
    expect(cases.updateCase(db, { caseId: caseA, userId: userA, position: '   ' })).toMatchObject({
      errorCode: 'INVALID_POSITION',
    });
    // 一列都没落
    expect(caseRow(db, caseA)).toMatchObject({ employed_from: null, monthly_wage_fen: null });
  });
});
