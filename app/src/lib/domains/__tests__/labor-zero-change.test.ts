// app/src/lib/domains/__tests__/labor-zero-change.test.ts
// **labor 零变化守卫**（P4-W1）。
//
// 【这份判据在守什么】P4-W1 把散落在 lib/agent、lib/cases、lib/capabilities、app/_ui 里的
// 劳动领域常量搬进了领域包，并让消费方按 cases.domain 取包。搬家的失败形态**不是崩溃**：
// 是某一句话在搬运途中掉了一个字、某个枚举少了一项、某条校验换了顺序——
// 而每一处看起来都很正常，tsc 绿、既有测试绿，只有用户读到的那句话变了。
//
// 【基线怎么来的】在 origin/main = 4098805（改动前）跑一次捕获器，把 labor 的对外产出
// 原样写进 labor-baseline.json。捕获器见 `docs/` 无——它是一次性的，跑法记录在这里：
// 把本文件里的 `snapshot()` / `intakeCases()` 与下面各项 `actual` 原样搬进一个
// `it()` 里 `fs.writeFileSync` 出去即可（改动前的树上，validateIntake 第三参还是 stages）。
//
// 【为什么钉的是"产出"而不是"实现"】实现会被改（这一票就在改），产出不会：
// 用户读到哪句话、agent 收到哪个枚举、危机首段是哪几行——这些是对外承诺。
// 钉实现的判据会在每次重构时误红，于是被顺手改绿；钉产出的判据只在承诺真变了时红。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { APP_TITLE, NEUTRAL_NOTICE, NEUTRAL_TITLE } from '@/app/_ui/bootstrap';
import { buildCaseFacts, renderCaseFacts } from '@/lib/agent/case-facts';
import {
  assessCrisis,
  buildCrisisOpener,
  compactCrisisCard,
  CRISIS_DIRECTIVE,
  CRISIS_NBDPSY_LINE,
  CRISIS_RESOURCE_PACK_ID,
  CRISIS_SAFE_FALLBACK,
  splitCrisisOpener,
  type HotlineFact,
} from '@/lib/agent/crisis';
import type { CaseSnapshot } from '@/lib/agent/snapshot';
import { getCapability } from '@/lib/capabilities';
import { CALC_KINDS } from '@/lib/cases/claims';
import { confirmationFooter, DRAFT_KINDS, OUTBOUND_DRAFT_KINDS } from '@/lib/cases/drafts';
import { validateIntake } from '@/lib/cases/intake';
import { CASE_STAGES } from '@/lib/cases/stages';
import type { CaseRow } from '@/lib/db/cases';
import * as knowledge from '@/lib/knowledge';

import { LABOR } from '../labor';

/** 基线文件的形状。写出来是为了让漏掉某一项时 tsc 就红，而不是等断言比出 undefined。 */
interface Baseline {
  intakeValidation: Record<string, unknown>;
  caseFacts: string;
  factsSections: string[];
  reportSections: unknown;
  stages: string[];
  calcKinds: string[];
  claimKinds: string[];
  deadlineKinds: string[];
  docKinds: string[];
  outboundDocKinds: string[];
  confirmationFooter: string;
  schemas: Record<string, unknown>;
  crisis: Record<string, unknown> & { assess: Record<string, unknown> };
  neutral: unknown;
}

const BASELINE = JSON.parse(
  fs.readFileSync(
    path.join(fileURLToPath(new URL('.', import.meta.url)), 'labor-baseline.json'),
    'utf-8',
  ),
) as Baseline;

const CASE_BASE: CaseRow = {
  id: 2,
  user_id: 2,
  title: '李哲诉宜信体系违法解除',
  stage: '已收通知',
  domain: 'labor',
  district: '朝阳',
  goal: '拿到 2N 并要个说法',
  bottom_line: '不低于 8 万',
  status: '进行中',
  employed_from: '2019-03-01',
  monthly_wage_fen: 3000000,
  position: '高级工程师',
  contract_count: '两次',
  created_at: '2026-08-19 10:00:00',
};

