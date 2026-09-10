// app/src/lib/agent/__tests__/element-budget.test.ts
// **预算实测**（S6 判据五）：最长案件——四项诉求全开 + 时间线 30 条（快照窗口上限）——
// 事实卡仍在 4600 字预算内，且要件表那一节**没有被降级掉**。
//
// 【为什么必须实测而不是估算】milestone-a3 那次就是按数据形态估的，数据一变就把 25k 字符
// 灌进了 prompt。这一票往事实卡里加了一整节，加的又是"档案越厚越长"的那一类内容
//（要件数 = 诉求数 × 每诉求要件数）——**估算在这里正好会往乐观方向错**。
//
// 【为什么要连"没被降级"一起钉】只钉"没超预算"是可以靠把要件表整节压掉来满足的：
// 那样判据全绿，而用户最需要要件表的那些厚档案案子恰好一行都看不到。
// 所以两条断言必须并排：**总长在预算内** ∧ **要件表整节仍在**。
//
// 【工具轮次】本片新增的读路径（要件表 / 争点表）随事实卡一起到达，
// 不需要模型多调一轮工具，所以轮次上限一个字都没动——这里把那个上限钉住，
// 变了就必须有人来改这条判据（见下面那一条的注释）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { CaseRow } from '@/lib/db/cases';
import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

import { buildCaseFacts, CASE_FACTS_BUDGET, renderCaseFacts } from '../case-facts';
import { buildSystemPrompt } from '../prompt';
import type { CaseSnapshot } from '../snapshot';

const LABOR = DOMAINS[DEFAULT_DOMAIN];
/** 快照就是按这个窗口取时间线的（snapshot.ts 的 TIMELINE_WINDOW）。最长案件 = 装满它。 */
const TIMELINE_WINDOW = 30;
/** 派单点名的四项诉求。 */
const FOUR_KINDS = ['2N', 'N', '欠薪', '双倍工资'];

const CASE_BASE: CaseRow = {
  id: 7,
  user_id: 1,
  title: '一个字段全填满、时间线装满窗口的最长案件',
  stage: '仲裁准备',
  district: '朝阳',
  domain: DEFAULT_DOMAIN,
  track: null,
  goal: '把四项诉求一起提，尽量拿到全额；不接受只给一半的和解方案。'.repeat(4),
  bottom_line: '低于全额七成不签。'.repeat(6),
  employed_from: '2018-03-01',
  position: '高级产品经理（增长方向）',
  monthly_wage_fen: 3_800_000,
  contract_count: '2 次（第二次到期前被解除）',
  created_at: '2026-08-01 09:00:00',
  updated_at: '2026-09-10 09:00:00',
} as unknown as CaseRow;

