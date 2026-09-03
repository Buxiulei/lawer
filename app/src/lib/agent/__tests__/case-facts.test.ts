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
  const s: CaseSnapshot = {
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
    ...over,
  };
  // 夹具默认「窗口即全部」：没显式给 timelineStats 时按 timeline 推。
  // 窗口截过一刀的形态（真总数 > 窗口）由 snapshot.test.ts 的真库判据守（G-F11）。
  if (!over.timelineStats) {
    s.timelineStats = { total: s.timeline.length, earliest: s.timeline[s.timeline.length - 1] ?? null };
  }
  return s;
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

/**
 * 富形态：uid=2 之上补 2 个公司主体 + 3 项金额诉求。
 * 【为什么要它】公司/诉求的统计行有两条分支，uid=2 走的是「0 个/0 项」那条；
 * 只用 uid=2 断言，非零分支里的 `rows.length` 改成 `rows.length + 1` 也没人吭声（复审 RV-F1）。
 */
function richSnapshot(): CaseSnapshot {
  return {
    ...uid2Snapshot(),
    companies: [
      {
        id: 1,
        case_id: 2,
        name: '宜信惠民（北京）信息科技有限公司',
        uscc: '91110000MA00000000',
        role: '签约主体',
        legal_rep: '张三',
        risk_notes: null,
        sources_json: null,
        created_at: '2026-08-20 09:00:00',
      },
      {
        id: 2,
        case_id: 2,
        name: '宜信普惠信息咨询（北京）有限公司',
        uscc: null,
        role: '发薪主体',
        legal_rep: null,
        risk_notes: null,
        sources_json: null,
        created_at: '2026-08-20 09:00:00',
      },
    ] as CompanyProfileRow[],
    claims: Array.from({ length: 3 }, (_, i) => ({
      id: i,
      case_id: 2,
      kind: `诉求${i}`,
      amount_fen: 100000 * (i + 1),
      calc_json: null,
      basis: '依据若干',
      status: '待定',
      created_at: '2026-08-20 09:00:00',
    })) as ClaimRow[],
  };
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

  /**
   * 事实卡有**两个出口**，一个都不许多：
   *   ① 站内 agent 的 system prompt（lib/agent/prompt.ts）
   *   ② 用户自己的 agent 走 MCP 的 case_facts 工具（lib/mcp/tools.ts）
   * 出口可以有两个，**口径只能有一个**——所以下面不只点名文件，还要求每一处都写成
   * `renderCaseFacts(buildCaseFacts(…))`：谁想自己拼一份事实卡（跳过 buildCaseFacts、
   * 或绕过 renderCaseFacts 的预算裁剪直接 JSON 化 snapshot），这条就红。
   * 那种分叉的形态是：同一个案子在网页里和在用户助手里，「当前事实」不是同一份。
   */
  const RENDER_SITES = ['lib/agent/prompt.ts', 'lib/mcp/tools.ts'];

  it('renderCaseFacts 只有两处出口，且两处都经 buildCaseFacts（变异：别处再调一次 → 红）', () => {
    const callers: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (file.endsWith('case-facts.ts')) continue; // 定义处自身不算调用
      const text = fs.readFileSync(file, 'utf-8');
      const hits = text.match(/renderCaseFacts\(/g);
      if (hits) callers.push(...hits.map(() => file));
    }
    expect(callers.sort()).toEqual(RENDER_SITES.map((r) => path.join(SRC_ROOT, r)).sort());

    for (const rel of RENDER_SITES) {
      const text = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf-8');
      // 允许命名空间前缀（lib/mcp 那侧是 `agent.renderCaseFacts(agent.buildCaseFacts(…))`）
      expect(text, rel).toMatch(/renderCaseFacts\(\s*(?:[\w$]+\.)?buildCaseFacts\(/);
    }

    // 注入侧还要钉在 buildSystemPrompt 里：换个函数注入等于换了注入时机
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

  /** 从渲染文本里把某个统计行的数字抠出来。抠不到本身就是失败——统计行不许消失。 */
  function statNum(text: string, re: RegExp): number {
    const m = text.match(re);
    expect(m, `渲染里找不到统计行 ${re}`).not.toBeNull();
    return Number(m![1]);
  }

  /**
   * ★统计行逐值核对：每个计数都必须等于 snapshot 里对应数组的长度。
   *
   * 【为什么单靠"4 位数字有来源"不够】计数是 1~2 位数，那条判据根本看不见它们；
   * 复审实测把「证据总数 +1 / 期限条数 +1 / 公司个数 +1 / 行动卡张数 +1 / 诉求项数 +1 /
   * 历史最早日期写死」六种编造打进渲染器，全套测试零失败（rd-case-facts/rv-fabrication-mutation.log
   * 行 B/C/D/E/F/G）。运行时今天读的都是 rows.length，但一次把 rows.length 误写成
   * shown.length 的重构就会把假总数灌进 prompt——而假总数正是模型最信、最不会去质疑的那种事实。
   */
  function expectStatsMatchSnapshot(label: string, s: CaseSnapshot) {
    const text = renderCaseFacts(buildCaseFacts(s));
    expect(statNum(text, /证据共 (\d+) 条/), `${label} 证据总数`).toBe(s.evidence.length);
    expect(statNum(text, /法定期限：(\d+) 条/), `${label} 期限条数`).toBe(s.deadlines.length);
    expect(statNum(text, /已登记的公司主体：(\d+) 个/), `${label} 公司个数`).toBe(s.companies.length);
    expect(statNum(text, /未完成的行动卡：(\d+) 张/), `${label} 行动卡张数`).toBe(s.openActions.length);
    expect(statNum(text, /已登记的金额诉求：(\d+) 项/), `${label} 诉求项数`).toBe(s.claims.length);
    expect(statNum(text, /首诊四项已记录 (\d+)\/4/), `${label} 首诊已记录数`).toBe(
      [s.case.employed_from, s.case.position, s.case.monthly_wage_fen, s.case.contract_count].filter(
        // 口径与渲染器一致：null / 空串 / 0 都不算「已记录」（见 G-F5 的空值防御那条）
        (v) => v != null && (typeof v === 'number' ? v > 0 : v.trim().length > 0),
      ).length,
    );
    // 分类计数：8 类逐类核对，不是"出现过就算"
    for (const cat of EVIDENCE_CATEGORIES) {
      const n = s.evidence.filter((e) => e.category === cat).length;
      expect(text, `${label} 分类计数 ${cat}`).toContain(`${cat} ${n}`);
    }
    // 时间线：条数 + 最早 1 条的日期都得对得上（锚点行是工龄起点）
    if (s.timeline.length) {
      expect(statNum(text, /档案里最近的 (\d+) 条事件/), `${label} 时间线条数`).toBe(s.timeline.length);
      expect(text, `${label} 时间线最早 1 条`).toContain(s.timeline[s.timeline.length - 1].happened_at);
    } else {
      expect(text).toContain('时间线：0 条');
    }
    // 历史统计：总数与最早日期都来自 historyStats，不许写死
    if (s.historyStats.total) {
      expect(statNum(text, /本案历史消息共 (\d+) 条/), `${label} 历史总数`).toBe(s.historyStats.total);
      expect(text, `${label} 历史最早日期`).toContain(
        `（最早 ${s.historyStats.firstAt!.slice(0, 10)}）`,
      );
    } else {
      expect(text).toContain('本案还没有已落库的历史消息');
    }
    // 免责句常驻：证据 0 条时最容易被"顺手省略"，而那正是最需要它的形态
    expect(text, `${label} 免责句`).toContain(EVIDENCE_DISCLAIMER.replace(/^- /, ''));
  }

  it('★uid=2 形态：六个统计行逐值等于 snapshot（变异：任一 rows.length + 1 → 红）', () => {
    expectStatsMatchSnapshot('uid2', uid2Snapshot());
  });

  it('★富形态（公司 2 / 诉求 3）：非零分支的计数同样逐值核对', () => {
    expectStatsMatchSnapshot('rich', richSnapshot());
  });

  it('★全空档案：0 也得是真的 0，且证据 0 条时免责句仍在（变异：0 条时省略免责句 → 红）', () => {
    expectStatsMatchSnapshot('empty', makeSnapshot());
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

  /**
   * ★已实名但档案里没有姓名（real_name_enc 为 NULL）。
   *
   * 【为什么必须与「未实名」分成两句】这一态原来复用未实名那句，等于对着一个刚做完实名认证的
   * 用户说「你未实名」——他读到的是系统在否认他刚办完的事，而真正该做的动作也说反了：
   * 这一态要补的是姓名，不是再去实名一遍。变异：两态合并成一句 → 本条红。
   */
  it('★已实名但无姓名记录 → 说"实名已通过、档案里没有姓名"，不谎报未实名', () => {
    const text = render({ identity: { realName: null, authStatus: '已实名', nameUnreadable: false } });
    expect(text).toContain('姓名：实名已通过，但档案里没有姓名记录，文书里我不会替你填');
    expect(text).not.toContain('姓名：未实名');
    expect(text).not.toMatch(/【[^】]*】/);
  });

  it('★未实名那句原样不动（变异：与"已实名无姓名"合并成一句 → 红）', () => {
    const text = render({ identity: { realName: null, authStatus: '未认证', nameUnreadable: false } });
    expect(text).toContain('姓名：未实名，档案里没有你的姓名，文书里我不会替你填');
    expect(text).not.toContain('实名已通过');
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

  it('★realName 有值但 auth_status 不是已实名 → 一个字都不许印（变异：删掉渲染器的 authStatus 闸 → 红）', () => {
    // 裁决①的条件是**两条**：已实名 且 解得开。snapshot.loadIdentity 卡一次、渲染器再卡一次；
    // 复审实测把 loadIdentity 里的 auth_status 条件删掉，全套 3811 例零失败（rv-fabrication-mutation.log 变异 A）。
    for (const st of ['未认证', '待审']) {
      const text = render({ identity: { realName: '冒名者', authStatus: st, nameUnreadable: false } });
      expect(text, `authStatus=${st} 不该印姓名`).not.toContain('冒名者');
      expect(text).toContain('姓名：未实名，档案里没有你的姓名，文书里我不会替你填');
    }
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

describe('G-F3b 时间线降级不是悬崖：任何形态下都留着最早 1 条锚点', () => {
  /**
   * 复审 MF-1：原实现里时间线是「整区压成统计行」——证据明细压掉后仍超预算，
   * 时间线 2400 字整段消失（含裁决③要求永远保留的入职锚点），卡只剩 2300 字、
   * 2200 字预算白白空置。触发形态可达：uid=2 + goal 400 字 + 底线 400 字 + 30 条时间线×104 字明细。
   */
  const realistic = makeSnapshot({
    case: {
      ...CASE_BASE,
      goal: '目'.repeat(400),
      bottom_line: '底'.repeat(400),
      employed_from: '2020-11-26',
      monthly_wage_fen: 3644000,
      position: '高级风控经理',
      contract_count: '续签过一次',
    },
    timeline: timeline(30).map((e) => ({ ...e, detail: '细'.repeat(104) })),
    evidence: evidence(19),
    openActions: actions(8),
    historyStats: { total: 40, firstAt: '2026-08-01 00:00:00' },
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
  });

  const tlLines = (text: string) => (text.match(/^- 20\d\d-\d\d-\d\d｜/gm) ?? []).length;

  it('★双满形态（30 条时间线×104 字 + goal/底线各 400 字）：时间线不整段消失', () => {
    const events = realistic.timeline;
    const text = renderCaseFacts(buildCaseFacts(realistic));
    expect(text.length).toBeLessThanOrEqual(CASE_FACTS_BUDGET);
    expect(text).toContain('起点锚点');
    expect(text).toContain(events[events.length - 1].title); // 入职锚点那条
    expect(text).toMatch(/共 30 条，此处只列 \d+ 条/);
    // ★预算不许空置：整区丢弃时这里是 0，重裁后应当仍装得下若干条最新事件
    expect(tlLines(text)).toBeGreaterThan(5);
  });

  it('★极端形态（200 条时间线 + 100 证据 + 5000 字 goal）：锚点仍在，且不越界', () => {
    const events = timeline(200);
    const text = renderCaseFacts(
      buildCaseFacts(
        makeSnapshot({
          case: { ...CASE_BASE, goal: '目'.repeat(5000), bottom_line: '底'.repeat(5000) },
          timeline: events,
          evidence: evidence(100),
          openActions: actions(50),
        }),
      ),
    );
    expect(text.length).toBeLessThanOrEqual(CASE_FACTS_BUDGET);
    expect(text).toContain('起点锚点');
    expect(text).toContain(events[events.length - 1].title);
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

  /**
   * ★窗口截过一刀时，「共 N 条」与锚点都必须是真值。
   *
   * 【它修的是什么】snapshot 的 TIMELINE_WINDOW=30 先截一刀，事件 45 条时窗口里只有 30 条。
   * 原实现把 lines.length 当总数、把窗口末行当"最早 1 条"：卡上写「共 30 条」
   * （模型据此断言"你一共就这 30 件事"），锚点是第 16 条（拿它当入职起点算工龄少算一大截）。
   * 变异：留痕的 total 改回窗口长度 → 本条红；锚点取窗口最早行 → 本条红。
   */
  it('★真总数 45 / 窗口 30 → 留痕写「共 45 条」，锚点是真最早那条', () => {
    const all = timeline(45).map((e) => ({ ...e, detail: null }));
    const window = all.slice(0, 30); // listTimelineEvents 的 LIMIT 30（倒序，最新在前）
    const text = render({ timeline: window, timelineStats: { total: 45, earliest: all[44] } });
    expect(text).toMatch(/共 45 条，此处只列 \d+ 条/);
    expect(text).not.toMatch(/共 30 条，此处只列/);
    expect(text).toContain('起点锚点');
    // 锚点说明行的下一行就是锚点本身：它必须是真最早那条，不是窗口末行
    const lines = text.split('\n');
    const anchorLine = lines[lines.findIndex((l) => l.includes('起点锚点')) + 1];
    expect(anchorLine).toContain(all[44].title); // 真最早那条（第 1 号事件）
    expect(anchorLine).not.toContain(window[29].title); // 窗口末行（第 15 号事件）不是锚点
  });

  it('★窗口已含最早事件 → 锚点不重复印同一条', () => {
    const all = timeline(12).map((e) => ({ ...e, detail: null }));
    const text = render({ timeline: all, timelineStats: { total: 12, earliest: all[11] } });
    const earliestLine = `- ${all[11].happened_at}｜${all[11].kind}｜${all[11].title}`;
    expect(text.split(earliestLine).length - 1).toBe(1);
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

  /**
   * ★空串与 0 是「没填」，不是「填了个空的 / 填了 0 元」。
   *
   * 【它修的是什么】cases 那四列没有 CHECK 约束，表单空提交与整数默认值都进得来。
   * 原来用 `?? '未记录'` 只挡 null：employed_from='' 渲染成「入职日期：」（模型会当成
   * "有个日期我没看清"），monthly_wage_fen=0 渲染成「月工资：0.00 元」——一个会一路
   * 算进赔偿金额的假事实，而且两者都被计进「已记录 N/4」。变异：改回 `??` → 本条红。
   */
  it('★空串 / 0 一律按未记录处理，且不计进已记录数（变异：改回 `??` → 红）', () => {
    const text = render({
      case: {
        ...CASE_BASE,
        employed_from: '',
        position: '   ',
        monthly_wage_fen: 0,
        contract_count: '',
      },
    });
    expect(text).toContain('入职日期：未记录');
    expect(text).toContain('岗位：未记录');
    expect(text).toContain('月工资：未记录');
    expect(text).toContain('合同签订次数：未记录');
    expect(text).not.toContain('0.00 元');
    expect(text).toContain('首诊四项已记录 0/4');
  });

  it('负数工资同样按未记录处理（脏数据不许变成"欠了用户钱"的事实）', () => {
    const text = render({ case: { ...CASE_BASE, monthly_wage_fen: -1 } });
    expect(text).toContain('月工资：未记录');
    expect(text).toContain('首诊四项已记录 0/4');
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