/** 一个把事实卡十个分区全喂满的快照：任何一节的抬头或渲染变了都会照出来 */
function snapshot(): CaseSnapshot {
  return {
    case: CASE_BASE,
    identity: { realName: '李哲', authStatus: '已认证', nameUnreadable: false },
    evidence: [
      {
        id: 100,
        case_id: 2,
        name: '解除通知.pdf',
        category: '解除文件',
        prove_purpose: '证明公司单方解除',
        status: '已上传',
        created_at: '2026-08-20 09:00:00',
        extraction_status: 'none',
        extracted_at: null,
        brief_json: null,
        brief_version: 0,
        brief_error: null,
        void_reason: null,
        voided_at: null,
      },
    ],
    historyStats: { total: 4, firstAt: '2026-08-19 11:00:00' },
    timeline: [
      {
        id: 502,
        case_id: 2,
        happened_at: '2026-08-20',
        kind: '公司动作',
        title: '收到解除通知',
        detail: 'HR 当面递交',
        milestone: null,
        created_at: '2026-08-20 09:00:00',
      },
      {
        id: 501,
        case_id: 2,
        happened_at: '2026-08-18',
        kind: '公司动作',
        title: 'HR 约谈',
        detail: null,
        milestone: null,
        created_at: '2026-08-18 09:00:00',
      },
    ],
    timelineStats: { total: 2, earliest: null },
    claims: [
      {
        id: 1,
        case_id: 2,
        kind: '2N',
        amount_fen: 9000000,
        basis: '劳动合同法第 87 条',
        status: 'draft',
        created_at: '2026-08-20 09:00:00',
      },
    ],
    companies: [
      {
        id: 1,
        case_id: 2,
        name: '某某科技有限公司',
        uscc: null,
        role: '签约主体',
        legal_rep: null,
        risk_notes: null,
        sources_json: '[]',
        created_at: '2026-08-20 09:00:00',
      },
    ],
    openActions: [
      {
        id: 900,
        case_id: 2,
        title: '把解除通知拍照上传',
        detail: null,
        due_at: '2026-09-05T18:00:00+08:00',
        priority: 1,
        status: '待办',
        created_at: '2026-08-20 09:00:00',
      },
    ],
    closedActions: [],
    deadlines: [
      {
        id: 10,
        case_id: 2,
        kind: '仲裁时效',
        due_at: '2027-08-20',
        derived_from: '自 2026-08-20 起一年',
        status: '生效',
        created_at: '2026-08-20 09:00:00',
      },
    ],
    storedIntakeStage: null,
    referredNbdpsy: false,
    report: { state: null, since: null, changes: 0, detail: '' },
    crisisHits72h: 0,
  } as unknown as CaseSnapshot;
}

const TODAY = '2026-09-06';

/** 首诊校验的十种入参：一种合法 + 九种各错一处。每一条的**逐字回话**都钉住。 */
function intakeCases(): Record<string, unknown> {
  const base = {
    stage: '已收通知' as unknown,
    companyName: '某某科技有限公司' as unknown,
    employedFrom: '2019-03-01' as unknown,
    monthlyWageFen: 3000000 as unknown,
    goals: ['拿钱走人'] as unknown,
  };
  const variants: Record<string, Record<string, unknown>> = {
    ok: {},
    'stage 非法': { stage: '不存在的阶段' },
    'stage 非串': { stage: 42 },
    '公司名空': { companyName: '   ' },
    '入职日格式错': { employedFrom: '2019/03/01' },
    '入职日不存在': { employedFrom: '2019-02-30' },
    '入职日晚于今天': { employedFrom: '2099-01-01' },
    '月工资非整数': { monthlyWageFen: 1.5 },
    '月工资为零': { monthlyWageFen: 0 },
    '诉求为空': { goals: [] },
  };
  const out: Record<string, unknown> = {};
  for (const [name, over] of Object.entries(variants)) {
    out[name] = validateIntake({ ...base, ...over } as never, TODAY, LABOR);
  }
  return out;
}

