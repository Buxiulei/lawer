// app/src/lib/agent/tools.ts
// 律师 agent 的工具注册表与执行器。
//
// 【第一原则：结构化落库，禁自由文本直写】（charter §9 末条）
// 模型的正文只负责「说给用户听」，凡是要进档案的东西——事件、诉求金额、行动卡、情绪、
// 公司主体、文书——**只能经这里的工具落库**。正文里写「我已经帮你记到时间线了」而没调工具，
// 那就是没记；下一轮读档案读不到，用户第二天回来发现档案是空的。
// 所以本文件是唯一的写入面，orchestrator 不允许自己往这几张表里写一行。
//
// 【第二原则：闸门在工具里，不在提示词里】
// 行动卡 ≤3 张、文书必附发送后果、心理转介一案一次——这些都是 charter 的硬约束。
// 写进 system prompt 只是「请你遵守」，写进工具执行器才是「你做不到违反」。
// 凡是能机械判定的红线，一律在这里挡，并把拒绝原因回喂给模型让它改正。
import type { Database } from 'better-sqlite3';

import * as cases from '@/lib/cases';
import * as store from '@/lib/db/agent';
import type { ToolDef } from '@/lib/llm';
import type { AgentEventSink } from './events';
import * as calc from './calc';
import {
  isSanbeiCapVerified,
  readCardValueFen,
  readSanbeiCap,
  SANBEI_CAP_PACK_ID,
  SANBEI_CAP_UNVERIFIED_CAVEAT,
  sanbeiCapFacts,
} from '@/lib/cap/sanbei';
import { citationCorrectionDirective, type CitationGuard } from './citation-guard';
import { compactCrisisCard, CRISIS_RESOURCE_PACK_ID } from './crisis';
import { unsupportedVerbatimQuotes } from './citation-block';
import { coreArticleKeys, packCitationGuide, type CoreArticleSources } from './citation-block';
import * as deadline from '@/lib/deadline';
import type { InputSource } from './calc';
import {
  KNOWLEDGE_MISS_DIRECTIVE,
  MAX_INJECTED_PACKS,
  type KnowledgePack,
  type KnowledgeSearcher,
} from './retrieval';

/** charter §2：每次回复 ≤3 张行动卡。超过就不是「现在做什么」，是又一份待办清单。 */
export const MAX_ACTION_CARDS = 3;

/** 与 migrate.ts claims.kind 注释逐字对齐 */
export const CLAIM_KINDS = [
  '2N', 'N', 'N+1', '欠薪', '年假', '加班费', '双倍工资', '年终奖', '竞业补偿', '其他',
] as const;

/** 与 migrate.ts drafts.kind 注释逐字对齐 */
export const DRAFT_KINDS = [
  '异议函', '被迫解除通知', '仲裁申请书', '证据清单', '答辩状', '上诉状', '谈判话术', '其他',
] as const;

/** claim_calc 目前实装的公式（lib/agent/calc）。年假/加班费/双倍工资等后批再加，
 *  加进来之前不列进 enum——列了模型就会调，然后拿到一个「不支持」的错误。 */
export const CALC_KINDS = ['N', 'N+1', '2N', '年假', '双倍工资', '加班费', '待岗', '加付赔偿金', '竞业补偿', '病假工资'] as const;

/**
 * 三倍封顶基数的定义**不在本文件**：值、key、卡 id、单位换算与「待核实」口径
 * 统一收在 `@/lib/cap/sanbei`，首诊结果页与对话共用同一份。
 * 这里只把它们原样再导出，好让既有的 `tools.SANBEI_CAP_*` 引用不必逐处改。
 */
export {
  SANBEI_CAP_PACK_ID,
  SANBEI_CAP_VALUE_KEY,
  readCardValueFen,
  readSanbeiCap,
} from '@/lib/cap/sanbei';

/**
 * 四个非解除补偿类算法的分派：未休年假 / 未签合同双倍工资 / 加班费 / 待岗工资。
 *
 * 返回 null 表示「这个 kind 不归我管」，交回给 N/N+1/2N 那条路。
 *
 * 【为什么必填项在代码里校验而不写进 schema】七种算法的必填项互不相同，schema 只能写
 * 一个七选一的 oneOf——模型对组合约束的遵守率远不如对错误原文的反应。缺什么就回一句
 * 人话告诉它缺什么，它下一轮就补上了。
 */
