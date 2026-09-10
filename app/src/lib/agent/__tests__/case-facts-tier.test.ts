// app/src/lib/agent/__tests__/case-facts-tier.test.ts
// 事实卡的**档位渲染**与**取证闸**判据（设计稿 §4.2-2）。
//
// 与 case-facts.test.ts 的分工：那份钉的是"缺失显式化 + 预算裁剪"，这份钉的是
//「每条事实后面那个〔〕是从库里读出来的，不是渲染时猜的」。
import { describe, expect, it } from 'vitest';

import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';
import type { CaseRow, EvidenceRow, TimelineEventRow } from '@/lib/db/cases';
import type { ClaimRow, CompanyProfileRow } from '@/lib/db/agent';

import { buildCaseFacts, evidenceGapMark, renderCaseFacts, CASE_FACTS_BUDGET } from '../case-facts';
import type { CaseSnapshot } from '../snapshot';

const CASE_BASE: CaseRow = {
  id: 7,
  user_id: 7,
  title: '档位渲染夹具',
  stage: '已收通知',
  domain: DEFAULT_DOMAIN,
  track: null,
  district: '朝阳',
  goal: null,
  bottom_line: null,
  status: '进行中',
  employed_from: null,
  monthly_wage_fen: null,
  position: null,
  contract_count: null,
  created_at: '2026-09-01 10:00:00',
};

function event(over: Partial<TimelineEventRow> = {}): TimelineEventRow {
  return {
    id: 1,
    case_id: 7,
    happened_at: '2026-09-01 10:00:00',
    kind: '公司动作',
    title: '收到解除通知',
    detail: null,
    milestone: null,
    source_tier: '自述',
    asserted_by: 'user',
    event_type: null,
    created_at: '2026-09-01 10:00:00',
    ...over,
  };
}

function claim(over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: 1,
    case_id: 7,
    kind: '2N',
    amount_fen: 9_000_000,
    calc_json: null,
    basis: null,
    status: 'draft',
    source_tier: '自述',
    asserted_by: 'agent_inferred',
    created_at: '2026-09-01 10:00:00',
    ...over,
  };
}

function company(over: Partial<CompanyProfileRow> = {}): CompanyProfileRow {
  return {
    id: 1,
    case_id: 7,
    name: '某某科技有限公司',
    uscc: null,
    role: '签约主体',
    legal_rep: null,
    risk_notes: null,
    sources_json: null,
    source_tier: '自述',
    asserted_by: 'user',
    created_at: '2026-09-01 10:00:00',
    ...over,
  };
}

function evidenceRow(over: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: 100,
    case_id: 7,
    name: '解除通知.pdf',
    category: '沟通记录',
    prove_purpose: '证明单方解除',
    status: '已上传',
    created_at: '2026-09-01 10:00:00',
    extraction_status: 'done',
    extracted_at: '2026-09-01 11:00:00',
    brief_json: JSON.stringify({ proves: '这是一份解除通知' }),
    brief_version: 1,
    brief_error: null,
    void_reason: null,
    voided_at: null,
    brief_source_tier: '书证',
    brief_asserted_by: 'doc_extract',
    ...over,
  };
}

function snapshot(over: Partial<CaseSnapshot> = {}): CaseSnapshot {
  return {
    case: CASE_BASE,
    identity: { realName: null, authStatus: '未认证', nameUnreadable: false },
    evidence: [],
    historyStats: { total: 0, firstAt: null },
    timeline: [],
    timelineStats: { total: 0, earliest: null },
    claims: [],
    companies: [],
    openActions: [],
    closedActions: [],
    deadlines: [],
    storedIntakeStage: null,
    referredNbdpsy: false,
    report: { state: null, since: null, changes: 0, detail: '' },
    crisisHits72h: 0,
    ...over,
  };
}

const render = (over: Partial<CaseSnapshot> = {}) => renderCaseFacts(buildCaseFacts(snapshot(over)));
const lineWith = (text: string, needle: string) =>
  text.split('\n').find((l) => l.includes(needle)) ?? '';

