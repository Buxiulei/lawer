// app/src/lib/cases/claims.ts
// 诉求金额的计算与落库。**站内 agent 与用户自己的 agent（MCP）共用这一份**。
//
// 【为什么必须是同一份】金额是这个产品里唯一会被对方当庭复算的数字。它此前只长在
// lib/agent/tools.ts 里，于是 MCP 那条路要么没有算钱能力，要么照着抄第二份——
// 抄出来的第二份不会在同一天出错，它会在某次公式修订之后**只改了一处**，
// 而两处都返回 200、格式完全正常，用户在网页里看到的数和自己 agent 算出来的数不一样，
// 且没有任何一处报错。所以搬到这里：两条入口 import 同一个符号，改一处两处都变。
//
// 【与 lib/agent 的关系】本文件引 `lib/agent/calc`（纯函数）、`events` 与 `retrieval`
// 的**类型**——这三个模块自身零依赖，不会把编排层拖进来，也不构成回环。
// 反过来 lib/agent/tools.ts 引本文件，claim_calc 那条句柄现在只剩一层壳。
import type { Database } from 'better-sqlite3';

import * as calc from '@/lib/agent/calc';
import type { InputSource } from '@/lib/agent/calc';
import type { AgentEventSink } from '@/lib/agent/events';
import type { KnowledgeSearcher } from '@/lib/agent/retrieval';
import {
  isSanbeiCapVerified,
  readCardValueFen,
  readSanbeiCap,
  SANBEI_CAP_PACK_ID,
  SANBEI_CAP_UNVERIFIED_CAVEAT,
  sanbeiCapFacts,
} from '@/lib/cap/sanbei';
import * as store from '@/lib/db/agent';

/** claim_calc 目前实装的公式（lib/agent/calc）。年假/加班费/双倍工资等后批再加，
 *  加进来之前不列进 enum——列了模型就会调，然后拿到一个「不支持」的错误。 */
export const CALC_KINDS = ['N', 'N+1', '2N', '年假', '双倍工资', '加班费', '待岗', '加付赔偿金', '竞业补偿', '病假工资'] as const;

/** 最低工资数据卡：年假折算、双倍工资、加班费、待岗四个公式都要用它兜底下限 */
export const MIN_WAGE_PACK_ID = 'data-beijing-zuidi-gongzi';
export const MIN_WAGE_VALUE_KEY = 'min_wage_monthly';
/** 待岗生活费标准（同一张卡） */
export const DAIGANG_ALLOWANCE_VALUE_KEY = 'daigang_shenghuofei_monthly';

/**
 * 算一笔钱需要的外部东西。**故意比 AgentToolContext 窄**：只要 db、案件号、
 * 取卡的检索器和一个可选的事件出口。MCP 那条路没有 SSE 通道，`emit` 省略即可；
 * 站内 agent 直接把它的 ctx 传进来（结构上是本接口的超集）。
 */
export interface ClaimCalcEnv {
  db: Database;
  /** 服务端注入，**不来自模型参数**：算出来的钱无从落到别人的案子上 */
  caseId: number;
  /** 取不到卡时公式走内置缺省并如实发 notice，不静默 */
  searcher?: KnowledgeSearcher;
  emit?: AgentEventSink;
}

/**
 * 一次计算的结果。**不是 ToolOutcome**：ToolOutcome 是「回喂给模型的那段字符串」，
 * 属编排层的表达形式；这里回结构化的成功/失败，由两条入口各自渲染
 *（站内 agent 包成 ok()/reject()，MCP 包成 tools/call 的 content / isError）。
 */
export type ClaimCalcResult =
  | { ok: true; payload: Record<string, unknown>; claimId: number; created: boolean }
  | { ok: false; error: string };

function reject(message: string): ClaimCalcResult {
  return { ok: false, error: message };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function inEnum(v: unknown, allowed: readonly string[]): string | null {
  const s = str(v);
  return s && allowed.includes(s) ? s : null;
}

/**
 * 四个非解除补偿类算法的分派：未休年假 / 未签合同双倍工资 / 加班费 / 待岗工资。
 *
 * 返回 null 表示「这个 kind 不归我管」，交回给 N/N+1/2N 那条路。
 *
 * 【为什么必填项在代码里校验而不写进 schema】七种算法的必填项互不相同，schema 只能写
 * 一个七选一的 oneOf——模型对组合约束的遵守率远不如对错误原文的反应。缺什么就回一句
 * 人话告诉它缺什么，它下一轮就补上了。
 */
export function calcNonSeverance(
  kind: string,
  args: Record<string, unknown>,
  env: {
    sourceOf: (field: string) => InputSource;
    minWageOpt: { minWageFen?: number };
    ctx: ClaimCalcEnv;
  },
): ClaimCalcResult | null {
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
  ctx: ClaimCalcEnv,
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

export function persistCalc(
  kind: string,
  result: calc.CalcResult<object>,
  inputSources: Record<string, InputSource>,
  ctx: ClaimCalcEnv,
  extraNote?: string | null,
): ClaimCalcResult {
  const claim = store.upsertClaim(ctx.db, {
    caseId: ctx.caseId,
    kind,
    amountFen: result.amountFen,
    calcJson: JSON.stringify(result),
    basis: result.basis.map((b) => `${b.law}${b.article}`).join('；'),
    status: 'draft',
  });
  ctx.emit?.({
    event: 'record',
    data: { tool: 'claims_upsert', id: claim.id, summary: `${kind}：${(result.amountFen / 100).toFixed(2)} 元` },
  });
  return {
    ok: true,
    claimId: claim.id,
    created: claim.created,
    payload: {
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
    },
  };
}

/**
 * claim_calc 的全部逻辑：选算法 → 现取卡值 → 算 → 落库回报。
 *
 * 【为什么整段在这里而不在句柄里】站内 agent 与 MCP 两条入口都要算钱，而这段里
 * 有三处「取不到卡就降级并如实告知」的判断（最低工资、三倍封顶、封顶待核实）。
 * 留在句柄里的形态是：MCP 那条路照抄一份，某次卡 id 改名只改了一处，
 * 于是一条路按新卡算、另一条路悄悄用着内置缺省值，两边都返回 200。
 */
export function runClaimCalc(args: Record<string, unknown>, ctx: ClaimCalcEnv): ClaimCalcResult {
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
    ctx.emit?.({
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
    ctx.emit?.({
      event: 'notice',
      data: {
        code: 'KNOWLEDGE_MISS',
        message: `三倍封顶基数取自数据卡当前值，但该值可信度为「${cap.confidence}」——引用金额时须一并告知用户。`,
      },
    });
  }
  if (sanbeiCapFen === null) {
    ctx.emit?.({
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
}

/**
 * 案件下的全部诉求项 + 合计。**合计在服务端算**：让调用方（模型）自己把十条金额加起来，
 * 加错一位没有任何东西拦得住，而这个总数正是用户拿去跟对方谈的那个数。
 *
 * 归属校验不在这里——调用方先过 lib/cases 的门（见各能力壳），本函数只按 caseId 取数。
 */
export function listClaimsWithTotal(
  db: Database,
  caseId: number,
): { claims: store.ClaimRow[]; total_fen: number; total_yuan: string } {
  const claims = store.listClaims(db, caseId);
  const total = claims.reduce((sum, c) => sum + c.amount_fen, 0);
  return { claims, total_fen: total, total_yuan: (total / 100).toFixed(2) };
}