function calcNonSeverance(
  kind: string,
  args: Record<string, unknown>,
  env: {
    sourceOf: (field: string) => InputSource;
    minWageOpt: { minWageFen?: number };
    ctx: AgentToolContext;
  },
): ToolOutcome | null {
  const { sourceOf, minWageOpt, ctx } = env;
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const posInt = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  let result: calc.CalcResult<object>;
  const inputSources: Record<string, InputSource> = {};

  try {
    if (kind === '年假') {
      const years = num(args.cumulative_work_years);
      const wage = posInt(args.avg_monthly_wage_ex_overtime_fen);
      const through = str(args.through_date);
      const arranged = num(args.arranged_days_this_year);
      if (years === null || years < 0) return reject('年假必须给 cumulative_work_years（累计工作年限，含跨单位；不满 1 年给小数）');
      if (wage === null) return reject('年假必须给 avg_monthly_wage_ex_overtime_fen（前 12 个月**剔除加班工资**后的月均工资，单位分）');
      if (!through) return reject('年假必须给 through_date（结算截止日：离职给离职日，在职按年度给该年 12-31）');
      if (arranged === null || arranged < 0) return reject('年假必须给 arranged_days_this_year（本年度公司已安排休掉的天数，没休就给 0）');
      inputSources.cumulativeWorkYears = sourceOf('cumulative_work_years');
      inputSources.avgMonthlyWageExOvertimeFen = sourceOf('avg_monthly_wage_ex_overtime_fen');
      inputSources.arrangedDaysThisYear = sourceOf('arranged_days_this_year');
      result = calc.calcAnnualLeavePay({
        cumulativeWorkYears: years,
        avgMonthlyWageExOvertimeFen: wage,
        throughDate: through,
        ...(str(args.employed_from) ? { employedFrom: str(args.employed_from)! } : {}),
        arrangedDaysThisYear: arranged,
        ...(Array.isArray(args.prior_years) ? { priorYears: args.prior_years as calc.PriorYearUnused[] } : {}),
        ...(num(args.full_year_days_override) !== null ? { fullYearDaysOverride: num(args.full_year_days_override)! } : {}),
        ...minWageOpt,
        inputSources,
      });
    } else if (kind === '双倍工资') {
      const SCENARIOS = ['first-contract', 'renewal-lapse', 'openended-refusal'] as const;
      const scenario = inEnum(args.scenario, SCENARIOS) as calc.DoubleWageScenario | null;
      const anchor = str(args.anchor_date);
      const claimedAt = str(args.claimed_at);
      const months = Array.isArray(args.months) ? (args.months as calc.DoubleWageMonth[]) : null;
      if (!scenario) return reject('双倍工资必须给 scenario：first-contract（首次未签）/ renewal-lapse（续签断档）/ openended-refusal（拒订无固定期限）');
      if (!anchor) return reject('双倍工资必须给 anchor_date（首签=用工之日；断档=原合同期满之日；拒订=应订无固定期限之日）');
      if (!claimedAt) return reject('双倍工资必须给 claimed_at（主张权利之日）——时效自该日向前一年倒算，这个日期直接决定能要回几个月');
      if (!months || months.length === 0) return reject('双倍工资必须给 months 逐月明细，形如 [{"month":"2025-03","wageFen":1600000}]');
      inputSources.months = sourceOf('months');
      inputSources.anchorDate = sourceOf('anchor_date');
      result = calc.calcDoubleWage({
        scenario,
        anchorDate: anchor,
        ...(str(args.contract_signed_at) ? { contractSignedAt: str(args.contract_signed_at)! } : {}),
        claimedAt,
        months,
        ...minWageOpt,
        inputSources,
      });
    } else if (kind === '加班费') {
      const base = posInt(args.monthly_base_fen);
      if (base === null) return reject('加班费必须给 monthly_base_fen（加班费计算基数，月，单位分）');
      const hours = {
        weekdayOvertimeHours: num(args.weekday_overtime_hours) ?? 0,
        restDayDays: num(args.rest_day_days) ?? 0,
        restDayHours: num(args.rest_day_hours) ?? 0,
        holidayDays: num(args.holiday_days) ?? 0,
        holidayHours: num(args.holiday_hours) ?? 0,
      };
      if (Object.values(hours).every((v) => !v)) {
        return reject('加班费至少要给一项加班时长：weekday_overtime_hours / rest_day_days / rest_day_hours / holiday_days / holiday_hours');
      }
      inputSources.monthlyBaseFen = sourceOf('monthly_base_fen');
      result = calc.calcOvertimePay({ monthlyBaseFen: base, ...hours, ...minWageOpt, inputSources });
    } else if (kind === '待岗') {
      const normal = posInt(args.normal_monthly_wage_fen);
      const months = Array.isArray(args.months) ? (args.months as calc.StandbyMonth[]) : null;
      if (normal === null) return reject('待岗必须给 normal_monthly_wage_fen（提供正常劳动时的全额月工资，单位分）');
      if (!months || months.length === 0) return reject('待岗必须给 months 逐月明细，形如 [{"month":"2025-03","paidFen":254000}]，按月升序');
      if (typeof args.provides_labor !== 'boolean') {
        return reject('待岗必须给 provides_labor（布尔）：超过第 1 个工资支付周期后单位是否仍安排劳动。true=情形A，false=纯待岗');
      }
      // 生活费标准与最低工资同卡，一起现取
      const allowance = readCardValueFen(ctx.searcher?.get?.(MIN_WAGE_PACK_ID)?.facts, DAIGANG_ALLOWANCE_VALUE_KEY);
      inputSources.normalMonthlyWageFen = sourceOf('normal_monthly_wage_fen');
      inputSources.months = sourceOf('months');
      result = calc.calcStandbyWage({
        normalMonthlyWageFen: normal,
        months,
        providesLabor: args.provides_labor,
        ...(posInt(args.agreed_monthly_wage_fen) !== null ? { agreedMonthlyWageFen: posInt(args.agreed_monthly_wage_fen)! } : {}),
        ...(typeof args.genuine_stoppage === 'boolean' ? { genuineStoppage: args.genuine_stoppage } : {}),
        ...minWageOpt,
        ...(allowance ? { livingAllowanceFen: allowance.fen } : {}),
        inputSources,
      } as calc.StandbyWageInput);
    } else if (kind === '加付赔偿金') {
      const items = Array.isArray(args.items) ? (args.items as calc.ArrearsItem[]) : null;
      if (!items || items.length === 0) {
        return reject('加付赔偿金必须给 items 欠付明细，形如 [{"category":"工资","label":"2026-03 工资","amountFen":1500000}]');
      }
      for (const f of ['complaint_filed', 'order_issued', 'overdue_unpaid']) {
        if (typeof args[f] !== 'boolean') {
          return reject(
            `加付赔偿金必须给 ${f}（布尔）。三步行政前置缺一不可：` +
              '①向劳动监察大队投诉 ②劳动行政部门下达限期支付指令书 ③用人单位逾期仍不支付。' +
              '**仲裁委不受理这一项**，三步没走完就主张，用户会白跑一趟立案。',
          );
        }
      }
      inputSources.items = sourceOf('items');
      result = calc.calcArrearsPenalty({
        items,
        complaintFiled: args.complaint_filed as boolean,
        orderIssued: args.order_issued as boolean,
        overdueUnpaid: args.overdue_unpaid as boolean,
        inputSources,
      });
    } else if (kind === '竞业补偿') {
      const avg = posInt(args.avg_monthly_wage_fen);
      const agreedMonths = num(args.agreed_months);
      if (avg === null) return reject('竞业补偿必须给 avg_monthly_wage_fen（离职前 12 个月平均工资，单位分）');
      if (agreedMonths === null || agreedMonths <= 0) return reject('竞业补偿必须给 agreed_months（约定的竞业限制月数）');
      inputSources.avgMonthlyWageFen = sourceOf('avg_monthly_wage_fen');
      inputSources.agreedMonths = sourceOf('agreed_months');
      result = calc.calcNonCompeteComp({
        avgMonthlyWageFen: avg,
        agreedMonths,
        ...(num(args.actual_months) !== null ? { actualMonths: num(args.actual_months)! } : {}),
        ...(posInt(args.agreed_monthly_comp_fen) !== null ? { agreedMonthlyCompFen: posInt(args.agreed_monthly_comp_fen)! } : {}),
        ...(typeof args.clause_effective === 'boolean' ? { clauseEffective: args.clause_effective } : {}),
        ...(posInt(args.paid_comp_fen) !== null ? { paidCompFen: posInt(args.paid_comp_fen)! } : {}),
        ...minWageOpt,
        inputSources,
      } as calc.NonCompeteInput);
    } else if (kind === '病假工资') {
      const months = Array.isArray(args.months) ? (args.months as calc.SickLeaveMonth[]) : null;
      if (!months || months.length === 0) {
        return reject('病假工资必须给 months 逐月明细，形如 [{"month":"2026-03","paidFen":150000}]');
      }
      inputSources.months = sourceOf('months');
      result = calc.calcSickPay({
        months,
        ...(posInt(args.agreed_monthly_sick_pay_fen) !== null
          ? { agreedMonthlySickPayFen: posInt(args.agreed_monthly_sick_pay_fen)! }
          : {}),
        ...minWageOpt,
        inputSources,
      });
    } else {
      return null; // N / N+1 / 2N 不归这里管
    }
  } catch (e) {
    return reject(`计算失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // 加付赔偿金：把两条**会让用户白跑一趟**的前置条件贴在返回值上（指令紧贴约束对象）。
  // 只写进 flags 不够——flags 是给代码看的，这句是逼模型讲给用户听的。
  const noteFor = (k: string): string | null =>
    k === '加付赔偿金'
      ? '**必须同时讲清两件事**：①这一项要先经劳动监察责令限期支付、逾期不付才成立（行政前置）；' +
        '②**仲裁委不受理加付赔偿金**——把它写进仲裁申请会被驳回，用户会白跑一趟立案。'
      : null;
  return persistCalc(kind, result, inputSources, ctx, noteFor(kind));
}

/**
 * 把算完的结果落库并回给模型。**七种算法共用这一段**——金额与算式必须同源，
 * 由工具直接写而不是让模型再调一次 claims_upsert：中间隔一次模型转述就有抄错一位的机会，
 * 而这个数字最后要拿到庭上被对方复算。
 */
/**
 * 给 calc 返回的法律依据补上**逐字原文**（G4 通过标准 (c)：calc_json.basis 属核心依据条）。
 *
 * 【为什么补在这一层而不在 calc 里】calc 是纯函数，把条文原文写进它就等于把一份
 * 会被修订的法律文本焊死在代码里——数据活性归卡（manager 2026-08-20 定式），
 * 与封顶值、最低工资走的是同一条路：**纯函数只给条号，工具层现取原文**。
 *
 * 取不到就**如实留空**，不编、不摘要、不去正文散文里抠——
 * 缺原文只是引用不完整，抠错一句是用户当庭念错法条。
 */
function enrichBasisWithQuotes(
  basis: calc.CalcBasis[],
  ctx: AgentToolContext,
): Array<calc.CalcBasis & { text?: string; source_card?: string }> {
  return basis.map((b) => {
    // 先按 packId 直取，取不到再在全部法条卡里按 law+article 找——
    // calc 的 packId 指向的常是计算规则卡，逐字条文却在法条卡上
    const direct = b.packId ? ctx.searcher?.get?.(b.packId) : undefined;
    const fromDirect = direct?.facts?.statute_quotes?.find((q) => q.article === b.article);
    const hit = fromDirect ?? ctx.searcher?.search?.(`${b.law} ${b.article}`, { type: '法条卡', limit: 5 })
      ?.flatMap((p) => (p.facts?.statute_quotes ?? []).map((q) => ({ q, id: p.id })))
      .find((x) => x.q.article === b.article && b.law.includes(x.q.law.slice(0, 6)));
    const text = fromDirect ? fromDirect.text : (hit as { q?: { text: string } } | undefined)?.q?.text;
    const card = fromDirect ? direct!.id : (hit as { id?: string } | undefined)?.id;
    return { ...b, ...(text ? { text, source_card: card } : {}) };
  });
}

function persistCalc(
  kind: string,
  result: calc.CalcResult<object>,
  inputSources: Record<string, InputSource>,
  ctx: AgentToolContext,
  extraNote?: string | null,
): ToolOutcome {
  const claim = store.upsertClaim(ctx.db, {
    caseId: ctx.caseId,
    kind,
    amountFen: result.amountFen,
    calcJson: JSON.stringify(result),
    basis: result.basis.map((b) => `${b.law}${b.article}`).join('；'),
    status: 'draft',
  });
  ctx.emit({
    event: 'record',
    data: { tool: 'claims_upsert', id: claim.id, summary: `${kind}：${(result.amountFen / 100).toFixed(2)} 元` },
  });
  return ok({
    kind: result.kind,
    amount_fen: result.amountFen,
    amount_yuan: (result.amountFen / 100).toFixed(2),
    formula: result.formula,
    steps: result.steps,
    flags: result.flags,
    // G4 (c)：核心依据条必须附逐字原文 + 来源卡，光条号不算数
    basis: enrichBasisWithQuotes(result.basis, ctx),
    inputs: result.inputs,
    input_sources: inputSources,
    calc_version: result.calcVersion,
    note:
      '展示给用户时必须同时给出 formula 算式与各输入的来源；标「用户自述」的要明说待证据核实。' +
      'basis 里带了 text 的，引用该条时**把 text 的逐字原文一并给出**（引号内照抄）并注明 source_card；' +
      '没有 text 的条只给条号，并说明原文待核实。' +
      (result.flags.length ? `本次触发的特殊档位要逐条讲清：${result.flags.join('、')}。` : '') +
      (extraNote ? ` ${extraNote}` : ''),
  });
}

/** 期间计算通则卡（逐字条文来源）。id 的定义在 lib/deadline——那里也要用它自取卡，全仓只留一份。 */
export const PERIOD_RULE_PACK_ID = deadline.PERIOD_RULE_PACK_ID;

/** 最低工资数据卡：年假折算、双倍工资、加班费、待岗四个公式都要用它兜底下限 */
export const MIN_WAGE_PACK_ID = 'data-beijing-zuidi-gongzi';
export const MIN_WAGE_VALUE_KEY = 'min_wage_monthly';
/** 待岗生活费标准（同一张卡） */
export const DAIGANG_ALLOWANCE_VALUE_KEY = 'daigang_shenghuofei_monthly';

/** 与 migrate.ts emotion_log.level 注释逐字对齐 */
export const EMOTION_LEVELS = ['平稳', '低落', '焦虑', '严重'] as const;

/** 与 migrate.ts company_profiles.role 注释逐字对齐 */
export const COMPANY_ROLES = ['签约主体', '用工主体', '关联'] as const;

/**
 * 「会发给公司」的文书类型。charter 红线 5 只对这几类生效——
 * 谈判话术、证据清单是给用户自己用的，附一段「发出前请确认」纯属噪音。
 */
const OUTBOUND_DRAFT_KINDS: ReadonlySet<string> = new Set(['异议函', '被迫解除通知', '仲裁申请书', '答辩状', '上诉状']);

/** 本轮编排的可变状态。orchestrator 建一份，逐个工具调用累加。 */
export interface TurnState {
  /** 本轮已产出的行动卡数（上限 MAX_ACTION_CARDS） */
  actionCards: number;
  /** 本轮调过几次 knowledge_search */
  searches: number;
  /** 本轮累计检索到的 pack（去重，供 orchestrator 判断是否走「无依据」路径） */
  retrieved: KnowledgePack[];
  /** 本轮是否写过文书 */
  drafts: number;
  /** 本轮 claim_calc 被拒的次数（入参校验不过 / 计算抛错）。重试过程安静，收口时才看它 */
  calcRejects: number;
  /** 本轮是否有过一次成功的计算并落库。有就说明重试成功了，前面的拒绝只是过程 */
  calcSucceeded: boolean;
  /**
   * 本轮 claim_calc 被拒时点名缺的入参（去重）。用来把用户侧告知从
   * 「算不出来」变成「还差这几项，补了我立刻重算」——报错没有出路等于没报。
   */
  calcMissingFields: Set<string>;
}

/** 从 reject 原文里摘出被点名的入参字段（形如 avg_monthly_wage_fen）。 */
function missingFieldsFrom(rejectText: string): string[] {
  return [...new Set(rejectText.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) ?? [])];
}

export function newTurnState(): TurnState {
  return { actionCards: 0, searches: 0, retrieved: [], drafts: 0, calcRejects: 0, calcSucceeded: false, calcMissingFields: new Set() };
}

export interface AgentToolContext {
  db: Database;
  /** 服务端注入，**不来自模型参数**：模型无从把事件写到别人的案子上 */
  caseId: number;
  /** 案件属主。归属校验在进编排循环前已由 lib/cases 做过，这里带着它是为了过 lib/cases 的门 */
  userId: number;
  /** 当前会话线程 id。intake_done 往 threads.intake_stage 落痕要用 */
  threadId: number;
  /** 本轮 assistant 消息的 id，行动卡按它回指「这条为什么要做」 */
  sourceMessageId: number | null;
  /** lib/knowledge 未交付时为 undefined，knowledge_search 走不可用降级 */
  searcher?: KnowledgeSearcher;
  /** 案号运行时闸门。文书落库前过一遍，查无此号的直接拒收 */
  citations: CitationGuard;
  /**
   * 本案 24 小时内是否已给过危机资源卡。
   * knowledge_search 的返回要据此执行**同一套呈现规则**——见该 handler 内注释。
   */
  crisisCardAlreadyGiven: boolean;
  /**
   * ⭐核心条的 S1/S4 取料（档案三来源 + 用户原话）。候选池的 S2 取料面是 `state.retrieved`，
   * 所以这里只带**不随工具调用变化**的那部分，卡的部分现取。
   *
   * 【为什么工具通道也要算⭐】卡进上下文有两条通路，注入是一条、`knowledge_search` 是另一条。
   * 只在注入侧标⭐，模型自己搜回来的卡就永远收不到「这条要引全」的指令——
   * 而实测 S03 三跑里，带 `statute_quotes` 的法条卡**全部**是从工具通路进来的
   * （预检索 6 张全是话术/SOP/判例卡，一条逐字原文都没有）。少堵一个通道，模型就从那个通道绕过去。
   */
  coreSources?: CoreArticleSources;
  state: TurnState;
  emit: AgentEventSink;
}

/** 工具执行结果：回喂给模型的 role:'tool' 正文。ok=false 时模型应据 content 改正后重试。 */
export interface ToolOutcome {
  ok: boolean;
  content: string;
}

function ok(payload: Record<string, unknown>): ToolOutcome {
  return { ok: true, content: JSON.stringify({ ok: true, ...payload }) };
}

function reject(message: string): ToolOutcome {
  return { ok: false, content: JSON.stringify({ ok: false, error: message }) };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** ISO8601 校验；合法则回 ISO 串（落库时由 SQL 的 datetime() 归一，ADR-002） */
function isoOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function inEnum(v: unknown, allowed: readonly string[]): string | null {
  const s = str(v);
  return s && allowed.includes(s) ? s : null;
}

// ───────────────────────── 工具 schema（下发给模型）─────────────────────────
//
// 手写 JSON Schema 字面量，与 lib/mcp/tools.ts 同一风格（那边的理由同样适用：
// 工具数量少、参数浅，引 zod 换来两个依赖和一层转换不划算）。
// case_id 不在任何 schema 里——它由服务端注入，见 AgentToolContext。

export const AGENT_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'knowledge_search',
      description:
        '检索知识库，拿到法条/判例/计算规则/流程SOP/文书模板/话术/数据卡的**逐字原文**。' +
        '任何涉法断言、任何数字、任何文书起草之前都必须先调它——你自己记忆里的条号和数字一律不可用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词，用案情关键词而非整句话，如「客观情况重大变化 北京口径」' },
          type: {
            type: 'string',
            enum: ['法条卡', '判例卡', '计算规则', '流程SOP', '文书模板', '话术卡', '情绪指南', '数据卡'],
            description: '只要某一类卡时传，一般不传',
          },
          limit: { type: 'integer', description: `最多几张，默认 ${MAX_INJECTED_PACKS}` },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'timeline_add',
      description:
        '把用户说到的一个**已发生事实**记进案件时间线。时间线只追加不修改，记错了补一条更正事件。' +
        '每轮对话中用户提到的新事件都要落档，不能只留在对话里。',
      parameters: {
        type: 'object',
        properties: {
          happened_at: { type: 'string', description: '事件发生时间，ISO8601。只知道日期就用当天 00:00' },
          kind: { type: 'string', enum: [...cases.TIMELINE_KINDS], description: '谁做的' },
          title: { type: 'string', description: '一句话概括发生了什么' },
          detail: { type: 'string', description: '细节：谁说了什么、给了什么文件、有无书面留痕' },
        },
        required: ['happened_at', 'kind', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'claims_upsert',
      description:
        '登记或更新一项诉求（金额要素）。同一案同一 kind 只有一条，再调即更新。' +
        '金额未经 claim_calc 算出时 amount_fen 传 0 并在 calc_json 里写清缺哪些输入。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...CLAIM_KINDS], description: '诉求类型' },
          amount_fen: {
            type: 'integer',
            description:
              '金额，单位**分**。**N / N+1 / 2N 不许在这里填**——那三项走 claim_calc，它会直接落库；' +
              '这里只用于用户自述的事实性金额（欠薪本金、年终奖数额等），未确定时传 0',
          },
          calc_json: {
            type: 'string',
            description:
              'JSON 字符串：算式与全部输入，每项标注是「用户自述待证」还是「已有证据」。' +
              '未算出时写 {"status":"待计算","missing":[...]}',
          },
          basis: {
            type: 'string',
            description:
              '法律依据：条号 + **逐字原文**（引号内照抄，别缩写）+ pack id，'
              + '如 《劳动合同法》第三十八条："用人单位未及时足额支付劳动报酬的，劳动者可以解除劳动合同"（statute-lhtf-38-beipo-jiechu）。'
              + '只写条号不写原文的，用户拿去打印、当庭念的时候等于空手（G4 核心依据条要求）。'
              + '检索不到原文就写条号 + "原文待核实"，不要凭记忆补。',
          },
          status: { type: 'string', enum: ['draft', 'confirmed'], description: '默认 draft' },
        },
        required: ['kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'action_card',
      description:
        `产出一张行动卡。**每轮回复至少 1 张、最多 ${MAX_ACTION_CARDS} 张**，这是硬性要求。` +
        '建议必须具体到当天与句子级：「注意留存证据」不合格，「今天 18 点前把这三样导出到个人邮箱：…」才合格。',
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', description: '做什么。一句祈使句，具体到动作' },
          how: {
            type: 'string',
            description: '怎么做。含**可直接照读/粘贴的原句**；涉及对公司说话的，同时写明哪些话绝不能说',
          },
          why: { type: 'string', description: '为什么，一句话，带依据（pack id / 条号）' },
          due_at: { type: 'string', description: '截止时间，ISO8601。「今天下班前」也要换算成具体时刻' },
          priority: { type: 'integer', description: '优先级，数字越大越急，默认 0' },
        },
        required: ['what', 'how', 'why', 'due_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'emotion_log',
      description:
        '记录用户当前情绪状态。识别到低落/焦虑/严重痛苦时都要记，这是长期陪跑看走向的依据。' +
        'refer_nbdpsy 只在符合持续焦虑抑郁表现时置 true，且一个案子最多一次。',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: [...EMOTION_LEVELS], description: '情绪档位' },
          note: { type: 'string', description: '判断依据：用户说了什么（引原话片段）' },
          refer_nbdpsy: { type: 'boolean', description: '本轮是否转介心理咨询，默认 false' },
        },
        required: ['level'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'company_profile_upsert',
      description:
        '登记或补充公司主体档案。签约主体、发工资主体、实际用工主体可能是三家公司，' +
        '仲裁列谁为被申请人由此判定，所以只要用户提到公司名就要落档。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '公司全称，尽量与营业执照一致' },
          uscc: { type: 'string', description: '统一社会信用代码，不知道就不传' },
          role: { type: 'string', enum: [...COMPANY_ROLES], description: '默认签约主体' },
          legal_rep: { type: 'string', description: '法定代表人' },
          risk_notes: { type: 'string', description: '风险点：注册资本、经营异常、关联公司等' },
          sources: { type: 'string', description: '结论出处（用户自述 / 爱企查 / 用户回传截图），必须可溯源' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_write',
      description:
        '起草一份文书并存进案件档案。模板基底一律先用 knowledge_search 取 type=文书模板 的 pack 原文，' +
        '不要凭记忆写格式。发给公司的文书（异议函/被迫解除通知/仲裁申请书/答辩状/上诉状）' +
        '**必须**同时给 send_consequences，说清发出后会发生什么。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...DRAFT_KINDS], description: '文书类型' },
          title: { type: 'string', description: '文书标题' },
          content: { type: 'string', description: '文书全文。填空位保留【】并附填写说明' },
          send_consequences: {
            type: 'string',
            description:
              '发出后果说明：发出后法律关系会怎么变、对方可能怎么应对、哪些是不可逆的。' +
              '发给公司的文书必填，缺了会被拒绝。',
          },
        },
        required: ['kind', 'title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'intake_done',
      description:
        '标记首诊问诊清单已走完（用户已答复特殊保护情形，无论有没有）。' +
        '只在 D 档问过并拿到答复后调一次；不调的话下一轮还会再问一遍同样的问题。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '用户对特殊保护情形的答复摘要，如「无孕产/工伤/医疗期，司龄 3 年」' },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deadline_set',
      description:
        '登记一条法定期限。**你只给起算锚点日期和期限类型，到期日由系统算**——' +
        '不要自己算「某日 + 15 天是几号」，期限错过即权利灭失，这个数不接受心算。' +
        '返回值带推算依据与提醒，展示时要把「未含节假日顺延」如实告诉用户。',
      parameters: {
        type: 'object',
        properties: {
          rule: {
            type: 'string',
            enum: [...deadline.DEADLINE_RULE_KEYS],
            description: '期限类型。举证期限的天数由仲裁委通知书指定，须一并给 days',
          },
          anchor_date: {
            type: 'string',
            description:
              '起算锚点，YYYY-MM-DD。如裁决书签收日、判决书送达日、起诉状副本收到日、解除日、受理通知书收到日',
          },
          days: { type: 'integer', description: '仅「举证期限」需要：通知书上写明的天数，照抄不要猜' },
        },
        required: ['rule', 'anchor_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deadline_resolve',
      description:
        '把一条期限标记为已履行/已作废，停止后续提醒。用户说「我已经起诉了」「答辩状交了」' +
        '「公司 15 日内没起诉、裁决已生效」时调它——不标记的话系统会一直提醒一件已经做完的事。',
      parameters: {
        type: 'object',
        properties: {
          deadline_id: { type: 'integer', description: '期限 id（档案摘要里的「生效中的法定期限」有列）' },
          note: { type: 'string', description: '怎么了结的，一句话' },
        },
        required: ['deadline_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'claim_calc',
      description:
        '按北京口径算钱。七种：经济补偿 N / 代通知金 N+1 / 违法解除赔偿金 2N / 未休年假 / 未签合同双倍工资 / 加班费 / 待岗工资。' +
        '一切金额必须走本工具，**禁止自己心算**——分段、封顶、时效倒算、折算分母你都算不对，而错的金额会直接写进仲裁申请书。' +
        '返回值含算式、分步留痕与法条依据，展示时要把算式和「哪些输入是用户自述待证」一起讲给用户。' +
        '【必填项按 kind 不同】N/N+1/2N 要 avg_monthly_wage_fen+employed_from+terminated_at（N+1 另加 last_month_wage_fen）；' +
        '年假要 cumulative_work_years+avg_monthly_wage_ex_overtime_fen+through_date+arranged_days_this_year；' +
        '双倍工资要 scenario+anchor_date+claimed_at+months；加班费要 monthly_base_fen 与至少一项加班时长；' +
        '待岗要 normal_monthly_wage_fen+months+provides_labor。缺什么工具会回错误告诉你补什么。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...CALC_KINDS], description: '算哪一项' },
          avg_monthly_wage_fen: {
            type: 'integer',
            description:
              '解除前 12 个月平均**应得**工资，单位分。应得=税前、扣个人社保公积金之前，含奖金与加班费；' +
              '用户报的「到手」不是这个数，必须先换算并告诉他差别',
          },
          employed_from: { type: 'string', description: '入职日 YYYY-MM-DD' },
          terminated_at: { type: 'string', description: '解除/终止日 YYYY-MM-DD' },
          last_month_wage_fen: {
            type: 'integer',
            description: '解除前最后一个完整工资月的工资标准（分）。**只有算 N+1 时必填**',
          },
          evidence_backed: {
            type: 'array',
            items: { type: 'string' },
            description:
              '哪些输入已有证据支撑（如 ["avg_monthly_wage_fen"]，依据工资流水）。' +
              '不在这个列表里的一律按「用户自述待证」标注',
          },

          // ── 年假 ──
          cumulative_work_years: { type: 'number', description: '【年假】**累计**工作年限（含跨单位），定 5/10/15 天档；不满 1 年给小数' },
          avg_monthly_wage_ex_overtime_fen: { type: 'integer', description: '【年假】前 12 个月**剔除加班工资**后的月均工资（分）' },
          through_date: { type: 'string', description: '【年假】结算截止日：离职给离职日，在职按年度给该年 12-31' },
          arranged_days_this_year: { type: 'number', description: '【年假】结算年度内公司已安排休掉的年假天数' },
          prior_years: {
            type: 'array',
            description: '【年假】往年未休明细，逐年给',
            items: {
              type: 'object',
              properties: {
                year: { type: 'integer' },
                unusedDays: { type: 'number' },
                fullYearDays: { type: 'number' },
              },
              required: ['year', 'unusedDays'],
            },
          },
          full_year_days_override: { type: 'number', description: '【年假】合同/制度约定高于法定时的全年应休天数' },

          // ── 双倍工资 ──
          scenario: {
            type: 'string',
            enum: ['first-contract', 'renewal-lapse', 'openended-refusal'],
            description: '【双倍工资】首次未签 / 续签断档 / 拒订无固定期限',
          },
          anchor_date: { type: 'string', description: '【双倍工资】起算锚点：用工之日 / 原合同期满之日 / 应订无固定期限之日' },
          contract_signed_at: { type: 'string', description: '【双倍工资】补订书面合同之日；始终未订立就不给' },
          claimed_at: { type: 'string', description: '【双倍工资】主张权利之日——时效自该日向前一年倒算，最敏感的入参' },
          months: {
            type: 'array',
            description: '【双倍工资/待岗】逐月明细。双倍工资给 {month,wageFen}；待岗给 {month,paidFen,workDays?}',
            items: {
              type: 'object',
              properties: {
                month: { type: 'string', description: 'YYYY-MM' },
                wageFen: { type: 'integer' },
                paidFen: { type: 'integer' },
                workDays: { type: 'number' },
              },
              required: ['month'],
            },
          },

          // ── 加班费 ──
          monthly_base_fen: { type: 'integer', description: '【加班费】加班费计算基数（月，分）。约定优先；未约定按实发全部项目扣除上月加班费与伙食补助' },
          weekday_overtime_hours: { type: 'number', description: '【加班费】工作日延时加班小时数（1.5 倍）' },
          rest_day_days: { type: 'number', description: '【加班费】休息日加班**未补休**的天数（2 倍）' },
          rest_day_hours: { type: 'number', description: '【加班费】休息日未补休的零星小时数' },
          holiday_days: { type: 'number', description: '【加班费】法定休假日加班天数（3 倍，补休不能替代）' },
          holiday_hours: { type: 'number', description: '【加班费】法定休假日加班零星小时数' },

          // ── 待岗 ──
          normal_monthly_wage_fen: { type: 'integer', description: '【待岗】提供正常劳动时的全额月工资（分）' },
          provides_labor: { type: 'boolean', description: '【待岗】超过第 1 个工资支付周期后单位是否仍安排劳动：true=情形A，false=纯待岗' },
          agreed_monthly_wage_fen: { type: 'integer', description: '【待岗】情形 A 下双方新约定的月工资标准（分）' },
          genuine_stoppage: { type: 'boolean', description: '【待岗】单位是否确实停工停业。缺省 true；传 false 表示公司正常经营只对个别人「待岗」，须全额支付' },

          // ── 加付赔偿金 ──
          items: {
            type: 'array',
            description: '【加付赔偿金】欠付明细（本金，不含加付部分）',
            items: {
              type: 'object',
              properties: {
                category: { type: 'string', description: '工资 / 加班费 / 经济补偿 等' },
                label: { type: 'string', description: '如「2026-03 至 2026-05 工资」' },
                amountFen: { type: 'integer' },
              },
              required: ['category', 'label', 'amountFen'],
            },
          },
          complaint_filed: { type: 'boolean', description: '【加付赔偿金】第 1 步：是否已向劳动监察大队投诉' },
          order_issued: { type: 'boolean', description: '【加付赔偿金】第 2 步：劳动行政部门是否已下达限期支付/限期改正指令书' },
          overdue_unpaid: { type: 'boolean', description: '【加付赔偿金】第 3 步：用人单位是否逾期仍不支付' },

          // ── 竞业补偿 ──
          agreed_months: { type: 'number', description: '【竞业补偿】约定的竞业限制月数' },
          actual_months: { type: 'number', description: '【竞业补偿】实际已履行月数' },
          agreed_monthly_comp_fen: { type: 'integer', description: '【竞业补偿】约定的月补偿标准（分）；约定高于法定的从其约定' },
          clause_effective: { type: 'boolean', description: '【竞业补偿】竞业条款是否有效' },
          paid_comp_fen: { type: 'integer', description: '【竞业补偿】公司已支付的补偿合计（分）' },

          // ── 病假工资 ──
          agreed_monthly_sick_pay_fen: { type: 'integer', description: '【病假工资】合同/制度约定的月病假工资标准（分）' },
        },
        // 只硬性要求 kind：七种算法的必填项各不相同，逐 kind 在代码里校验并回喂具体缺了什么，
        // 比在 schema 里写一个七选一的 oneOf 更好使——模型看得懂错误原文，看不懂 schema 组合约束
        required: ['kind'],
      },
    },
  },
];

// ───────────────────────── 执行器 ─────────────────────────

type Handler = (args: Record<string, unknown>, ctx: AgentToolContext) => ToolOutcome;

const HANDLERS: Record<string, Handler> = {
  knowledge_search(args, ctx) {
    const query = str(args.query);
    if (!query) return reject('query 不能为空');
    ctx.state.searches += 1;

    if (!ctx.searcher) {
      ctx.emit({
        event: 'notice',
        data: { code: 'KNOWLEDGE_UNAVAILABLE', message: '知识库检索暂不可用，本轮回复已按「需要核实」保守路径生成' },
      });
      return ok({ packs: [], note: KNOWLEDGE_MISS_DIRECTIVE });
    }

    const limit = Math.min(Number(args.limit) || MAX_INJECTED_PACKS, MAX_INJECTED_PACKS);
    const packs = ctx.searcher.search(query, { limit, type: str(args.type) ?? undefined });
    // 已经在本轮上下文里的卡只回一个指针，不再重发全文。
    // 预检索已经把最贴题的几张原样放进 system prompt，模型再搜一次往往命中同一批；
    // 把 12000 字的 534 号卡在一轮里发两遍，既拖慢首字也白烧钱，而模型手上并没多任何信息。
    const alreadyInContext = new Set(ctx.state.retrieved.map((r) => r.id));
    for (const p of packs) {
      if (!alreadyInContext.has(p.id)) ctx.state.retrieved.push(p);
    }
    if (packs.length === 0) {
      ctx.emit({
        event: 'notice',
        data: { code: 'KNOWLEDGE_MISS', message: `「${query}」没有检索到依据卡，本轮相关结论按保守路径处理` },
      });
      return ok({ packs: [], note: KNOWLEDGE_MISS_DIRECTIVE });
    }
    // 【呈现规则必须覆盖每一条文本进上下文的通道】
    // 实测（S08 补跑，2026-08-20）：混合形态管住了「注入」通道（窗内注入紧凑版），
    // 但模型在任一轮都能自己调 knowledge_search 把**整卡全文**拉回上下文再复述——
    // 于是用户连着两轮看见整张卡。这是上一次教训的完整版：
    // 去重的对象是**用户看到了什么**，那就必须在每一个能把文本送进上下文的通道上执行同一套规则，
    // 少堵一个通道，模型就从那个通道绕过去。
    const applyPresentationRule = <T extends { id: string; body: string; title: string }>(p: T): T =>
      p.id === CRISIS_RESOURCE_PACK_ID && ctx.crisisCardAlreadyGiven ? compactCrisisCard(p) : p;

    // ⭐核心条：S1 恒优先，S1 空时由 S2（本轮已进上下文的带原文法条卡）与 S4（用户点名）撑起
    const core = coreArticleKeys({ ...ctx.coreSources, retrieved: ctx.state.retrieved });

    // 新卡的 body 原样返回，一个字都不摘要——理由见 retrieval.ts KnowledgePack.body 注释
    return ok({
      packs: packs.map(applyPresentationRule).map((p) => ({
        id: p.id,
        type: p.type,
        title: p.title,
        region: p.region,
        confidence: p.confidence,
        updated: p.updated,
        ...(alreadyInContext.has(p.id)
          ? { body_omitted: '这张卡的全文已经在你的 system prompt「本轮检索到的依据」里，按 id 往上翻即可，不重复下发。' }
          : { body: p.body }),
        // G4：引用要求与拼好的引用块**跟着这张卡一起回**，不靠下面那句通用 note——
        // 工具返回是卡进上下文的第二条通路，两条通路必须执行同一套规则（教训 10）。
        // ⭐核心条同理：候选池的取料面是**注入包 ∪ 本轮已进上下文的卡**（state.retrieved，
        // 上面刚把新卡 push 进去），两条通路共用同一个确定性函数出键。
        citation_guide: packCitationGuide(p, core),
      })),
      note: '引用时：法条给条号+逐字原文，判例给案号+来源，数字给值与生效期间；confidence 为「待核实」的必须如实带上这个状态。每张卡的 citation_guide 已经把可引用内容拼好，照抄即可。',
    });
  },

  timeline_add(args, ctx) {
    const happenedAt = isoOrNull(args.happened_at);
    if (!happenedAt) return reject('happened_at 必须是合法 ISO8601 时间串');
    const kind = inEnum(args.kind, cases.TIMELINE_KINDS);
    if (!kind) return reject(`kind 只能是 ${cases.TIMELINE_KINDS.join(' / ')}`);
    const title = str(args.title);
    if (!title) return reject('title 不能为空');

    // 走 lib/cases 而不是直接落库：它带着归属校验与枚举校验，
    // agent 面和网页/MCP 面必须是同一批函数，否则两条入口的行为会悄悄分叉。
    const res = cases.addTimelineEvent(ctx.db, {
      caseId: ctx.caseId,
      userId: ctx.userId,
      happenedAt,
      kind,
      title,
      detail: str(args.detail),
    });
    if (!res.ok) return reject(res.message);
    ctx.emit({ event: 'record', data: { tool: 'timeline_add', id: res.event.id, summary: `${kind}：${title}` } });
    return ok({ id: res.event.id });
  },

  claims_upsert(args, ctx) {
    const kind = inEnum(args.kind, CLAIM_KINDS);
    if (!kind) return reject(`kind 只能是 ${CLAIM_KINDS.join(' / ')}`);
    const amountRaw = Number(args.amount_fen ?? 0);
    if (!Number.isInteger(amountRaw) || amountRaw < 0) return reject('amount_fen 必须是非负整数（单位：分）');

    // 【资金数据不经模型转述】（manager 2026-08-19 项目级范式）
    // N / N+1 / 2N 是**算出来的**数，只能由 claim_calc 直接落库。
    // 放任模型在这里填一个自己算的数，等于给「庭上要被对方复算的金额」开了一条无算式、
    // 无输入快照、无法复算的旁路——而它填错一位没有任何东西拦得住。
    // 其它 kind（欠薪本金、年终奖数额…）是用户陈述的事实而非计算结果，照常允许，
    // 但要求在 calc_json 里写明来源与待证状态。
    if ((CALC_KINDS as readonly string[]).includes(kind) && amountRaw > 0) {
      return reject(
        `${kind} 的金额必须走 claim_calc 计算（它会带算式、输入快照与法条依据直接落库），不要在这里自己填数。` +
          '本工具只用于登记诉求项与补充依据；要改金额请调 claim_calc。',
      );
    }

    const res = store.upsertClaim(ctx.db, {
      caseId: ctx.caseId,
      kind,
      amountFen: amountRaw,
      calcJson: str(args.calc_json),
      basis: str(args.basis),
      status: inEnum(args.status, ['draft', 'confirmed']) ?? 'draft',
    });
    ctx.emit({
      event: 'record',
      data: {
        tool: 'claims_upsert',
        id: res.id,
        summary: amountRaw > 0 ? `诉求 ${kind}：${(amountRaw / 100).toFixed(2)} 元` : `诉求 ${kind}：待计算`,
      },
    });
    return ok({ id: res.id, created: res.created });
  },

  action_card(args, ctx) {
    // 闸门在这里而不在提示词里：第 4 张直接不落库，并把原因回喂让模型自己合并
    if (ctx.state.actionCards >= MAX_ACTION_CARDS) {
      ctx.emit({
        event: 'notice',
        data: { code: 'ACTION_CARD_CAPPED', message: `本轮行动卡已达 ${MAX_ACTION_CARDS} 张上限，多余的卡未采纳` },
      });
      return reject(
        `本轮行动卡已达上限 ${MAX_ACTION_CARDS} 张（charter §2）。不要再调用 action_card；` +
          '如果这一张更重要，请在正文里说明取舍，把最不急的那件留到下一轮。',
      );
    }
    const what = str(args.what);
    const how = str(args.how);
    const why = str(args.why);
    if (!what || !how || !why) return reject('what / how / why 三项都不能为空（charter §2：做什么/怎么做/为什么）');
    const dueAt = isoOrNull(args.due_at);
    if (!dueAt) return reject('due_at 必须是合法 ISO8601 时间串。「今天下班前」也要换算成具体时刻');

    const priority = Number.isInteger(Number(args.priority)) ? Number(args.priority) : 0;
    const detail = `怎么做：${how}\n为什么：${why}`;
    const id = store.insertActionItem(ctx.db, {
      caseId: ctx.caseId,
      title: what,
      detail,
      dueAt,
      priority,
      sourceMessageId: ctx.sourceMessageId,
    });
    ctx.state.actionCards += 1;
    ctx.emit({
      event: 'action',
      data: { id, title: what, detail, due_at: dueAt, priority, index: ctx.state.actionCards },
    });
    return ok({ id, index: ctx.state.actionCards, remaining: MAX_ACTION_CARDS - ctx.state.actionCards });
  },

  emotion_log(args, ctx) {
    const level = inEnum(args.level, EMOTION_LEVELS);
    if (!level) return reject(`level 只能是 ${EMOTION_LEVELS.join(' / ')}`);

    let refer = args.refer_nbdpsy === true;
    let referNote: string | undefined;
    if (refer && (level === '平稳' || level === '低落')) {
      // spec §10 / charter §5：只有持续焦虑抑郁表现才谈转介，情绪一般时提就是趁人之危
      refer = false;
      referNote = '情绪档位未达「焦虑」以上，本次不转介（spec §10 引流红线）。';
    }
    if (refer && store.hasReferredNbdpsy(ctx.db, ctx.caseId)) {
      refer = false;
      referNote = '本案此前已转介过一次，不再重复提示（spec §10：一案最多一次）。';
      ctx.emit({
        event: 'notice',
        data: { code: 'REFERRAL_ALREADY_USED', message: '本案已提示过心理咨询，本次不重复' },
      });
    }

    const id = store.insertEmotionLog(ctx.db, {
      caseId: ctx.caseId,
      level,
      note: str(args.note),
      referredNbdpsy: refer,
    });
    ctx.emit({ event: 'record', data: { tool: 'emotion_log', id, summary: `情绪：${level}` } });
    return ok({ id, referred: refer, ...(referNote ? { note: referNote } : {}) });
  },

  company_profile_upsert(args, ctx) {
    const name = str(args.name);
    if (!name) return reject('name 不能为空');
    const res = store.upsertCompanyProfile(ctx.db, {
      caseId: ctx.caseId,
      name,
      uscc: str(args.uscc),
      role: inEnum(args.role, COMPANY_ROLES) ?? '签约主体',
      legalRep: str(args.legal_rep),
      riskNotes: str(args.risk_notes),
      sourcesJson: str(args.sources) ? JSON.stringify([str(args.sources)]) : null,
    });
    ctx.emit({
      event: 'record',
      data: { tool: 'company_profile_upsert', id: res.id, summary: `公司主体：${name}` },
    });
    return ok({ id: res.id, created: res.created });
  },

  draft_write(args, ctx) {
    const kind = inEnum(args.kind, DRAFT_KINDS);
    if (!kind) return reject(`kind 只能是 ${DRAFT_KINDS.join(' / ')}`);
    const title = str(args.title);
    const content = str(args.content);
    if (!title || !content) return reject('title 与 content 都不能为空');

    // 【案号闸门】文书是要发给公司、要进仲裁卷宗的东西，里面一个编的案号就是事故。
    // 与正文不同，这里**不替它打补丁**：拒收 + 回喂改正指令，让模型自己改对了重写。
    const badCitations = ctx.citations.check(content, `文书《${title}》`);
    if (badCitations.length) {
      ctx.emit({
        event: 'notice',
        data: { code: 'CITATION_BLOCKED', message: `文书里的案号 ${badCitations.join('、')} 知识库中不存在，已拒绝落库` },
      });
      return reject(citationCorrectionDirective(badCitations));
    }

    // 【第五闸 · 文书通道】伪逐字引用在文书里比在正文里更致命：文书是要**发出去**、
    // 要进仲裁卷宗的。与正文的「改口」不同，这里**拒收**——发出去的东西不能带伪引用出门，
    // 而模型完全可以在下一轮用真检索到的原文重写。
    const fakeQuotes = unsupportedVerbatimQuotes(content, ctx.state.retrieved);
    if (fakeQuotes.length) {
      ctx.emit({
        event: 'notice',
        data: {
          code: 'CITATION_BLOCKED',
          message: `文书里有 ${fakeQuotes.length} 处「本轮未检索到、却以引号逐字引用」的法条文本，已拒绝落库`,
        },
      });
      return reject(
        `文书《${title}》里这些"逐字引用"在本轮检索到的依据里查无此文：` +
          fakeQuotes.map((q) => `「${q.slice(0, 30)}…」`).join('、') +
          '。请先用 knowledge_search 取到原文再逐字引用；取不到就写「这一条我需要核实原文」，' +
          '**不要凭记忆复述条文**——用户会把文书原样递交，编的条文一查即穿。',
      );
    }

    const consequences = str(args.send_consequences);
    // charter 红线 5：发给公司的文书**必须**附发送后果。缺了就不写库——
    // 这不是提示，是闸门：让模型补齐后重试，而不是我们替它编一段后果说明。
    if (OUTBOUND_DRAFT_KINDS.has(kind) && !consequences) {
      return reject(
        `《${kind}》是要发给公司的文书，charter 红线 5 要求必须同时给出 send_consequences（发出后果说明）。` +
          '请说清：发出后法律关系怎么变、对方可能怎么应对、哪一步是不可逆的，然后重新调用本工具。',
      );
    }

    const body = OUTBOUND_DRAFT_KINDS.has(kind) ? `${content}\n\n${confirmationFooter(consequences!)}` : content;
    // status 恒 draft：本系统不存在「已发出」状态——发不发、什么时候发，只有用户能决定
    const row = store.insertDraft(ctx.db, { caseId: ctx.caseId, kind, title, content: body, status: 'draft' });
    ctx.state.drafts += 1;
    ctx.emit({
      event: 'draft',
      data: { id: row.id, kind, title, version: row.version, requires_confirmation: true },
    });
    return ok({ id: row.id, version: row.version, note: '已存为草稿。正文里必须告诉用户：发不发由他决定，系统不会代发。' });
  },

  intake_done(args, ctx) {
    const summary = str(args.summary);
    if (!summary) return reject('summary 不能为空：写清用户对特殊保护情形答了什么');
    if (!ctx.threadId) return reject('当前会话没有可落痕的线程，无法标记问诊完成');
    store.updateIntakeStage(ctx.db, ctx.threadId, 'done');
    ctx.emit({
      event: 'record',
      data: { tool: 'intake_done', id: ctx.threadId, summary: `首诊清单走完：${summary}` },
    });
    return ok({ intake_stage: 'done' });
  },

  deadline_set(args, ctx) {
    const rule = str(args.rule);
    const anchor = str(args.anchor_date);
    if (!rule || !anchor) return reject('rule 与 anchor_date 都必填');

    // 期间计算通则的逐字条文从卡读（不再手抄进代码常量——卡更新代码会跟着变）
    const ruleCard = ctx.searcher?.get?.(PERIOD_RULE_PACK_ID);
    const generalRule = deadline.buildPeriodGeneralRule(ruleCard?.facts?.statute_quotes, ruleCard?.confidence);

    let computed: deadline.DeadlineComputation;
    try {
      computed = deadline.computeDeadline(rule, anchor, { days: Number(args.days), generalRule });
    } catch (e) {
      return reject(e instanceof Error ? e.message : String(e));
    }

    const row = store.insertDeadline(ctx.db, {
      caseId: ctx.caseId,
      kind: computed.rule.storedKind,
      dueDate: computed.dueDate,
      derivedFrom: computed.derivedFrom,
    });
    ctx.emit({
      event: 'record',
      data: { tool: 'deadline_set', id: row.id, summary: `${computed.rule.label}：${computed.dueDate}` },
    });
    return ok({
      id: row.id,
      due_date: computed.dueDate,
      label: computed.rule.label,
      derived_from: computed.derivedFrom,
      basis: computed.rule.basis,
      caveats: computed.caveats,
      note: '把到期日、推算依据与全部 caveats（尤其「未含节假日顺延」）一起讲给用户，别只报一个日子。',
    });
  },

  deadline_resolve(args, ctx) {
    const id = Number(args.deadline_id);
    if (!Number.isInteger(id) || id <= 0) return reject('deadline_id 必须是正整数');
    // 归属由 case_id 兜底：不是本案的期限一律当不存在
    if (!store.resolveDeadline(ctx.db, ctx.caseId, id)) {
      return reject(`期限 #${id} 不存在、不属于本案，或已经标记过了`);
    }
    ctx.emit({
      event: 'record',
      data: { tool: 'deadline_set', id, summary: `期限 #${id} 已了结${str(args.note) ? `：${str(args.note)}` : ''}` },
    });
    return ok({ id, resolved: true });
  },

  claim_calc(args, ctx) {
    const kind = inEnum(args.kind, CALC_KINDS);
    if (!kind) return reject(`kind 只能是 ${CALC_KINDS.join(' / ')}`);

    // 未被显式列为「有证据」的输入一律标 用户自述——charter §3 要求说明哪些输入待证，
    // 默认值往保守那边靠：宁可多标一个待证，也不能让没证据的数字看起来已经坐实。
    const backed = new Set(Array.isArray(args.evidence_backed) ? args.evidence_backed.map(String) : []);
    const sourceOf = (field: string): InputSource => (backed.has(field) ? '证据佐证' : '用户自述');

    // 最低工资是**七个公式**的共同下限，同样**现取卡值**：
    // 写死在 calc 里的话，北京每次调标准都要改代码，而没人会记得回来改。
    // 【N/N+1/2N 也吃这个下限】第四十七条的基数低于最低工资时按最低工资兜底
    // （jingji-buchang.ts 的 minWageFloor 档）——早先只把卡值注给了四个新公式，
    // N 这条最常走的路反而一直在用代码内置常量，触底案例会照着一个过期的数算钱。
    const minWageCard = ctx.searcher?.get?.(MIN_WAGE_PACK_ID);
    const minWage = readCardValueFen(minWageCard?.facts, MIN_WAGE_VALUE_KEY);
    const minWageOpt = minWage ? { minWageFen: minWage.fen } : {};
    if (!minWage) {
      ctx.emit({
        event: 'notice',
        data: {
          code: 'KNOWLEDGE_UNAVAILABLE',
          message: `最低工资未能从数据卡 ${MIN_WAGE_PACK_ID} 取到当前值，本次计算使用代码内置缺省值——引用前须以最新公布值核实。`,
        },
      });
    }

    // ── 四个非解除补偿类算法：各自的必填项在这里逐条校验并回喂 ──
    const nonSeverance = calcNonSeverance(kind, args, { sourceOf, minWageOpt, ctx });
    if (nonSeverance) return nonSeverance;

    const avg = Number(args.avg_monthly_wage_fen);
    if (!Number.isInteger(avg) || avg <= 0) {
      return reject('avg_monthly_wage_fen 必须是正整数（单位：分，且是**应得**工资不是到手工资）');
    }
    const employedFrom = str(args.employed_from);
    const terminatedAt = str(args.terminated_at);
    if (!employedFrom || !terminatedAt) return reject('employed_from 与 terminated_at 都必填，格式 YYYY-MM-DD');

    const inputSources: Record<string, InputSource> = {
      avgMonthlyWageFen: sourceOf('avg_monthly_wage_fen'),
      employedFrom: sourceOf('employed_from'),
      terminatedAt: sourceOf('terminated_at'),
    };

    // 三倍封顶值：优先取数据卡的当前值，取不到才落到 calc 的内置常量（并如实告知）
    const capCard = ctx.searcher?.get?.(SANBEI_CAP_PACK_ID);
    const cap = readSanbeiCap(capCard?.facts);
    const sanbeiCapFen = cap?.capFen ?? null;
    if (cap && !isSanbeiCapVerified(cap)) {
      // 值取到了但卡自己标着待核实——charter §3 要求如实带上这个状态，不能因为「有数」就当它坐实了
      ctx.emit({
        event: 'notice',
        data: {
          code: 'KNOWLEDGE_MISS',
          message: `三倍封顶基数取自数据卡当前值，但该值可信度为「${cap.confidence}」——引用金额时须一并告知用户。`,
        },
      });
    }
    if (sanbeiCapFen === null) {
      ctx.emit({
        event: 'notice',
        data: {
          code: 'KNOWLEDGE_UNAVAILABLE',
          message:
            `三倍封顶基数未能从数据卡 ${SANBEI_CAP_PACK_ID} 取到当前值，本次计算使用代码内置缺省值，` +
            '结果已标注「社平新值待核实」——引用前须以最新公布值核实。',
        },
      });
    }

    // 展示要求紧贴数据本身下发：把「这个数怎么讲给用户」写在返回值里，
    // 比写在通用指令区管用得多（实测：写在开头的「别重印整张卡」被无视了两轮）。
    const capNote = cap
      ? `本次三倍封顶基数取自数据卡：**${sanbeiCapFacts(cap)}**。` +
        `讲封顶检查时这三项要逐字给全${isSanbeiCapVerified(cap) ? '' : `，并明说${SANBEI_CAP_UNVERIFIED_CAVEAT}`}。`
      : null;

    // sanbeiCapFen 传 undefined 时 calc 会用内置常量并自动打上「社平新值待核实」flag。
    // minWageOpt 同理：卡取得到就注入当前值，取不到就留空走 calc 的内置缺省（上面已发 notice）。
    const common = {
      avgMonthlyWageFen: avg,
      employedFrom,
      terminatedAt,
      ...(sanbeiCapFen === null ? {} : { sanbeiCapFen }),
      ...minWageOpt,
    };

    let result: calc.CalcResult<object>;
    try {
      if (kind === 'N+1') {
        const lastMonth = Number(args.last_month_wage_fen);
        if (!Number.isInteger(lastMonth) || lastMonth <= 0) {
          return reject('算 N+1 必须给 last_month_wage_fen（解除前最后一个完整工资月的工资标准，单位分）');
        }
        inputSources.lastMonthWageFen = sourceOf('last_month_wage_fen');
        result = calc.calcNPlus1({ ...common, lastMonthWageFen: lastMonth, inputSources });
      } else if (kind === '2N') {
        result = calc.calc2N({ ...common, inputSources });
      } else {
        result = calc.calcN({ ...common, inputSources });
      }
    } catch (e) {
      // 日期非法一类的输入错误：回喂原文让模型改正，不炸掉整轮
      return reject(`计算失败：${e instanceof Error ? e.message : String(e)}`);
    }

    // 落库与回报走七种算法共用的那一段（calc_json 留痕，charter §3）
    return persistCalc(kind, result, inputSources, ctx, capNote);
  },
};