function snapshot(): CaseSnapshot {
  const timeline = Array.from({ length: TIMELINE_WINDOW }, (_, i) => ({
    id: 500 + i,
    case_id: 7,
    happened_at: `2026-0${1 + (i % 8)}-${String(1 + (i % 27)).padStart(2, '0')} 09:00:00`,
    kind: i % 2 === 0 ? '公司动作' : '我方动作',
    // 【第一条必须是那份解除决定】（2026-09-10「公司动作」票）本夹具登记着 2N 与 N ——
    // 一个主张违法解除赔偿金的案子，档案里必然记着公司作出解除的那一刻。「公司动作」这个槽
    // 现在过取值判定（记的是不是公司**已经作出**的解除/终止决定），泛泛的一句
    // 「公司又出了一份新的说法」判不过，于是 2N-2 / 2N-3 / N-2a 三条一起落「缺失」——
    // 那是**这份夹具自相矛盾**（主张 2N 却一条解除记录都没有），不是要件表算错了。
    title:
      i === 0
        ? '第 1 件事：公司送达《解除劳动合同通知书》，理由写的是"客观情况发生重大变化"'
        : `第 ${i + 1} 件事：公司这边又出了一份新的说法，我当天做了书面回应`,
    detail: '细节写满一行，长度贴近渲染器的单条上限，好让预算测得到最坏情形。'.repeat(2),
    milestone: null,
    source_tier: i % 3 === 0 ? '书证' : '自述',
    asserted_by: 'user',
    created_at: '2026-09-01 09:00:00',
  })) as unknown as CaseSnapshot['timeline'];

  // 【为什么诉求要多于四项】要件表只画那四项（别的诉求没有要件卡），但诉求区本身
  // 也在抢预算。压到 CLAIMS_MAX 是为了让降级真的发生在 P2 上——压力不够大的时候，
  // 「要件表是 P1」这件事不产生任何后果，那条变异臂就是装饰。
  const claims = [...FOUR_KINDS, '年假', '加班费', '年终奖', '竞业补偿', 'N+1', '其他'].map((kind, i) => ({
    id: 10 + i,
    case_id: 7,
    kind,
    amount_fen: 1_000_000 * (i + 1),
    calc_json: null,
    basis: '依据串也占字数，按真实形态给：《某法》第四十七条、第八十七条、第八十二条，另见实施条例第二十七条',
    status: 'draft',
    source_tier: '自述',
    asserted_by: 'user',
    created_at: '2026-09-01 09:00:00',
  })) as unknown as CaseSnapshot['claims'];

  const evidence = Array.from({ length: 12 }, (_, i) => ({
    id: 100 + i,
    case_id: 7,
    name: `材料-${i + 1}-名字也给到上限附近.pdf`,
    category: ['合同', '工资', '社保', '考勤', '沟通记录', '公司文件'][i % 6],
    prove_purpose: '证明某一件具体的事，这句话按证明目的的长度上限写满',
    status: '已上传',
    created_at: '2026-08-20 09:00:00',
    extraction_status: 'none',
    extracted_at: null,
    brief_json: null,
    brief_version: 0,
    brief_error: null,
    void_reason: null,
    voided_at: null,
    brief_source_tier: '自述',
    brief_asserted_by: 'user',
  })) as unknown as CaseSnapshot['evidence'];

  return {
    case: CASE_BASE,
    identity: { realName: '李哲', authStatus: '已认证', nameUnreadable: false },
    evidence,
    historyStats: { total: 48, firstAt: '2026-08-01 09:00:00' },
    timeline,
    timelineStats: { total: 96, earliest: timeline[timeline.length - 1] },
    claims,
    companies: [
      { id: 1, case_id: 7, name: '某某科技（北京）有限公司', uscc: '91110105MA00000000', role: '签约主体', legal_rep: '张某', risk_notes: null, sources_json: null, source_tier: '自述', asserted_by: 'user', created_at: '2026-08-01 09:00:00' },
      { id: 2, case_id: 7, name: '某某信息服务有限公司', uscc: null, role: '用工主体', legal_rep: null, risk_notes: null, sources_json: null, source_tier: '自述', asserted_by: 'user', created_at: '2026-08-01 09:00:00' },
    ] as unknown as CaseSnapshot['companies'],
    openActions: Array.from({ length: 8 }, (_, i) => ({
      id: 200 + i,
      case_id: 7,
      title: `第 ${i + 1} 件待办，题目按上限写满一行`,
      detail: null,
      status: '待办',
      due_at: '2026-09-20 09:00:00',
      source_message_id: null,
      created_at: '2026-09-01 09:00:00',
    })) as unknown as CaseSnapshot['openActions'],
    closedActions: [],
    deadlines: Array.from({ length: 6 }, (_, i) => ({
      id: 300 + i,
      case_id: 7,
      kind: LABOR.deadlineKinds[i],
      due_at: '2026-10-01 09:00:00',
      derived_from: '规则推算',
      resolved_at: null,
      created_at: '2026-09-01 09:00:00',
    })) as unknown as CaseSnapshot['deadlines'],
    storedIntakeStage: 'D',
    referredNbdpsy: false,
    report: { state: null, since: null, changes: 0, detail: '' },
    crisisHits72h: 0,
  } as unknown as CaseSnapshot;
}

const RENDERED = renderCaseFacts(buildCaseFacts(snapshot()));

