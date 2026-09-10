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

import { describe, expect, it, vi } from 'vitest';

import { buildElementSheet, FACT_SLOT_SOURCES, type ElementRow } from '@/lib/cases/elements';
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

/**
 * 事实卡上那几行要件。`- 〔` 这个开头**只有要件行用**（时间线、诉求、对方主体各有各的开头），
 * 所以数它就是数"模型这一轮看得见几个要件"。
 */
function elementRowsIn(text: string): number {
  return text.split('\n').filter((l) => l.startsWith('- 〔')).length;
}

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
    // 【这一条才是变异臂的支点】把要件表的 priority 从 1 改成 2 之后它必须**当场变差**——
    // 压力不够大的话，改优先级什么都不会发生，那条判据就是装饰。
    // 所以这里直接构造那一臂：同一份卡、同一份数据，只把优先级换成 2。
    //
    // 【这一句从"整节消失"改成"行数当场少一截"（2026-09-10 逐行降级票）】要件表这一节
    // 现在带 refit，被降级时按剩余预算**逐行**丢而不是整节丢，所以旧写法
    //（`not.toContain('〔2N·2N-1〕')`）钉的是已经不存在的那种粒度。改后钉的仍是同一件事：
    // **同一份数据，P2 比 P1 少看见几行要件**；压力不够大时两个数相等，这一条照红。
    const card = buildCaseFacts(snapshot());
    const asP2 = {
      header: card.header,
      sections: card.sections.map((sec) => (sec.key === 'elements' ? { ...sec, priority: 2 as const } : sec)),
    };
    const rendered = renderCaseFacts(asP2);
    expect(elementRowsIn(rendered), 'P2 时要件表本该少几行——说明这份夹具的预算压力不够，变异臂是装饰').toBeLessThan(
      elementRowsIn(RENDERED),
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

// ════════════════════ 施压期厚档案（2026-09-10 逐行降级票的新夹具）════════════════════
//
// 【它是什么形态的案子】风闻裁员之后、公司还没有作出任何解除决定的那一段：
// 调岗、约谈、书面警告、办公地搬迁一件接一件落进时间线，员工手册一类公司文件也进了证据库，
// **但一份解除/终止决定都没有**。这正是核心客户窗口里最厚的那一批档案。
//
// 【为什么它比"最长案件"更能压出问题】档案一样厚，而要件表**更长**：
// 判「公司确实作出过那个决定」的三条（2N-2 / 2N-3 / N-2a）一起翻「缺失」，
// 缺失行要带上「需补什么」，于是这一节比同尺寸的最长案件多出一百多字——
// 刚好越过预算。旧的降级粒度是"整节明细一起丢"：18 行 1800 字一次换成一句
//「明细因预算未注入」，事实卡从 4600 塌到 2900，一千多字预算空置，
// 而模型手上**一个要件、一个缺口都没有**——最需要这张表的档案恰好一行都读不到。
//
// 【既有夹具的判据一条没动】这一节只加新的；上面那份「最长案件」照旧。
const PRESSURE_ACTIONS = [
  '公司通知调岗到另一条业务线，岗位职级与汇报线都变了，我当场表示不同意',
  'HR 约谈，口头让我"主动考虑一下别的机会"，没有给任何书面材料',
  '收到一封书面警告，说我上月绩效未达标，要求限期改进',
  '公司宣布办公地整体搬迁到另一个区，通勤时间从四十分钟变成两个多小时',
  'HR 再次约谈，拿出一份《协商解除协议》让我签，我没有签、也没有拿到副本',
  '部门例会上宣布把我负责的项目移交给同事，我的权限被回收',
  '公司下发新版绩效考核办法，对我这一岗新增了一条单独的考核口径',
  '工资条上的岗位津贴被取消，当月实发比上月少了一截',
];

/** 「公司动作」这一类里**不含**解除/终止决定的那 8 条，其余 22 条是我方动作与沟通。 */
function pressureSnapshot(): CaseSnapshot {
  const base = snapshot();
  const timeline = Array.from({ length: TIMELINE_WINDOW }, (_, i) => ({
    ...base.timeline[i],
    kind: i < PRESSURE_ACTIONS.length ? '公司动作' : i % 2 === 0 ? '我方动作' : '沟通',
    title:
      i < PRESSURE_ACTIONS.length
        ? `第 ${i + 1} 件事：${PRESSURE_ACTIONS[i]}`
        : `第 ${i + 1} 件事：我这边做了一次书面回应并留存了记录`,
  })) as unknown as CaseSnapshot['timeline'];
  // 员工手册：「公司文件」类别下最典型的那一份**不是解除决定**的公司文件。
  // 它在档而解除决定不在档，正是 2026-09-10「公司动作」票收窄槽位判定要挡的那个形态。
  const evidence = base.evidence.map((e, i) =>
    i === 0 ? { ...e, name: '员工手册-2024版.pdf', category: '公司文件' } : e,
  ) as unknown as CaseSnapshot['evidence'];
  return {
    ...base,
    timeline,
    evidence,
    timelineStats: { total: 96, earliest: timeline[timeline.length - 1] },
  } as CaseSnapshot;
}

const PRESSURE_CARD = buildCaseFacts(pressureSnapshot());
const PRESSURE = renderCaseFacts(PRESSURE_CARD);
const PRESSURE_SHEET = buildElementSheet(
  pressureSnapshot(),
  (LABOR.elementCards ?? []).filter((c) => FOUR_KINDS.includes(c.claimKind)),
  FOUR_KINDS,
);
/**
 * 一行要件里**说得出名字**的缺口（= 领域包写的 missingAs）。没挂取值判定的槽在
 * missingSlots 里放的是寻址串本身（`evidence:<类别>`），那是机器地址不是人话——
 * 与 case-facts.namedGaps 同一道滤，两边不同步时下面那条判据会当场红。
 */
function namedGapsOf(r: ElementRow): string[] {
  return r.missingSlots.filter((m) => !FACT_SLOT_SOURCES.some((src) => m.startsWith(`${src}:`)));
}

/** P0 行 = 「缺失」与「不成立」——立不住的那几行，任何数据形态下都不许丢。 */
const PRESSURE_P0 = PRESSURE_SHEET.rows.filter((r) => r.status === '缺失' || r.status === '不成立');

describe('施压期厚档案：要件表按行降级，缺口那几行永远在', () => {
  it('🔒 地板：夹具真的是"施压期厚档案"（缩了水的夹具会让下面每一条永远绿）', () => {
    const s = pressureSnapshot();
    // ≥8 条公司动作
    expect(s.timeline.filter((e) => e.kind === '公司动作').length).toBeGreaterThanOrEqual(8);
    expect(s.timeline).toHaveLength(TIMELINE_WINDOW);
    // 一条解除/终止决定都没有 —— 判据在推导侧：判「公司作出过那个决定」的三行必须一起落「缺失」。
    // 只按字面找「解除」两个字的形态是：夹具改一个词，这条判据不红而下面全变。
    for (const id of ['2N-2', '2N-3', 'N-2a']) {
      const row = PRESSURE_SHEET.rows.find((r) => r.id === id);
      expect(row?.status, `${id} 不是「缺失」——这份夹具已经不是"无一解除决定"了`).toBe('缺失');
    }
    // 员工手册在档（在档的是公司文件，不是解除决定）
    expect(s.evidence.some((e) => e.name.includes('员工手册') && e.category === '公司文件')).toBe(true);
    // 四诉求 + 10 项诉求
    for (const k of FOUR_KINDS) expect(s.claims.map((c) => c.kind), `${k} 不在夹具里`).toContain(k);
    expect(s.claims.length).toBeGreaterThanOrEqual(10);
    // 缺口不止一条（只剩一条时"P0 全在"是免费的）
    expect(PRESSURE_P0.length).toBeGreaterThanOrEqual(4);
  });

  it('(a) 渲染 ≤4600，且要件表节**存活**（不是只剩抬头与统计行）', () => {
    expect(PRESSURE.length).toBeLessThanOrEqual(CASE_FACTS_BUDGET);
    // 【为什么还要钉下限】只钉上限的形态正是这一票要修的那个：整节一丢，卡塌到 2900、
    // 判据照绿。改前实测 2893，改后 4579。
    expect(PRESSURE.length).toBeGreaterThan(CASE_FACTS_BUDGET * 0.9);
    expect(PRESSURE).toContain(`### ${LABOR.elementSheetTitle}`);
    const sheetSection = PRESSURE.split('\n\n').find((b) => b.startsWith(`### ${LABOR.elementSheetTitle}`))!;
    expect(sheetSection, '要件表只剩统计行 = 整节丢的旧形态').not.toContain('明细因预算未注入');
    expect(elementRowsIn(sheetSection)).toBeGreaterThan(0);
  });

  it('(a) 全部 P0 行（缺失/不成立）都在，且每一行都带着 missingAs 那句缺口文案', () => {
    for (const r of PRESSURE_P0) {
      const line = PRESSURE.split('\n').find((l) => l.startsWith(`- 〔${r.claimKind}·${r.id}〕`));
      expect(line, `P0 行 ${r.id} 被裁掉了——缺口行永不降级`).toBeTruthy();
      expect(line!, `${r.id} 只说了缺，没说补什么`).toContain('需补：');
    }
    // 缺口文案含 missingAs：推导侧点名的那几项，在卡上要**逐条**说得出名字。
    // 只印 typicalEvidence 的形态是——一行 60 字被通用清单占满，真正差的那一格
    //（「公司作出决定那一刻还没记成一条事件」）恰好排在末尾被截掉，
    // 于是模型让用户去传一份材料，而档案里缺的根本不是材料。
    const named = [...new Set(PRESSURE_P0.flatMap(namedGapsOf))];
    expect(named.length, '这份夹具一条 missingAs 都没有 ⇒ 下面那句永远绿').toBeGreaterThan(0);
    for (const m of named) {
      expect(PRESSURE, `缺口「${m}」在卡上说不出名字`).toContain(m.slice(0, 12));
    }
  });

  it('(a) 寻址串**不许**印进事实卡（没挂取值判定的槽，missingSlots 里放的是机器地址）', () => {
    // 【为什么要再造一个"公司一份纸都没给"的形态】上面两份夹具的缺口恰好都挂着取值判定，
    // 于是 missingSlots 里全是人话，这条判据在它们身上**恒绿**（变异实测：删掉 namedGaps
    // 那道滤，两份夹具一条都不红）。把员工手册也拿掉，`evidence:公司文件` 这个没挂判定的槽
    // 才真的落进 missingSlots——那正是机器地址会漏进 prompt 的那一格。
    const bare = pressureSnapshot();
    const noPaper = {
      ...bare,
      evidence: bare.evidence.filter((e) => e.category !== '公司文件'),
    } as CaseSnapshot;
    const sheet = buildElementSheet(
      noPaper,
      (LABOR.elementCards ?? []).filter((c) => FOUR_KINDS.includes(c.claimKind)),
      FOUR_KINDS,
    );
    const raw = sheet.rows.flatMap((r) =>
      r.missingSlots.filter((m) => FACT_SLOT_SOURCES.some((src) => m.startsWith(`${src}:`))),
    );
    expect(raw.length, '这份夹具一个没挂判定的缺口槽都没有 ⇒ 下面那句永远绿').toBeGreaterThan(0);

    // 变异：把 namedGaps 那道滤删掉 → 这一条当场红（labor-zero-change ② 同时红）
    const rendered = renderCaseFacts(buildCaseFacts(noPaper));
    for (const text of [rendered, PRESSURE, RENDERED]) {
      for (const src of FACT_SLOT_SOURCES) {
        expect(text, `事实卡上冒出了寻址串前缀「${src}:」`).not.toContain(`${src}:`);
      }
    }
    // 滤掉地址之后，人话那几句还在（宁可多留一句人话，不可少留）
    expect(rendered).toContain('需补：');
  });

  it('(a) 丢掉的行有留痕：说清丢了几条、且明说"不是没有这几项"', () => {
    const hidden = PRESSURE.split('\n').find((l) => l.includes('另有') && l.includes('次要要件未显示'));
    expect(hidden, '这份夹具本该丢掉几行——一行没丢说明压力不够，下面几条就是装饰').toBeTruthy();
    expect(hidden!).toMatch(/另有 \d+ 条次要要件未显示/);
    expect(hidden!, '只说"未显示"会被读成"这几个要件不存在"').toContain('不是没有这几项');
    expect(hidden!, '禁令要配出路（§7.7）').toContain('element_sheet_get');
  });
});

describe('要件表逐行降级的顺序（变异：把「缺失」的档从 0 改成非 0 → 这一组红）', () => {
  const SECTION = PRESSURE_CARD.sections.find((s) => s.key === 'elements')!;
  const FULL = SECTION.detail;
  const sumLen = (lines: readonly string[]) => lines.reduce((n, l) => n + l.length + 1, 0);
  const idsIn = (lines: readonly string[]) =>
    new Set(
      lines
        .map((l) => /^- 〔(?:[^〕·]+·)?([^〕]+)〕/.exec(l)?.[1])
        .filter((x): x is string => Boolean(x)),
    );

  it('要件表这一节确实带 refit（没有它就退回"整节明细一起丢"的旧粒度）', () => {
    expect(SECTION.refit, '要件表没有 refit ⇒ 预算不够时整节丢').toBeTruthy();
  });

  it('(b) 刚好差 1 行的预算：丢的是 P3（成立）行，P0（缺失）行一条不少', () => {
    const shrunk = SECTION.refit!(sumLen(FULL) - 1);
    const before = idsIn(FULL);
    const after = idsIn(shrunk);
    const gone = [...before].filter((id) => !after.has(id));
    expect(gone, '预算只差一个字，却不止丢了一行').toHaveLength(1);
    const goneRow = PRESSURE_SHEET.rows.find((r) => r.id === gone[0])!;
    expect(goneRow.status, `丢的是 ${gone[0]}（${goneRow.status}）——P3 行还在，先丢的却不是它`).toBe('成立');
    for (const r of PRESSURE_P0) {
      expect(after.has(r.id), `P0 行 ${r.id} 被丢了`).toBe(true);
    }
  });

  it('(b) 预算继续收紧：成立行先丢光，缺失行一条都还在', () => {
    // 只留得下 P0 与个别 P1 的预算（P0 行满档的长度就是那条线）
    const p0Len = sumLen(FULL.filter((l) => l.includes('：缺失｜') || l.includes('：不成立｜')));
    const shrunk = SECTION.refit!(Math.round(p0Len * 1.3));
    const after = idsIn(shrunk);
    for (const r of PRESSURE_SHEET.rows.filter((x) => x.status === '成立')) {
      expect(after.has(r.id), `预算这么紧还留着「成立」行 ${r.id}`).toBe(false);
    }
    for (const r of PRESSURE_P0) {
      expect(after.has(r.id), `P0 行 ${r.id} 被丢了`).toBe(true);
    }
  });

  it('(b) 只剩 P0 也放不下 ⇒ 整节丢，且 console.error 三段式报出预算与 P0 行的实际字数', () => {
    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errs.push(a.join(' '));
    });
    try {
      const shrunk = SECTION.refit!(10);
      expect(shrunk).toEqual(['- （明细因预算未注入——需要时直接问用户，不要假设不存在）']);
    } finally {
      spy.mockRestore();
    }
    expect(errs).toHaveLength(1);
    expect(errs[0], '缺什么').toContain('缺什么：');
    expect(errs[0], '为什么缺').toContain('为什么缺：');
    expect(errs[0], '怎么办').toContain('怎么办：');
    // 「怎么办」要报得出数：预算、P0 行实际要多少字、常量现值
    expect(errs[0]).toMatch(/预算只有 10 字/);
    expect(errs[0]).toMatch(new RegExp(`CASE_FACTS_BUDGET=${CASE_FACTS_BUDGET}`));
  });
});