/** charter §7.5 的固定尾注。措辞写死在代码里，不交给模型每次即兴发挥——
 *  这段话是用户按下「发送」之前看到的最后一道提醒，不能有的轮次强有的轮次弱。 */
function confirmationFooter(consequences: string): string {
  return [
    '────────────────',
    '【发出前必读】',
    `1. 发出后果：${consequences}`,
    '2. 这份文书一旦发出即无法撤回，对方会据此形成书面记录并可能作为证据使用。',
    '3. 发出前请再读一遍全文：核对每个日期、金额与事实描述，删掉任何你并不打算承认的表述。',
    '4. 发不发、什么时候发、用什么方式送达，由**你自己**决定。本系统不会替你发出。',
  ].join('\n');
}

/**
 * 执行一次模型发起的工具调用。
 * 参数解析失败、工具不存在、校验不过——一律**回喂错误让模型改正**，不抛错中断整轮：
 * 用户等在屏幕前，一次参数写错就把整个回复弄丢是不可接受的。
 *
 * 【这句话此前只对参数解析成立】(2026-09-02) 上面这段注释写着「不抛错中断整轮」，
 * 但 `handler(args, ctx)` 是**裸调**的：句柄自己抛（落库撞约束、库被锁、磁盘满），
 * 异常就一路穿出 tool-loop → runTurn → 路由的 catch，一次坏三样，与 F-02/F-10 同形：
 * 排在它后面的工具不再执行、正文停在 NULL（刷新即永久消失）、这一轮不记账。
 * 病灶不同（那次是 SSE controller 关了，这次是写库真的失败），**下场完全一样**，
 * 所以补在同一个地方：`executeTool` 是全部工具调用的**唯一入口**，
 * 包在这里等于一次覆盖十几个句柄；包在调用点上则是「漏接一个入口即失效」。
 */