describe('最长案件（四项诉求 + 时间线 30 条）的事实卡预算', () => {

  it('🔒 地板：夹具真的是"最长案件"（缩了水的夹具会让下面每一条永远绿）', () => {
    const s = snapshot();
    for (const k of FOUR_KINDS) expect(s.claims.map((c) => c.kind), `${k} 不在夹具里`).toContain(k);
    expect(s.claims.length).toBeGreaterThanOrEqual(10);
    expect(s.timeline).toHaveLength(TIMELINE_WINDOW);
    // 四项诉求对应的要件卡确实有一批（要件表空了，"没被降级"那条就没意义了）
    const cards = (LABOR.elementCards ?? []).filter((c) => FOUR_KINDS.includes(c.claimKind));
    expect(cards.length).toBeGreaterThanOrEqual(16);
  });

  it('事实卡不超过 4600 字预算', () => {
    // 实测值随夹具与要件卡内容变；这里只钉"不超预算"与"确实逼近了预算"两头——
    // 只钉上限的形态是：某次改动把事实卡缩到 1200 字（要件表被压没了），判据照样绿。
    expect(RENDERED.length).toBeLessThanOrEqual(CASE_FACTS_BUDGET);
    expect(RENDERED.length).toBeGreaterThan(CASE_FACTS_BUDGET * 0.8);
  });

  it('要件表整节仍在，且四项诉求的每一个要件都印出来了（变异：把它的 priority 从 1 改成 2 → 红）', () => {
    expect(RENDERED).toContain(`### ${LABOR.elementSheetTitle}`);
    const cards = (LABOR.elementCards ?? []).filter((c) => FOUR_KINDS.includes(c.claimKind));
    for (const card of cards) {
      expect(RENDERED, `要件 ${card.id} 被裁掉了`).toContain(`〔${card.claimKind}·${card.id}〕`);
    }
  });

  it('§38 被迫解除那条路在事实卡上**不许**印「公司来证」（复审 2026-09-10 第一条）', () => {
    // 【它守什么】司法解释（一）第四十四条倒置的是「用人单位作出的……决定」引发的争议；
    // 被迫解除是劳动者自己发出的解除，那条原文管不到它。事实卡是模型每一轮都读的那张纸——
    // 这一行印成「公司来证」的后果是：走这条路的用户被告知这件事不用他证，
    // 于是不去准备欠薪/未缴社保的初步证明，而仲裁庭按谁主张谁举证要他先举出个头。
    const forced = RENDERED.split('\n').find((l) => l.includes('〔N·N-2b〕'));
    expect(forced, '事实卡上没有 N-2b（§38 被迫解除）那一行').toBeTruthy();
    expect(forced!, '§38 那条路被印成了对方举证').not.toContain('公司来证');
    expect(forced!).toContain(LABOR.burdenLabels!.claimant);
    // 【反臂】同一张表上 N-2a（公司作出的决定）**必须**印着「公司来证」——
    // 没有这一条，整张卡都不印举证责任时上面那句照样绿。
    const decided = RENDERED.split('\n').find((l) => l.includes('〔N·N-2a〕'));
    expect(decided, '事实卡上没有 N-2a（用人单位决定型）那一行').toBeTruthy();
    expect(decided!).toContain('公司来证');
  });

  it('P0 那几节一个都没丢（要件表不许把"我是谁/期限还剩几天"挤掉）', () => {
    for (const key of ['parties', 'header', 'history', 'deadlines'] as const) {
      const title = LABOR.factsSections.find((s) => s.key === key)!.title;
      expect(RENDERED, `P0 分区「${title}」不见了`).toContain(`### ${title}`);
    }
  });

  it('确实发生过降级，而且**压力大到 P2 也保不住**（否则"要件表活下来"是免费的）', () => {
    // 明细被压掉的那句留痕（case-facts.DETAIL_DROPPED 的前半句）
    expect(RENDERED).toContain('明细因预算未注入');
    // 【这一条才是变异臂的支点】把要件表的 priority 从 1 改成 2 之后它必须**被压掉**——
    // 压力不够大的话，改优先级什么都不会发生，那条判据就是装饰。
    // 所以这里直接构造那一臂：同一份卡、同一份数据，只把优先级换成 2，要件表当场消失。
    const card = buildCaseFacts(snapshot());
    const asP2 = {
      header: card.header,
      sections: card.sections.map((sec) => (sec.key === 'elements' ? { ...sec, priority: 2 as const } : sec)),
    };
    const rendered = renderCaseFacts(asP2);
    expect(rendered, 'P2 时要件表本该被压掉——说明这份夹具的预算压力不够，变异臂是装饰').not.toContain(
      '〔2N·2N-1〕',
    );
  });
});

describe('要件表纪律真的下发到了 prompt 里', () => {
  const promptOf = (snap: CaseSnapshot) =>
    buildSystemPrompt({
      snapshot: snap,
      mode: '陪跑',
      stage: 'D',
      packs: [],
      now: new Date('2026-09-10T02:00:00Z'),
    } as Parameters<typeof buildSystemPrompt>[0]);

  it('缺省领域：四条纪律逐条在 prompt 里（变异：删掉 prompt.ts 里那一行调用 → 红）', () => {
    const p = promptOf(snapshot());
    expect(p).toContain('## 要件表与争点的纪律（本轮硬性）');
    // 〔未记录〕≠ 不成立
    expect(p).toContain('不许**写成「不满足 / 不成立 / 你没有 / 这项提不了」');
    // 争点回声
    expect(p).toContain('正文里提到的争点必须是争点表（issue_list）的**子集**');
    // 每个没成立的要件都要跟一句下一步
    expect(p).toContain('必须跟一句下一步');
    // 举证责任照表讲、未核实的如实说
    expect(p).toContain('举证责任照要件表那一列讲');
  });

  it('没有要件卡的领域：这一段整段不出现（下发一段讲要件表的纪律而事实卡里没有表，模型只会去发明一张）', () => {
    const other = Object.values(DOMAINS).find((d) => !(d.elementCards && d.elementCards.length > 0));
    expect(other, '现在每个领域都有要件卡了——把这条判据换成一个真实的反例，别删掉它').toBeTruthy();
    const snap = snapshot();
    const p = promptOf({ ...snap, case: { ...snap.case, domain: other!.key } } as CaseSnapshot);
    expect(p).not.toContain('## 要件表与争点的纪律（本轮硬性）');
  });
});

describe('工具轮次：本片没有多花一轮', () => {
  const ORCHESTRATOR = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'orchestrator.ts',
  );

  it('轮次上限仍是 8（改了它就要有人来改这条判据，并说明为什么这一片要多花一轮）', () => {
    const src = fs.readFileSync(ORCHESTRATOR, 'utf-8');
    expect(src).toMatch(/const MAX_TOOL_ROUNDS = 8;/);
  });

  it('要件表随事实卡到达 ⇒ 模型不必为了看它多调一轮（这就是"0 轮"的机械含义）', () => {
    // 事实卡里既有状态、也有"谁来证"、也有"需补什么"——三样齐了才不用再调 element_sheet_get。
    expect(RENDERED).toMatch(/成立·待证|缺失/);
    expect(RENDERED).toContain(LABOR.burdenLabels!.claimant);
    expect(RENDERED).toContain('需补：');
  });
});