describe('labor 零变化守卫（基线取自 origin/main 4098805）', () => {
  it('基线文件本身有料（空基线会让下面每一条永远绿）', () => {
    expect(Object.keys(BASELINE).length).toBeGreaterThanOrEqual(14);
    expect(BASELINE.caseFacts.length).toBeGreaterThan(500);
  });

  it('① 首诊校验：合法入参与九种非法入参，逐字段的 errorCode 与话都不变（变异：改 intakeSchema 里任一句 → 红）', () => {
    expect(intakeCases()).toEqual(BASELINE.intakeValidation);
  });

  it('② 事实卡：整张渲染逐字不变（变异：改任一节抬头、或改分区顺序 → 红）', () => {
    expect(renderCaseFacts(buildCaseFacts(snapshot()))).toEqual(BASELINE.caseFacts);
  });

  it('③ claim_calc 的 kind 列表不变（变异：往 calculatorKinds 加一项 → 红）', () => {
    expect(CALC_KINDS).toEqual(BASELINE.calcKinds);
    expect(LABOR.calculatorKinds).toEqual(BASELINE.calcKinds);
    expect(getCapability('claim_calc')?.inputSchema).toEqual(BASELINE.schemas.claim_calc);
  });

  it('④ deadline 的 kind 列表不变（变异：往 deadlineKinds 加一项 → 红）', () => {
    expect(LABOR.deadlineKinds).toEqual(BASELINE.deadlineKinds);
    expect(getCapability('deadline_set')?.inputSchema).toEqual(BASELINE.schemas.deadline_set);
  });

  it('⑤ 文书种类与那段发出前必读不变（变异：改 outboundDocKinds 或尾注措辞 → 红）', () => {
    expect(DRAFT_KINDS).toEqual(BASELINE.docKinds);
    expect(LABOR.docKinds).toEqual(BASELINE.docKinds);
    expect([...OUTBOUND_DRAFT_KINDS]).toEqual(BASELINE.outboundDocKinds);
    expect(LABOR.outboundDocKinds).toEqual(BASELINE.outboundDocKinds);
    expect(confirmationFooter('对方会据此认为你已接受解除')).toEqual(BASELINE.confirmationFooter);
  });

  it('⑥ 危机首段与词表：两态首段、指令、兜底、判定结果全部逐字不变（变异：改词表或首段任一句 → 红）', () => {
    const realFacts = knowledge.get(CRISIS_RESOURCE_PACK_ID).facts as { hotlines?: HotlineFact[] };
    const opener = buildCrisisOpener(realFacts);
    expect({
      resourcePackId: CRISIS_RESOURCE_PACK_ID,
      directive: CRISIS_DIRECTIVE,
      nbdpsyLine: CRISIS_NBDPSY_LINE,
      safeFallback: CRISIS_SAFE_FALLBACK,
      openerFull: opener,
      openerCompact: buildCrisisOpener(realFacts, { compact: true }),
      openerEmpty: buildCrisisOpener({ hotlines: [] }),
      compactCard: compactCrisisCard({ id: 'x', title: 't', body: 'b', facts: realFacts }),
      split: splitCrisisOpener(`${opener}\n\n模型段正文`),
      assess: Object.fromEntries(
        Object.keys(BASELINE.crisis.assess).map((m) => [m, assessCrisis(m)]),
      ),
    }).toEqual(BASELINE.crisis);
  });

  it('⑦ NEUTRAL 词典不变（变异：改低调模式的标题或兜底措辞 → 红）', () => {
    expect({ title: NEUTRAL_TITLE, notice: NEUTRAL_NOTICE, appTitle: APP_TITLE }).toEqual(
      BASELINE.neutral,
    );
  });

  it('⑧ 顺带钉住的几份：阶段枚举、诉求种类、事实卡与报告分节、首诊工具 schema', () => {
    expect(CASE_STAGES).toEqual(BASELINE.stages);
    expect(LABOR.stages).toEqual(BASELINE.stages);
    expect(LABOR.claimKinds).toEqual(BASELINE.claimKinds);
    // 基线里 factsSections 还是一串标题（改动前的形状），现在是 {key,title}——
    // 钉的是**标题与顺序**，那才是对外产出；key 是这一票新加的内部取数口径。
    expect(LABOR.factsSections.map((s) => s.title)).toEqual(BASELINE.factsSections);
    expect(LABOR.reportSections).toEqual(BASELINE.reportSections);
    expect(getCapability('intake_submit')?.inputSchema).toEqual(BASELINE.schemas.intake_submit);
    expect(getCapability('claim_register')?.inputSchema).toEqual(BASELINE.schemas.claim_register);
    expect(getCapability('draft_create')?.inputSchema).toEqual(BASELINE.schemas.draft_create);
  });
});