export function executeTool(name: string, rawArguments: string, ctx: AgentToolContext): ToolOutcome {
  const handler = HANDLERS[name];
  if (!handler) return reject(`不存在名为 ${name} 的工具。可用工具：${AGENT_TOOLS.map((t) => t.function.name).join(' / ')}`);

  let args: Record<string, unknown>;
  try {
    args = rawArguments.trim() ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
  } catch {
    return reject(`${name} 的参数不是合法 JSON，请重新生成`);
  }

  let outcome: ToolOutcome;
  try {
    outcome = handler(args, ctx);
  } catch (err) {
    // 【写失败要有痕，但不能装成"参数写错了"】两者对模型的下一步完全相反：
    // 参数错该改参数重试，写库坏了重试多少次都一样。所以回喂里明说「别原样重试」，
    // 并要求它在正文里如实告诉用户"这条没记进去"——**静默是最坏的一种**：
    // 用户读到「已经帮你记下了」，档案里什么都没有，而且没有任何地方说过它失败了。
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[chat] 工具 ${name} 落库失败（本轮继续跑完，该条未入库）`, err);
    outcome = reject(
      `${name} 执行失败，这一条**没有写进档案**：${detail}。` +
        '这不是参数问题，原样重试也不会成功——请不要重复调用本工具，' +
        '并在正文里如实告诉用户这一条没能记进档案、让他稍后再说一次。',
    );
  }
  // claim_calc 的拒绝**按轮收口**，不逐次发帧：模型算钱普遍要试两三次（七种算法的必填项
  // 各不相同，回喂一句「缺什么」它下一轮就补上了），逐次发等于把正常的重试过程报成异常。
  // 但原先的写法是**整条通路静默**——重试到最后一次都没算出来，也一个信号都不留，
  // 于是「本轮没算出金额」和「本轮没人要算金额」在事后看起来一模一样。
  // 收口判定见 emitCalcFailureNotice。
  if (name === 'claim_calc') {
    if (outcome.ok) ctx.state.calcSucceeded = true;
    else {
      ctx.state.calcRejects += 1;
      for (const f of missingFieldsFrom(outcome.content)) ctx.state.calcMissingFields.add(f);
    }
  } else if (!outcome.ok) {
    ctx.emit({ event: 'notice', data: { code: 'TOOL_INPUT_REJECTED', message: `${name}：${outcome.content}` } });
  }
  return outcome;
}

/**
 * 本轮编排结束时的算钱收口：**试过但一次都没成**才发一条 notice，重试成功则全程安静。
 *
 * 由 orchestrator 在工具循环与补救轮都跑完之后调一次——必须在补救轮之后，
 * 否则补救轮里算成功的那次会被漏掉，变成误报。
 *
 * code 复用 TOOL_INPUT_REJECTED（词表内既有码，UI 侧本就静默，属内部治理信号），
 * 不新增码：新码要过 manager 送审，而这里要传达的正是「模型的工具入参最终没通过」，
 * 与该码的语义一致，只是把粒度从「每次调用」改成了「每轮」。
 */
export function emitCalcFailureNotice(ctx: AgentToolContext): void {
  if (ctx.state.calcRejects === 0 || ctx.state.calcSucceeded) return;

  // 【失败有痕有两个半边（manager 2026-08-21 记档）】
  // 运维要能查，用户要能懂且知道下一步。只做前者是工程视角的自满——
  // 我们查得到了，而屏幕前那个人只看见一段没有金额的回复，不知道是不该有、
  // 是坏了、还是自己少说了什么。所以这里发**两条**：
  // ① 运维侧：机器可查的收口记录（复用既有码，UI 静默）
  ctx.emit({
    event: 'notice',
    data: {
      code: 'TOOL_INPUT_REJECTED',
      message:
        `claim_calc：本轮 ${ctx.state.calcRejects} 次入参均未通过校验，最终没有算出任何金额，也没有 claims 落库——` +
        '本轮回复里如果出现了金额，它不是计算器算的（charter §3 要求一切金额走 claim_calc）。',
    },
  });
  // ② 用户侧：**给出路不只报错 + 明写怎么再来一次**
  const missing = [...ctx.state.calcMissingFields];
  ctx.emit({
    event: 'notice',
    data: {
      code: 'CALC_FAILED',
      message: missing.length
        ? `这笔金额我暂时算不出来——还差：${missing.join('、')}。你把这几项告诉我，我立刻重算一遍；其他部分不受影响，可以先看。`
        : '这笔金额我暂时算不出来（系统这一轮没能完成计算）。你可以直接说「再算一次」让我重跑；其他部分不受影响，可以先看。',
      ...(missing.length ? { missing_fields: missing } : {}),
      retriable: true,
    },
  });
}
