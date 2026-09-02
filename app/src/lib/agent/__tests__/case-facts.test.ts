// app/src/lib/agent/__tests__/case-facts.test.ts
// 案件事实卡的守卫判据 G-F0～G-F7。
//
// 每条判据后面括号里写的是**让它变红的变异**——判据的价值等于「改坏源码时它会不会响」，
// 不是「它今天绿不绿」。变异矩阵实跑记录见 rd-case-facts/impl-mutation.log。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EVIDENCE_CATEGORIES } from '@/lib/evidence/categories';
import type { CaseRow, EvidenceRow, TimelineEventRow, ActionItemRow, DeadlineRow } from '@/lib/db/cases';
import type { ClaimRow, CompanyProfileRow } from '@/lib/db/agent';

import { buildCaseFacts, renderCaseFacts, CASE_FACTS_BUDGET, EVIDENCE_DISCLAIMER } from '../case-facts';
import { buildSystemPrompt } from '../prompt';
import { CRISIS_DIRECTIVE } from '../crisis';
import type { CaseSnapshot } from '../snapshot';

const SRC_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// ========== 夹具 ==========

const CASE_BASE: CaseRow = {
  id: 2,
  user_id: 2,
  title: '李哲诉宜信体系违法解除',
  stage: '已收通知',
  district: '朝阳',
  goal: null,
  bottom_line: null,
  status: '进行中',
  employed_from: null,
  monthly_wage_fen: null,
  position: null,
  contract_count: null,
  created_at: '2026-08-19 10:00:00',
};

function evidence(n: number, category = '考勤'): EvidenceRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 100 + i,
    case_id: 2,
    name: `证据文件-${i}.pdf`,
    category,
    prove_purpose: `第 ${i} 条的证明目的：7月考勤异常申诉获批，驳回 0`,
    status: '已上传',
    created_at: '2026-08-20 09:00:00',
  }));
}

function timeline(n: number): TimelineEventRow[] {
  // 倒序（最新在前），与 caseStore.listTimelineEvents 的 ORDER BY happened_at DESC 一致
  return Array.from({ length: n }, (_, i) => ({
    id: 500 + (n - i),
    case_id: 2,
    happened_at: `2026-0${(9 - (i % 9)).toString()}-${String((i % 28) + 1).padStart(2, '0')}`,
    kind: '公司动作',
    title: `第 ${n - i} 号事件`,
    detail: `事件明细 ${n - i}：`.padEnd(60, '细'),
    milestone: null,
    created_at: '2026-08-20 09:00:00',
  }));
}

/** 短行证据：让 20 条上限先于分区预算生效，才测得到"条数上限"这一层裁剪 */
function evidenceShort(n: number): EvidenceRow[] {
  return evidence(n).map((e) => ({ ...e, name: `e${e.id}`, prove_purpose: '短' }));
}

function actions(n: number): ActionItemRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 900 + i,
    case_id: 2,
    title: `待办事项 ${i}`,
    detail: null,
    due_at: '2026-09-05T18:00:00+08:00',
    priority: 1,
    status: '待办',
    created_at: '2026-08-20 09:00:00',
  }));
}

function makeSnapshot(over: Partial<CaseSnapshot> = {}): CaseSnapshot {
  return {
    case: CASE_BASE,
    identity: { realName: null, authStatus: '未认证', nameUnreadable: false },
    evidence: [],
    historyStats: { total: 0, firstAt: null },
    timeline: [],
    claims: [],
    companies: [],
    openActions: [],
    closedActions: [],
    deadlines: [],
    storedIntakeStage: null,
    referredNbdpsy: false,
    ...over,
  };
}

const render = (over: Partial<CaseSnapshot> = {}) => renderCaseFacts(buildCaseFacts(makeSnapshot(over)));

