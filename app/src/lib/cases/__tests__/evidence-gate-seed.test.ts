// app/src/lib/cases/__tests__/evidence-gate-seed.test.ts
// **强制取证行动卡**的落卡判据（设计稿 §4.2-2 / §4.4-7「陪跑节奏由服务端驱动」）。
//
// 【为什么由服务端在 stage 变更时落，而不是让模型想着建】靠模型记得的形态是——
// 它这一轮忘了，用户就在最后一个能补证的窗口里什么都没被提醒，
// 而那一轮的回复看起来与别的轮次没有任何区别。
import { describe, expect, it } from 'vitest';

import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

import { addTimelineEvent, updateCase, upsertCompany } from '..';
import { makeFixture } from './fixtures';

const GATE = DOMAINS[DEFAULT_DOMAIN].evidenceGate!;
const GATE_STAGE = GATE.stages[0];

/** 本案有几张标题相同的待办 */
function seeded(db: ReturnType<typeof makeFixture>['db'], caseId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM action_items WHERE case_id = ? AND title = ? AND status = '待办'")
      .get(caseId, GATE.action.title) as { n: number }
  ).n;
}

/** 往案子里塞一条**自述档**的时间线事件（取证闸要求"有事实、但一条书证都没有"） */
function selfReportedEvent(f: ReturnType<typeof makeFixture>, title = '收到解除通知') {
  const res = addTimelineEvent(f.db, {
    caseId: f.caseA,
    userId: f.userA,
    happenedAt: '2026-08-20T10:00:00+08:00',
    kind: '公司动作',
    title,
  });
  expect(res.ok).toBe(true);
}

describe('取证闸的落卡', () => {
  it('进窗口 + 关键事实全自述 ⇒ 落一张强制取证卡（变异：把 seedEvidenceGateAction 那一句删掉 → 红）', () => {
    const f = makeFixture();
    selfReportedEvent(f);
    const res = updateCase(f.db, { caseId: f.caseA, userId: f.userA, stage: GATE_STAGE });
    expect(res.ok).toBe(true);
    expect(seeded(f.db, f.caseA)).toBe(1);
  });

  it('已经有一条书证 ⇒ 不落卡（变异：把 noDocumentedFact 判反 → 红：有证据的人也被催）', () => {
    const f = makeFixture();
    const res = addTimelineEvent(f.db, {
      caseId: f.caseA,
      userId: f.userA,
      happenedAt: '2026-08-20T10:00:00+08:00',
      kind: '公司动作',
      title: '收到解除通知',
      sourceTier: '书证',
    });
    expect(res.ok).toBe(true);
    updateCase(f.db, { caseId: f.caseA, userId: f.userA, stage: GATE_STAGE });
    expect(seeded(f.db, f.caseA)).toBe(0);
  });

  it('阶段不在窗口里 ⇒ 不落卡（变异：去掉 stages 判定 → 红：每次改阶段都落一张）', () => {
    const f = makeFixture();
    selfReportedEvent(f);
    updateCase(f.db, { caseId: f.caseA, userId: f.userA, stage: '已收通知' });
    expect(seeded(f.db, f.caseA)).toBe(0);
  });

  it('档案还空着 ⇒ 不落卡（变异：空案子也落 → 红：刚建档就被催取证）', () => {
    const f = makeFixture();
    updateCase(f.db, { caseId: f.caseA, userId: f.userA, stage: GATE_STAGE });
    expect(seeded(f.db, f.caseA)).toBe(0);
  });

  it('反复进出这个阶段只会有一张（变异：换掉 insertActionItem 的同题去重 → 红：堆成三张）', () => {
    const f = makeFixture();
    selfReportedEvent(f);
    for (const stage of [GATE_STAGE, '已收通知', GATE_STAGE, GATE_STAGE]) {
      updateCase(f.db, { caseId: f.caseA, userId: f.userA, stage });
    }
    expect(seeded(f.db, f.caseA)).toBe(1);
  });

  it('只改 goal 不落卡（变异：把落卡挂在任意字段更新上 → 红）', () => {
    const f = makeFixture();
    selfReportedEvent(f);
    updateCase(f.db, { caseId: f.caseA, userId: f.userA, stage: GATE_STAGE });
    f.db.prepare("UPDATE action_items SET status = '完成' WHERE case_id = ?").run(f.caseA);
    updateCase(f.db, { caseId: f.caseA, userId: f.userA, goal: '拿到 2N' });
    expect(seeded(f.db, f.caseA)).toBe(0);
  });
});

describe('写入口的档位校验', () => {
  it('不给档位就落缺省档（变异：把 DDL 默认值改掉 → 红）', () => {
    const f = makeFixture();
    selfReportedEvent(f);
    const row = f.db
      .prepare('SELECT source_tier, asserted_by FROM timeline_events WHERE case_id = ?')
      .get(f.caseA);
    expect(row).toEqual({ source_tier: '自述', asserted_by: 'user' });
  });

  it('档位写错 ⇒ INVALID_SOURCE_TIER 且零写入（变异：认不出时折成缺省档 → 红）', () => {
    const f = makeFixture();
    const res = addTimelineEvent(f.db, {
      caseId: f.caseA,
      userId: f.userA,
      happenedAt: '2026-08-20T10:00:00+08:00',
      kind: '公司动作',
      title: '档位写错的一条',
      sourceTier: '书面证据',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('INVALID_SOURCE_TIER');
    expect(
      (f.db.prepare('SELECT COUNT(*) AS n FROM timeline_events WHERE case_id = ?').get(f.caseA) as {
        n: number;
      }).n,
    ).toBe(0);
  });

  it('档位校验排在去重之前（变异：把它挪到去重之后 → 红：同一份参数第一次被拒、第二次成功）', () => {
    const f = makeFixture();
    selfReportedEvent(f, '同一件事');
    const again = addTimelineEvent(f.db, {
      caseId: f.caseA,
      userId: f.userA,
      happenedAt: '2026-08-20T10:00:00+08:00',
      kind: '公司动作',
      title: '同一件事',
      sourceTier: '书面证据',
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.errorCode).toBe('INVALID_SOURCE_TIER');
  });

  it('对方主体也带档位（变异：upsertCompany 丢掉 origin → 红）', () => {
    const f = makeFixture();
    const res = upsertCompany(f.db, {
      caseId: f.caseA,
      userId: f.userA,
      name: '某某科技有限公司',
      sourceTier: '对方认可',
      assertedBy: 'agent_inferred',
    });
    expect(res.ok).toBe(true);
    expect(
      f.db.prepare('SELECT source_tier, asserted_by FROM company_profiles WHERE case_id = ?').get(f.caseA),
    ).toEqual({ source_tier: '对方认可', asserted_by: 'agent_inferred' });
  });

  it('补充字段时不带档位 ⇒ 那两列一个字节不动（变异：不带时回落缺省档 → 红：补一句备注就把档位降回自述）', () => {
    const f = makeFixture();
    upsertCompany(f.db, {
      caseId: f.caseA,
      userId: f.userA,
      name: '某某科技有限公司',
      sourceTier: '裁审认定',
      assertedBy: 'system',
    });
    upsertCompany(f.db, {
      caseId: f.caseA,
      userId: f.userA,
      name: '某某科技有限公司',
      note: '经营异常',
    });
    expect(
      f.db.prepare('SELECT source_tier, asserted_by FROM company_profiles WHERE case_id = ?').get(f.caseA),
    ).toEqual({ source_tier: '裁审认定', asserted_by: 'system' });
  });
});
