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