describe('档位后缀由数据推出（不再渲染时猜）', () => {
  it('时间线逐条带自己的档位（变异：把 rowTier 换成常量〔自述〕 → 红）', () => {
    const rows = [
      event({ id: 2, title: '收到解除通知', source_tier: '书证', asserted_by: 'doc_extract' }),
      event({ id: 1, title: 'HR 约谈', source_tier: '自述' }),
      event({ id: 3, title: '公司邮件承认', source_tier: '对方认可' }),
      event({ id: 4, title: '裁决认定入职日', source_tier: '裁审认定' }),
    ];
    const text = render({ timeline: rows, timelineStats: { total: 4, earliest: rows[1] } });
    expect(lineWith(text, '收到解除通知')).toContain('〔书证〕');
    expect(lineWith(text, 'HR 约谈')).toContain('〔自述〕');
    expect(lineWith(text, '公司邮件承认')).toContain('〔对方认可〕');
    expect(lineWith(text, '裁决认定入职日')).toContain('〔裁审认定〕');
  });

  it('时间线区抬头**数出来**有几条有书证（变异：改回那句"全部是用户口述落档" → 红）', () => {
    const rows = [event({ id: 2, source_tier: '书证' }), event({ id: 1, title: 'HR 约谈' })];
    const text = render({ timeline: rows, timelineStats: { total: 2, earliest: rows[1] } });
    expect(text).toContain('其中有书证及以上支撑的 1 条');
    // 旧那句整段贴上去的措辞必须消失：它与真实数据无关，是这一票要修的病灶本身
    expect(text).not.toContain('全部是用户口述落档');
  });

  it('诉求与对方主体逐条带档位（变异：其中一处漏掉 rowTier → 红）', () => {
    const text = render({
      claims: [claim({ source_tier: '书证' })],
      companies: [company({ source_tier: '对方认可' })],
    });
    expect(lineWith(text, '2N：')).toContain('〔书证〕');
    expect(lineWith(text, '某某科技有限公司')).toContain('〔对方认可〕');
  });

  it('证据简报的档位带证据 id 当锚点（变异：把锚点换成简报版本号 → 红）', () => {
    const text = render({ evidence: [evidenceRow({ id: 100, brief_source_tier: '书证' })] });
    expect(lineWith(text, '简报：')).toContain('〔书证#100〕');
  });

  it('人手改过的简报落自述档，与提取写的分得开（变异：两者渲成同一个档 → 红）', () => {
    const text = render({
      evidence: [evidenceRow({ id: 101, brief_source_tier: '自述', brief_asserted_by: 'user' })],
    });
    // 锚点照旧指向那条证据行（· 是非书证档的分隔符），但档位是自述——
    // 「这句结论是人写的，不是从原件里读出来的」
    expect(lineWith(text, '简报：')).toContain('〔自述·101〕');
    expect(lineWith(text, '简报：')).not.toContain('〔书证');
  });

  it('档位值写坏时说实话，不冒充某一档（变异：认不出时渲成〔自述〕 → 红）', () => {
    const rows = [event({ id: 1, title: '脏行', source_tier: '书面证据' })];
    const text = render({ timeline: rows, timelineStats: { total: 1, earliest: rows[0] } });
    expect(lineWith(text, '脏行')).toContain('来源档位读不出');
  });

  it('卡头把四档逐档讲清，且点破〔未记录〕≠不存在（变异：删掉「对方认可」那一句 → 红）', () => {
    const text = render();
    for (const tier of ['〔自述〕', '〔书证#12〕', '〔对方认可·timeline#8〕', '〔裁审认定〕']) {
      expect(text, tier).toContain(tier);
    }
    expect(text).toContain('不是"事实上没有"');
  });

  it('加了后缀之后仍在预算内（变异：把 CASE_FACTS_BUDGET 的后置保证删掉 → 红）', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      event({ id: 500 - i, title: `第 ${i} 号事件`.padEnd(50, '细'), source_tier: '对方认可' }),
    );
    const text = render({
      timeline: rows,
      timelineStats: { total: 90, earliest: rows[rows.length - 1] },
      claims: Array.from({ length: 12 }, (_, i) => claim({ id: i, kind: `项目${i}` })),
      companies: Array.from({ length: 6 }, (_, i) => company({ id: i, name: `公司${i}` })),
      evidence: Array.from({ length: 25 }, (_, i) => evidenceRow({ id: 100 + i, name: `材料${i}.pdf` })),
    });
    expect(text.length).toBeLessThanOrEqual(CASE_FACTS_BUDGET);
  });
});