/** 生产 uid=2 的形态：未实名 / 19 条证据（无合同）/ 21 条时间线 / 0 公司 / 0 诉求 / 6 待办 / 1 期限 */
function uid2Snapshot(): CaseSnapshot {
  const ev = [
    ...evidence(4, '考勤'),
    ...evidence(5, '工资'),
    ...evidence(6, '沟通记录'),
    ...evidence(2, '录音'),
    ...evidence(1, '社保'),
    ...evidence(1, '其他'),
  ].map((e, i) => ({ ...e, id: 100 + i }));
  return makeSnapshot({
    case: {
      ...CASE_BASE,
      goal: '主张违法解除赔偿金 2N 离开（司龄主张 2020-11 起 6 年，口径 262356 元；HR 已录音自认 N=135000）',
      bottom_line: '以法定经济补偿为底；谈判纪律：我方不先出数字',
      employed_from: '2020-11-26',
      monthly_wage_fen: 3644000,
      position: '高级风控经理',
      contract_count: '续签过一次',
    },
    evidence: ev,
    timeline: timeline(21),
    openActions: actions(6),
    deadlines: [
      {
        id: 1,
        case_id: 2,
        kind: '仲裁时效',
        due_at: '2027-08-19',
        derived_from: '解除之日 2026-08-19 起一年',
        resolved_at: null,
        created_at: '2026-08-20 09:00:00',
      },
    ],
    historyStats: { total: 6, firstAt: '2026-09-02 11:20:00' },
  });
}

// ========== G-F0 单一入口 ==========

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('G-F0 单一入口：事实卡是纯函数，且只在一处注入', () => {
  const source = fs.readFileSync(path.join(SRC_ROOT, 'lib/agent/case-facts.ts'), 'utf-8');

  it('case-facts.ts 不碰 DB（变异：往里加一句 db.prepare / import better-sqlite3 → 红）', () => {
    expect(source).not.toContain('better-sqlite3');
    expect(source).not.toContain('db.prepare');
    expect(source).not.toContain('@/lib/db/');
  });

  it('renderCaseFacts 全 src 只被调用一次，且在 buildSystemPrompt 里（变异：别处再调一次 → 红）', () => {
    const callers: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (file.endsWith('case-facts.ts')) continue; // 定义处自身不算调用
      const text = fs.readFileSync(file, 'utf-8');
      const hits = text.match(/renderCaseFacts\(/g);
      if (hits) callers.push(...hits.map(() => file));
    }
    expect(callers).toEqual([path.join(SRC_ROOT, 'lib/agent/prompt.ts')]);

    const prompt = fs.readFileSync(path.join(SRC_ROOT, 'lib/agent/prompt.ts'), 'utf-8');
    const body = prompt.slice(prompt.indexOf('export function buildSystemPrompt'));
    expect(body).toContain('renderCaseFacts(buildCaseFacts(input.snapshot))');
  });
});

// ========== G-F1 零编造 ==========

describe('G-F1 零编造：缺的就是缺的，不给默认值', () => {
  it('全空档案不许出现任何默认值（变异：姓名填「用户」/ 工资填 0 → 红）', () => {
    const text = render();
    expect(text).toContain('月工资：未记录');
    expect(text).not.toMatch(/月工资：\s*0/);
    expect(text).toContain('姓名：未实名');
    expect(text).not.toContain('姓名：用户');
    expect(text).toContain('用户目标：未记录');
    expect(text).not.toMatch(/入职日期：\d/);
  });

  it('渲染出来的每一串 4 位以上数字都能在 snapshot 里找到同值来源（变异：编一个金额/日期 → 红）', () => {
    const snapshot = uid2Snapshot();
    const json = JSON.stringify(snapshot);
    const text = renderCaseFacts(buildCaseFacts(snapshot));
    const runs = text.match(/\d{4,}/g) ?? [];
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(json, `渲染里出现了 snapshot 中没有的数字 ${run}`).toContain(run);
    }
  });
});

// ========== G-F2 缺失显式化 ==========

describe('G-F2 缺失显式化：没有的东西必须写出来「档案里没有」', () => {
  it('未实名 → 原样给出 manager 定的那句话，且全文无占位符（变异：改成留白 → 红）', () => {
    const text = render();
    expect(text).toContain('姓名：未实名，档案里没有你的姓名，文书里我不会替你填');
    // 事故原句是「【你的姓名】（已使用档案中的真实姓名）」：占位符与"已完成"宣称都不许出现
    expect(text).not.toContain('【');
    expect(text).not.toMatch(/【[^】]*】/);
    expect(text).not.toContain('已使用档案中的真实姓名');
  });

  it('已实名 → 给明文姓名 + 使用约束（manager 方案 A）', () => {
    const text = render({ identity: { realName: '李哲', authStatus: '已实名', nameUnreadable: false } });
    expect(text).toContain('姓名：李哲');
    expect(text).toContain('只用于用户明确要求的文书填写');
    expect(text).toContain('正文对话里不复述');
  });

  it('有密文但解不开 → 说成我们的故障，不冒充"未实名"', () => {
    const text = render({ identity: { realName: null, authStatus: '已实名', nameUnreadable: true } });
    expect(text).toContain('解密失败');
    expect(text).not.toContain('姓名：未实名');
  });

  it('★否定事实：19 条证据里 0 条合同，必须写出「合同 0」（变异：0 件的类别跳过 → 红）', () => {
    const text = renderCaseFacts(buildCaseFacts(uid2Snapshot()));
    expect(text).toContain('合同 0');
    expect(text).toContain('公司文件 0');
    for (const cat of EVIDENCE_CATEGORIES) expect(text).toContain(`${cat} `);
  });

  it('0 条期限 / 0 个公司主体，也要说清"档案里没有 ≠ 事实上没有"', () => {
    const text = render();
    expect(text).toContain('不等于没有期限');
    expect(text).toContain('不算档案已知');
  });
});

