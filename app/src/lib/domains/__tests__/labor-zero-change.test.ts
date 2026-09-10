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
//
// ── 基线换过的那一次（S6，2026-09-10）──
// `caseFacts` 这一项的基线**不再是 4098805 那一份**：S6 往事实卡里加了一节要件表
//（诉求之后、时间线之前，P1），而这份夹具的案子登记着一条 2N 诉求，所以那一节会渲染。
// 判据红是**预期的**——对外产出真的多了一节，不是有人偷偷改了什么。按本文件抬头那条规矩
//（"钉产出的判据只在承诺真变了时红"），这里记下是哪一次改动要它变，并把基线换成改后的那份。
// 其余每一项（首诊校验、危机首段、各类词表、报告分节、分节标题与顺序）**一个字都没动**，
// 与那次搬家时的基线仍然逐字相等。
//
// ── 基线换过的第二次（S6 复审整改第二轮，2026-09-10）──
// `schemas` 里 intake_submit 的 `contract_count` 那一句说明变了：末尾加了
//「一份都没签过的写「没签」（这一格会被二倍工资那一项读取）」。**这也是承诺真的变了**：
// 这一格不再只是一句留档的自述，二倍工资那一项的「满一个月仍没有订立书面合同」
// 直接读它的取值（要件卡 双倍工资-2 的 slotChecks）。说明里不点出来的形态是：
// 模型按"原样记录"把「不记得」「HR 说回头补」录进去，用户要到要件表那一步才知道
// 得回来改这一格。改的是**一句话**，不是校验：合法取值一个都没增减。
//
// ⚠️ **它没有钉 system prompt，别拿它当"labor 的 prompt 没变"的证据。**（第二次复审
// 2026-09-07 点名）buildSystemPrompt 的输出一个字都不在下面这些项里：律师转介口径那一票
// 改了 charter §1、往 labor 的 prompt 里加了一整段闭合清单，本文件从头到尾全绿。
// prompt 那一面由 `lib/agent/__tests__/labor-prompt-snapshot.test.ts` 钉——
// 它的基线是**裁决之后**的文本，与本文件这份"搬家前"的基线不是同一个东西。
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
import { TIMELINE_KINDS } from '@/lib/cases';
import { buildProtocolSection } from '@/lib/paste/protocol';
import type { CaseRow } from '@/lib/db/cases';
import * as knowledge from '@/lib/knowledge';

import { LABOR } from '../labor';
import { DOMAINS, type DomainPack } from '../registry';