describe('取证闸：进了取证窗口而一条书证都没有', () => {
  const gate = DOMANIN_GATE();
  function DOMANIN_GATE() {
    const g = DOMAINS[DEFAULT_DOMAIN].evidenceGate;
    if (!g) throw new Error('缺省领域没有声明 evidenceGate，本组判据无从测起');
    return g;
  }
  const gateStage = gate.stages[0];

  it('闸开：首行点出组数与组名，并给出「先补哪张证」（变异：删掉 notice 里的出路那半句 → 红）', () => {
    const text = render({
      case: { ...CASE_BASE, stage: gateStage },
      timeline: [event()],
      claims: [claim()],
    });
    const head = text.split('\n')[0];
    expect(head).toContain('> **状态**');
    // {n} 换成真组数（时间线 + 诉求 = 2 组），{groups} 换成领域包里那两节的抬头
    expect(head).toContain('2 组');
    expect(head).toContain('时间线');
    // 禁令配出路：只报"你没有书证"而不给下一步的形态，是把用户堵在原地
    expect(head).toMatch(/补|上传|流水|记录/);
  });

  it('闸不开：阶段不在窗口里（变异：把 stages 判定去掉 → 红：每个阶段都被催取证）', () => {
    expect(
      evidenceGapMark(snapshot({ case: { ...CASE_BASE, stage: '风声' }, timeline: [event()] })),
    ).toBe(null);
  });

  it('闸不开：已经有一条书证（变异：把 noDocumentedFact 判反 → 红）', () => {
    expect(
      evidenceGapMark(
        snapshot({
          case: { ...CASE_BASE, stage: gateStage },
          timeline: [event({ source_tier: '书证' })],
          claims: [claim()],
        }),
      ),
    ).toBe(null);
  });

  it('闸不开：档案还是空的（变异：空案子也开闸 → 红：刚建档就被催取证）', () => {
    expect(evidenceGapMark(snapshot({ case: { ...CASE_BASE, stage: gateStage } }))).toBe(null);
  });

  it('组名从领域包取，共用层不写行当名词（变异：把抬头写死在 case-facts.ts → 红）', () => {
    const pack = DOMAINS[DEFAULT_DOMAIN];
    const mark = evidenceGapMark(
      snapshot({ case: { ...CASE_BASE, stage: gateStage }, companies: [company()] }),
    )!;
    expect(mark).toContain(pack.factsSections.find((s) => s.key === 'counterparts')!.title);
  });
});

/**
 * **事件类型标签**（2026-09-10/11 台账「结构化决定」票）。
 *
 * 【为什么它要出现在事实卡上】那一格决定了要件表怎么判这条记录：选了「其他通知」的
 * 一条解除通知书，三张卡照旧写着「缺失」。卡上不印的形态是——模型（与读事实卡的人）
 * 看到的是一条读起来像解除决定的记录，与一张说它缺失的要件表并排放着，
 * 而没有任何一处说得出这两者为什么不一致。
 *
 * 【本文件不认识 labor 的类型 id】标签逐字取自领域包，这里只验"取的是它"。
 */
describe('时间线的事件类型标签', () => {
  const COMPANY_TYPES = DOMAINS[DEFAULT_DOMAIN].timelineEventTypes['公司动作'];

  it('选过类型 ⇒ 那一行带领域包给的 label（变异：把标签写死一份 → 随包改名而红）', () => {
    const spec = COMPANY_TYPES[0];
    const rows = [event({ id: 2, title: '上周三那个事', event_type: spec.id })];
    const line = lineWith(render({ timeline: rows, timelineStats: { total: 1, earliest: rows[0] } }), '上周三那个事');
    expect(line).toContain(`〔类型：${spec.label}〕`);
    // 档位那一格还在原处：新标签不许把它挤掉
    expect(line).toContain('〔自述〕');
  });

  it('没选过 ⇒ 那一行与本列落地前逐字相同（变异：给 null 也印一个标签 → 红）', () => {
    const rows = [event({ id: 2, title: 'HR 第一次约谈' })];
    expect(
      lineWith(render({ timeline: rows, timelineStats: { total: 1, earliest: rows[0] } }), 'HR 第一次约谈'),
    ).not.toContain('〔类型：');
  });

  it('🔴 认不出来的取值照实印出来，并说明它不会被任何判定认下（变异：当作没选过 → 红）', () => {
    // 领域包改过枚举、库里还躺着按旧枚举选过的行：那一格已经压过谓词，
    // 判定既不认它是任何一格、也不回去读那段字，于是这个槽从此恒缺。
    // 静默的形态是——要件表说缺，时间线上这条记录看起来好端端的。
    const rows = [event({ id: 2, title: '收到解除通知', event_type: '早就删掉的取值' })];
    const line = lineWith(render({ timeline: rows, timelineStats: { total: 1, earliest: rows[0] } }), '收到解除通知');
    expect(line).toContain('早就删掉的取值');
    expect(line).toContain('不会认它');
  });
});