// ========== G-F3 预算上限 ==========

describe('G-F3 预算上限：极端数据也不越界', () => {
  const extreme = makeSnapshot({
    case: { ...CASE_BASE, title: '超长标题'.repeat(50), goal: '目'.repeat(5000), bottom_line: '底'.repeat(5000) },
    evidence: evidence(100),
    timeline: timeline(200),
    openActions: actions(50),
    claims: Array.from({ length: 30 }, (_, i) => ({
      id: i,
      case_id: 2,
      kind: `诉求${i}`,
      amount_fen: 100000 + i,
      calc_json: '{"x":1}'.repeat(30),
      basis: '依据'.repeat(30),
      status: '待定',
      created_at: '2026-08-20 09:00:00',
    })) as ClaimRow[],
    companies: Array.from({ length: 20 }, (_, i) => ({
      id: i,
      case_id: 2,
      name: `公司${i}`.repeat(20),
      uscc: '91110000MA00000000',
      role: '签约主体',
      legal_rep: '张三',
      risk_notes: '风险'.repeat(50),
      sources_json: null,
      created_at: '2026-08-20 09:00:00',
    })) as CompanyProfileRow[],
    deadlines: Array.from({ length: 20 }, (_, i) => ({
      id: i,
      case_id: 2,
      kind: `期限${i}`,
      due_at: '2027-08-19',
      derived_from: '推算依据'.repeat(20),
      resolved_at: null,
      created_at: '2026-08-20 09:00:00',
    })) as DeadlineRow[],
    historyStats: { total: 4000, firstAt: '2026-01-01 00:00:00' },
  });

  it('上限是写死的 4600，不是"当前常量的值"（变异：调大 CASE_FACTS_BUDGET → 红）', () => {
    expect(CASE_FACTS_BUDGET).toBe(4600);
  });

  it('★200 时间线 / 100 证据 / 5000 字 goal / 50 待办 → 渲染 ≤ 4600 字符', () => {
    const text = renderCaseFacts(buildCaseFacts(extreme));
    expect(text.length).toBeLessThanOrEqual(4600);
  });

  it('P0 永不降级：极端数据下姓名/案件/期限/历史统计四段仍在', () => {
    const text = renderCaseFacts(buildCaseFacts(extreme));
    expect(text).toContain('### 当事人');
    expect(text).toContain('### 案件抬头');
    expect(text).toContain('### 本案对话');
    expect(text).toContain('### 法定期限');
    expect(text).toContain('本案历史消息共 4000 条');
  });

  it('降级顺序 P3→P2→P1：证据明细先被压掉，用工基本盘还在', () => {
    const text = renderCaseFacts(buildCaseFacts(extreme));
    expect(text).toContain('明细因预算未注入');
    expect(text).toContain('首诊四项已记录');
  });
});

// ========== G-F4 裁剪留痕 ==========