/** 基线文件的形状。写出来是为了让漏掉某一项时 tsc 就红，而不是等断言比出 undefined。 */
interface Baseline {
  intakeValidation: Record<string, unknown>;
  intakeStageActions: Record<string, { title: string; detail: string; dueInDays: number | null }[]>;
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
  track: null,
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
        brief_source_tier: '自述',
        brief_asserted_by: 'user',
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
        // 【S4 新增：夹具里两条事件的档位故意不同】一条有书证支撑、一条只有当事人的说法——
        // 逐条档位由数据推出（不再整段贴一句"全部是自述"），这两行就是它的样本：
        // 把 rowTier 的实参写死成同一个值，基线立刻照出来。
        source_tier: '书证',
        asserted_by: 'doc_extract',
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
        source_tier: '自述',
        asserted_by: 'user',
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
        source_tier: '自述',
        asserted_by: 'agent_inferred',
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
        source_tier: '自述',
        asserted_by: 'user',
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
    expect(Object.keys(BASELINE).length).toBeGreaterThanOrEqual(15);
    expect(BASELINE.caseFacts.length).toBeGreaterThan(500);
    // 种子表整张被换成 {} 时上面那条计数照样过，所以这里点名钉它有条目
    expect(Object.values(BASELINE.intakeStageActions).flat().length).toBe(15);
  });

  it('① 首诊校验：合法入参与九种非法入参，逐字段的 errorCode 与话都不变（变异：改 intakeSchema 里任一句 → 红）', () => {
    expect(intakeCases()).toEqual(BASELINE.intakeValidation);
  });

  it('② 事实卡：整张渲染逐字不变（变异：改任一节抬头、或改分区顺序 → 红）', () => {
    expect(renderCaseFacts(buildCaseFacts(snapshot()))).toEqual(BASELINE.caseFacts);
  });

  /**
   * 工具 schema 里那个 kind 枚举是**各领域包该词表的并集**（tools/list 拿不到案件上下文，
   * 见 families/claims.ts 与 families/deadlines-write.ts 的注释）。所以挂上第二个领域包之后，
   * 它必然比基线长——那不是 labor 变了，是清单本来就是并集。
   *
   * 【为什么不能因此把这条判据删掉或改成"包含"】"包含"允许 labor 的项**被重排、被删掉一个再
   * 补上别的**，而那正是搬家时最容易出的事。所以拆成三条各自有牙的断言：
   *   ① labor 自己的词表逐字不变（顺序也不变）；
   *   ② 并集的**前缀恰好是** labor 那一份（顺序与内容都不许动）；
   *   ③ 多出来的那些**恰好等于**其它已注册领域包新带进来的项（不多不少、去重后按注册顺序）。
   * 于是：往 labor 词表加一项 → ①红；把 labor 的项挪个位置 → ②红；
   * 凭空往工具枚举里塞一个谁都没声明的值 → ③红。
   *
   * @param actual 工具的 inputSchema
   * @param baseline 基线里那份 schema（改动前捕获，枚举即 labor 那一份）
   * @param kindsOf 从领域包里取这一项对应的词表
   */
  function expectUnionSchema(
    actual: unknown,
    baseline: unknown,
    kindsOf: (pack: DomainPack) => readonly string[],
  ): void {
    const laborKinds = kindsOf(LABOR);
    const others = Object.values(DOMAINS).filter((p) => p.key !== LABOR.key);
    expect(others.length, '注册表里只有 labor 时，本条退化成"并集 = labor"，仍然成立').toBeGreaterThanOrEqual(0);
    const extras = [...new Set(others.flatMap((p) => kindsOf(p)))].filter((k) => !laborKinds.includes(k));

    const pick = (schema: unknown): string[] =>
      ((schema as { properties: { kind: { enum: string[] } } }).properties.kind.enum);
    const base = pick(baseline);
    const now = pick(actual);

    // ② 前缀恰好是 labor 那一份
    expect(now.slice(0, base.length), 'labor 的那几项在工具枚举里被改动或重排了').toEqual(base);
    // ③ 多出来的恰好是其它领域带进来的
    expect(now.slice(base.length), '工具枚举里多出来的项与已注册领域包对不上').toEqual(extras);

    // schema 的其余部分逐字不变（把 kind 那一格换成基线的再整体比，别的字段改了照样红）
    const normalized = JSON.parse(JSON.stringify(actual)) as { properties: { kind: { enum: string[] } } };
    normalized.properties.kind.enum = base;
    expect(normalized).toEqual(baseline);
  }

  it('③ claim_calc 的 kind 列表不变（变异：往 labor 的 calculatorKinds 加一项、或把它的项重排 → 红）', () => {
    expect(CALC_KINDS).toEqual(BASELINE.calcKinds);
    expect(LABOR.calculatorKinds).toEqual(BASELINE.calcKinds);
    expectUnionSchema(getCapability('claim_calc')?.inputSchema, BASELINE.schemas.claim_calc, (p) => p.calculatorKinds);
  });

  it('④ deadline 的 kind 列表不变（变异：往 labor 的 deadlineKinds 加一项、或把它的项重排 → 红）', () => {
    expect(LABOR.deadlineKinds).toEqual(BASELINE.deadlineKinds);
    expectUnionSchema(getCapability('deadline_set')?.inputSchema, BASELINE.schemas.deadline_set, (p) => p.deadlineKinds);
  });

  it('⑤ 文书种类与那段发出前必读不变（变异：改 outboundDocKinds 或尾注措辞 → 红）', () => {
    expect(DRAFT_KINDS).toEqual(BASELINE.docKinds);
    expect(LABOR.docKinds).toEqual(BASELINE.docKinds);
    expect([...OUTBOUND_DRAFT_KINDS]).toEqual(BASELINE.outboundDocKinds);
    expect(LABOR.outboundDocKinds).toEqual(BASELINE.outboundDocKinds);
    expect(confirmationFooter('对方会据此认为你已接受解除')).toEqual(BASELINE.confirmationFooter);
  });

  /**
   * 【基线动过第二次，记在这：2026-09-07 P5-C1 同意闸】危机首段末尾多了一句**告知**——
   * 「这一次的危机信号我会在你的档案里记一笔：只记时间与信号词的摘要，不另存你的原话」
   *（常量 lib/consent.ts CRISIS_HIT_NOTICE）。
   *
   * 【为什么这次是"承诺变了"却仍然改基线】协议 v0.2 五.1/五.2（2）把危机识别记录列为
   * 我们收集的信息，而此前用户在**发生的那一刻**读不到任何一句说明。这一句是补上的告知，
   * 不是措辞润色——它**必须**改变用户读到的那段文本，否则等于没做。
   *
   * 【它不是一道闸】危机首段不能被任何闸拦（经理裁定）：告知只追加、不阻断、不询问，
   * crisis_hits 照常落行。三处变化仅限 openerFull / openerCompact / split.opener 三个键，
   * 且 `split` 那一项同时证明了它**划进了确定性首段**——`body` 仍然只有「模型段正文」，
   * 所以出口侧的杠杆闸判不到它、也剥不掉它。
   * 【没变的三样】`openerEmpty`（一条热线都取不到的事故态不加这一句，理由见
   * crisis-opener.ts）、`directive`、`safeFallback` 一个字未动。
   *
   * 【基线动过一次，记在这】2026-09-07 核实闭卷，改了本项目**内部**的两处元数据：
   * · `800-810-1117` 的 `agent_note`：「7×24 为官网口径待人工核验」→ 已核对
   *   crisis.org.cn 官网原文「365天7*24小时」；
   * · `12351` 的 `agent_note` 补上号码的官方出处；并**删掉了它的 `hours`**——
   *   服务时间没能在 .gov.cn 原文逐字核到，按纪律不写死。
   *
   * 这两处都在 `compactCard` 里，`agent_note` 从不渲染给用户，`hours` 缺省时开场白不印它。
   * **改基线前先验了这一条：`openerFull` 一个字没动**——用户读到的那段就是对外承诺，
   * 它没变，才轮得到改基线；它要是也变了，那就不是"更新元数据"，是改了承诺。
   */
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
    // 【此前这两行是永远绿的】原文写的是 `claim_register` / `draft_create` —— 两个**不存在的**
    // 能力名（真名是 claims_upsert / draft_write）。`getCapability()` 回 undefined、
    // `?.inputSchema` 回 undefined，而基线里同样没有这两个键 ⇒
    // `expect(undefined).toEqual(undefined)` 恒绿：断言写在那儿，改坏 schema 也不会红。
    // **名字打错与 schema 真的没变，在断言结果上长得一模一样**，所以名字本身要先被验一次。
    // 两份基线取自 4098805 的 `git archive` 副本（与既有三份同一次 dump，逐字节相等）。
    const mustExist = (name: string) => {
      const cap = getCapability(name);
      expect(cap, `能力 ${name} 不存在：能力名打错时断言会退化成 undefined===undefined 而恒绿`).toBeDefined();
      return cap!;
    };
    expect(mustExist('intake_submit').inputSchema).toEqual(BASELINE.schemas.intake_submit);
    // claims_upsert 的 kind 与 claim_calc / deadline_set 同口径，是**并集**，走同一个三条腿的比法
    //
    // 【基线动过第三次，记在这：2026-09-10 S4 复审】`source_tier` 那一格的说明换了。
    // 换的理由不是润色：原来那句「留空落最弱档只是多补一张材料」被三条写能力共用，
    // 而对**补充型**的 company_profile_upsert 它是假的（命中已有行时不传，那两列一个字节不动）。
    // 现在按写入语义各说各的——claims_upsert 是覆盖，不传即落最弱档、不沿用上一版的档位。
    // 这确实是**对外承诺变了**（说明书是对方 agent 唯一能读到的用法说明），所以才改基线；
    // kind 枚举、必填清单、其余每一格的措辞一个字未动。
    expectUnionSchema(mustExist('claims_upsert').inputSchema, BASELINE.schemas.claims_upsert, (p) => p.claimKinds);
    // draft_write 的 kind 取的是 lib/cases/drafts 那一份（不是并集），逐字比
    expect(mustExist('draft_write').inputSchema).toEqual(BASELINE.schemas.draft_write);
  });

  /**
   * 【为什么这张表要单独钉一条】P4-W3 把首诊「现在做这三件事」的种子表从共用层
   *（lib/cases/intake-actions.ts）搬进了 DomainPack.intakeStageActions。搬完之后
   * lib/cases/__tests__/intake.test.ts 那条断言比的是「库里落下的行动卡 == 包里的种子」——
   * 它钉的是**接线**（表真的被读了、真的落了库），两边同源，钉不住**内容**：
   * 把某个阶段的三条种子整段删成 `[]`，那条判据照样绿（空数组等于空数组），
   * 首诊回包 actionsAdded=0、页面上一件事都不推，而没有一处会报错。
   * 所以内容由这里比基线，接线由那边比包，两条各管一头。
   *
   * 【`''` 那个键去哪了】改动前的表是 `Record<CaseStage | '', …>`，第 13 个键是空串
   *（不是任何一个阶段，用来兜住 stage 还没填的案子）。搬进包之后键集合必须**恰好**是
   * 本领域的 stages（assertDomainPack 两个方向都点名），所以空串那一格没有跟着搬；
   * 两处消费点都写着 `?? []`，取不到键时给 0 条种子，行为与原来那一格逐字相同。
   * 这条断言把「少了空串键」写成明账：比的是**基线去掉空串之后**的那 12 个阶段。
   */
  it('⑩ 首诊三件事的种子表逐字不变（变异：删掉「风声」的三条种子、或改任一句 detail → 红）', () => {
    const { '': emptyStageSeeds, ...byStage } = BASELINE.intakeStageActions;
    expect(emptyStageSeeds, '基线里空串那一格本来就是空的，去掉它不改变任何阶段的产出').toEqual([]);
    expect(LABOR.intakeStageActions).toEqual(byStage);
  });

  /**
   * 【为什么补这一条】上面⑧钉的是 `LABOR.claimKinds` 这个**字段**，⑨钉的是它**被谁读**。
   * 这一票把领域包里那个字段改了义（原来的 `calculatorKinds` 装的就是诉求登记的值集，
   * 拆成 claimKinds / calculatorKinds 两份之后含义变了），而回填约定那一行没跟着改：
   * 字段名一个字没动、tsc 绿、上面八条全绿，**说给模型听的那句话却换了一份清单**。
   * 钉产出而不是钉字段，才照得出这种「改的是别处、变的是这里」。
   */
  it('⑨ 回填约定里报给模型的 claims 种类不变（变异：把 protocol.ts 改回 pack.calculatorKinds → 红）', () => {
    const section = buildProtocolSection({ pack: LABOR, timelineKinds: TIMELINE_KINDS });
    expect(section).toContain(`\`kind\` 只能是 ${BASELINE.claimKinds.join(' / ')}`);
    expect(section).not.toContain(BASELINE.calcKinds.join(' / '));
  });
});