describe('压缩档只在预算不够时启用（变异：把压缩档常开 → 这一组红）', () => {
  const SECTION = PRESSURE_CARD.sections.find((s) => s.key === 'elements')!;
  const sumLen = (lines: readonly string[]) => lines.reduce((n, l) => n + l.length + 1, 0);

  /**
   * 【为什么这一组是"逐字不变"而不是"看起来差不多"】压缩档常开省下来的字，
   * 是每一份档案都少看的那几十个字下一步；而它不会让任何一条判据红——
   * 状态、举证责任、行数全都还在，只是每一行都短了一截。所以这里钉的是**满档那份措辞逐字在场**。
   */
  it('(c) 正常档案（最长案件，没触发要件表降级）：满档措辞逐字在场，一个压缩档标记都没有', () => {
    // 满档的举证责任措辞（带括号里的解释）——压缩档会把它换成短标签
    expect(RENDERED).toContain(LABOR.burdenLabels!.reversed_interpretation);
    expect(RENDERED).toContain(LABOR.burdenLabels!.reversed_procedure_rules);
    expect(RENDERED, '正常档案里冒出了压缩档的短标签').not.toContain(
      LABOR.burdenLabelsShort!.reversed_interpretation,
    );
    // `〔诉求·卡号〕` 的前半截还在（压缩档会把重复的那半截去掉）
    expect(RENDERED).toContain('〔2N·2N-1〕');
    // 一行都没被逐行降级压掉
    expect(RENDERED).not.toContain('次要要件未显示');
    expect(elementRowsIn(RENDERED)).toBe(
      (LABOR.elementCards ?? []).filter((c) => FOUR_KINDS.includes(c.claimKind)).length,
    );
  });

  it('(c) 厚档案也只丢了行、没有开压缩档（P3 行让位就够了 ⇒ 压缩档不该启用）', () => {
    expect(PRESSURE).toContain(LABOR.burdenLabels!.reversed_interpretation);
    expect(PRESSURE, '还没到该压缩的那一档就把格式压了').not.toContain(
      LABOR.burdenLabelsShort!.reversed_interpretation,
    );
    expect(PRESSURE).toContain('〔2N·2N-2〕');
  });

  it('(c) 预算紧到 P3/P2 让位也不够时，压缩档才启用：短标签换上、「需补」收到 36 字、重复前缀去掉', () => {
    // 满档下光 P0 行就装不下的预算 ⇒ P3/P2 让位不够，必须换压缩档才塞得进
    const p0Len = sumLen(
      SECTION.detail.filter((l) => l.includes('：缺失｜') || l.includes('：不成立｜')),
    );
    const shrunk = SECTION.refit!(Math.round(p0Len * 0.9)).join('\n');
    expect(shrunk, '压缩档没启用').toContain(LABOR.burdenLabelsShort!.reversed_interpretation);
    expect(shrunk).not.toContain(LABOR.burdenLabels!.reversed_interpretation);
    // 重复前缀去掉：卡号已经带着诉求名时，`〔2N·2N-3〕` 收成 `〔2N-3〕`
    expect(shrunk).toContain('〔2N-3〕');
    expect(shrunk).not.toContain('〔2N·2N-3〕');
    // 「需补」那一列收到 36 字：满档 60 字那一版的第 40 个字不该再出现在这一行里
    const full = SECTION.detail.find((l) => l.startsWith('- 〔2N·2N-3〕'))!;
    const compact = shrunk.split('\n').find((l) => l.startsWith('- 〔2N-3〕'))!;
    const fullNeed = full.slice(full.indexOf('需补：') + 3);
    const compactNeed = compact.slice(compact.indexOf('需补：') + 3);
    expect(compactNeed.length).toBeLessThan(fullNeed.length);
    expect(compactNeed.replace(/……$/, '')).toHaveLength(36);
  });
});