describe('G-F4 裁剪留痕：裁了必须说裁了多少', () => {
  it('★证据 25 条只列 20 条 → 留痕（变异：删掉留痕行 / 去掉条数上限 → 红）', () => {
    const text = render({ evidence: evidenceShort(25) });
    expect(text).toContain('共 25 条，此处只列 20 条');
    expect(text).toContain('不要假设不存在');
  });

  it('★时间线超预算 → 留痕，且**最早 1 条永远保留**（变异：只留最新 N 条 → 红）', () => {
    const events = timeline(60);
    const text = render({ timeline: events });
    expect(text).toMatch(/共 60 条，此处只列 \d+ 条/);
    expect(text).toContain('起点锚点');
    // 最早那条（数组末尾）必须在，它是工龄计算的起点
    expect(text).toContain(events[events.length - 1].title);
    // 中间某条被裁掉了，否则这条判据没在测裁剪
    expect(text).not.toContain(events[30].title);
  });

  it('★证据明细超分区预算 → 按预算裁并留痕（变异：去掉证据分区预算 → 红）', () => {
    const text = render({ evidence: evidence(25) });
    const m = text.match(/共 25 条，此处只列 (\d+) 条/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(20); // 预算比条数上限更早生效
  });

  it('9 张待办只列 8 张 → 留痕', () => {
    const text = render({ openActions: actions(9) });
    expect(text).toContain('共 9 条，此处只列 8 条');
  });
});

// ========== G-F5 首诊四列 ==========

describe('G-F5 首诊四列进卡', () => {
  it('★有值时四项都必须出现在渲染文本里（变异：删掉其中任一列 → 红）', () => {
    const text = renderCaseFacts(buildCaseFacts(uid2Snapshot()));
    expect(text).toContain('入职日期：2020-11-26');
    expect(text).toContain('岗位：高级风控经理');
    expect(text).toContain('月工资：36440.00 元');
    expect(text).toContain('合同签订次数：续签过一次');
    expect(text).toContain('首诊四项已记录 4/4');
  });

  it('★无值时渲染「未记录」而不是省略（变异：null 时跳过该行 → 红）', () => {
    const text = render();
    for (const label of ['入职日期', '岗位', '月工资', '合同签订次数']) {
      expect(text).toContain(`${label}：未记录`);
    }
    expect(text).toContain('首诊四项已记录 0/4');
  });
});

// ========== G-F6 证据只给元数据 ==========

describe('G-F6 证据只给元数据：免责句常驻', () => {
  it('★免责句一字不改地在场（变异：删掉免责句 → 红）', () => {
    const text = renderCaseFacts(buildCaseFacts(uid2Snapshot()));
    expect(text).toContain(EVIDENCE_DISCLAIMER.replace(/^- /, ''));
    expect(EVIDENCE_DISCLAIMER).toContain('我**没有读过这些文件的内容**');
    expect(EVIDENCE_DISCLAIMER).toContain('必须先问用户');
  });

  it('证据明细被预算压掉时，免责句仍在（它属于统计行，不属于明细）', () => {
    const text = render({ evidence: evidence(100), timeline: timeline(200), openActions: actions(50) });
    expect(text).toContain('我**没有读过这些文件的内容**');
  });

  it('渲染器不读任何"文件内容"字段（evidence 表压根没有这种列）', () => {
    const source = fs.readFileSync(path.join(SRC_ROOT, 'lib/agent/case-facts.ts'), 'utf-8');
    for (const forbidden of ['ocr_text', 'e.text', 'e.content', 'extract']) {
      expect(source).not.toContain(forbidden);
    }
  });
});

// ========== G-F7 不破既有防线 ==========

describe('G-F7 注入位置：事实卡排在危机指令与空包指令之后、输出纪律之前', () => {
  const prompt = buildSystemPrompt({
    snapshot: uid2Snapshot(),
    mode: '陪跑',
    stage: 'done',
    packs: [],
    now: new Date('2026-09-02T10:00:00+08:00'),
    crisis: true,
    emptyPack: true,
  });

  it('★顺序断言（变异：把事实卡挪到危机指令之前 → 红）', () => {
    const crisisAt = prompt.indexOf(CRISIS_DIRECTIVE.slice(0, 20));
    const emptyAt = prompt.indexOf('【本轮无可引用依据】');
    const factsAt = prompt.indexOf('## 案件事实卡');
    const disciplineAt = prompt.indexOf('## 本轮输出纪律');
    expect(crisisAt).toBeGreaterThanOrEqual(0);
    expect(factsAt).toBeGreaterThan(crisisAt);
    expect(factsAt).toBeGreaterThan(emptyAt);
    expect(disciplineAt).toBeGreaterThan(factsAt);
  });

  it('事实卡整体仍在预算内（prompt 里那一段就是 renderCaseFacts 的产物）', () => {
    expect(renderCaseFacts(buildCaseFacts(uid2Snapshot())).length).toBeLessThanOrEqual(4600);
  });
});
