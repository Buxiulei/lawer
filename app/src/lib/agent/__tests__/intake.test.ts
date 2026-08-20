// app/src/lib/agent/__tests__/intake.test.ts
// 问诊状态机（charter §4）。状态是从档案推出来的纯函数，所以这里直接造快照断言迁移。
import { describe, expect, it } from 'vitest';

import * as agentStore from '@/lib/db/agent';
import * as cases from '@/lib/cases';
import { intakeDirective, intakeStage, recapBrief } from '../intake';
import * as agentDb from '@/lib/db/agent';
import { loadCaseSnapshot } from '../snapshot';
import { makeAgentFixture } from './fixtures';

/** 按顺序把档案填到某一档，返回夹具 */
function fillTo(target: 'A' | 'B' | 'C' | 'D' | 'done') {
  const f = makeAgentFixture();
  const order = ['A', 'B', 'C', 'D', 'done'];
  const at = (s: string) => order.indexOf(target) > order.indexOf(s);

  if (at('A')) {
    agentStore.upsertCompanyProfile(f.db, {
      caseId: f.caseId,
      name: '某安全科技有限公司',
      uscc: null,
      role: '签约主体',
      legalRep: null,
      riskNotes: null,
      sourcesJson: null,
    });
    cases.addTimelineEvent(f.db, {
      caseId: f.caseId,
      userId: f.userId,
      happenedAt: '2026-08-19T12:40:00Z',
      kind: '公司动作',
      title: '收到《解除劳动合同通知书》',
    });
  }
  if (at('B')) {
    for (const [i, title] of ['被停用邮箱权限', '主管口头通知回家等消息'].entries()) {
      cases.addTimelineEvent(f.db, {
        caseId: f.caseId,
        userId: f.userId,
        happenedAt: `2026-08-1${i + 5}T02:00:00Z`,
        kind: '公司动作',
        title,
      });
    }
  }
  if (at('C')) {
    cases.updateCase(f.db, { caseId: f.caseId, userId: f.userId, goal: '按违法解除拿 2N', bottomLine: '不低于 N+1' });
  }
  if (at('D')) {
    // D 档落痕改走 threads.intake_stage（WS1 2026-08-19 增列），不再借时间线标记
    const thread = agentDb.ensureThread(f.db, f.caseId, '问诊');
    agentDb.updateIntakeStage(f.db, thread.id, 'done');
  }
  return f;
}

describe('intakeStage：A → B → C → D → done 逐档迁移', () => {
  it('空档案落在 A（基本盘）', () => {
    const f = fillTo('A');
    expect(intakeStage(loadCaseSnapshot(f.db, f.caseId))).toBe('A');
  });

  it('有了公司主体与第一条事件，进 B（事态进展）', () => {
    const f = fillTo('B');
    expect(intakeStage(loadCaseSnapshot(f.db, f.caseId))).toBe('B');
  });

  it('时间线攒够 3 条事实事件，进 C（目标底线）', () => {
    const f = fillTo('C');
    const s = loadCaseSnapshot(f.db, f.caseId);
    expect(s.timeline.length).toBe(3);
    expect(intakeStage(s)).toBe('C');
  });

  it('goal 与 bottom_line 都填了才进 D，只填一个仍停在 C', () => {
    const f = fillTo('C');
    cases.updateCase(f.db, { caseId: f.caseId, userId: f.userId, goal: '拿 2N' });
    expect(intakeStage(loadCaseSnapshot(f.db, f.caseId))).toBe('C');
    cases.updateCase(f.db, { caseId: f.caseId, userId: f.userId, bottomLine: '不低于 N' });
    expect(intakeStage(loadCaseSnapshot(f.db, f.caseId))).toBe('D');
  });

  it('threads.intake_stage 落痕为 done 后首诊走完', () => {
    const f = fillTo('done');
    expect(intakeStage(loadCaseSnapshot(f.db, f.caseId))).toBe('done');
  });

  it('系统动作不算进 B 档的事实事件数（标记不能顶替真事件）', () => {
    const f = fillTo('B');
    for (let i = 0; i < 5; i++) {
      cases.addTimelineEvent(f.db, {
        caseId: f.caseId,
        userId: f.userId,
        happenedAt: '2026-08-19T13:00:00Z',
        kind: '系统动作',
        title: `系统记账 ${i}`,
      });
    }
    expect(intakeStage(loadCaseSnapshot(f.db, f.caseId))).toBe('B');
  });
});

describe('intakeDirective：每轮 1-3 问的纪律写进指令', () => {
  it('每一档都明确「挑最关键的 1-3 个问」（C04 G7）', () => {
    for (const stage of ['A', 'B', 'C', 'D'] as const) {
      const d = intakeDirective(stage);
      expect(d).toContain('1-3');
      expect(d).toContain('charter §4');
    }
  });

  it('D 档指令告诉模型调 intake_done 落痕，否则首诊永远走不完', () => {
    expect(intakeDirective('D')).toContain('intake_done');
  });

  it('done 档不再例行问诊，只在有新事实时追问', () => {
    expect(intakeDirective('done')).toContain('不做例行问诊');
  });
});

describe('recapBrief：陪跑开场的前情提要（charter §4 末条）', () => {
  it('带上案件阶段与未完成待办，并要求问障碍不指责', () => {
    const f = fillTo('done');
    f.db
      .prepare("INSERT INTO action_items (case_id, title, status, priority) VALUES (?, '导出近12个月工资流水', '待办', 2)")
      .run(f.caseId);
    const brief = recapBrief(loadCaseSnapshot(f.db, f.caseId));
    expect(brief).toContain('已收通知');
    expect(brief).toContain('导出近12个月工资流水');
    expect(brief).toContain('不要指责');
  });

  it('没有待办时如实说没有，不编一个出来', () => {
    const f = fillTo('done');
    expect(recapBrief(loadCaseSnapshot(f.db, f.caseId))).toContain('没有跟踪中的待办');
  });
});
