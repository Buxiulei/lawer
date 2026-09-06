// app/src/lib/agent/calc/index.ts
// 金额计算器的模块出口。MCP 工具 claim_calc 只经这里取函数，不深入子文件。
export {
  CALC_FLAG,
  CALC_VERSION,
  type CalcBasis,
  type CalcFlag,
  type CalcKind,
  type CalcResult,
  type CalcStep,
  type InputSource,
} from './types';

// 日期解析件也从这里转出：claim_calc 的入参校验要在收集阶段先过一遍日期格式，
// 用的必须是算钱那条路自己解析日期的**同一个** parseDate（收集阶段放过的 calc 一定收得下、
// 收集阶段拦下的 calc 一定会抛），否则两把尺一分叉就又出现「一处认另一处不认」。
export { parseDate } from './date';

export {
  MIN_WAGE_FEN_DEFAULT,
  SANBEI_CAP_FEN_DEFAULT,
  calc2N,
  calcN,
  calcNPlus1,
  tenureToMonths,
  type JingjiBuchangInput,
  type JingjiBuchangInputs,
  type NPlus1Input,
  type NPlus1Inputs,
} from './jingji-buchang';

export {
  NIANJIA_MONTHLY_PAY_DAYS,
  annualLeaveDaysFor,
  calcAnnualLeavePay,
  proratedAnnualLeaveDays,
  type AnnualLeaveInput,
  type AnnualLeaveInputs,
  type PriorYearUnused,
  type ProratedLeave,
} from './nianjia';

export {
  SHUANGBEI_MONTHLY_PAY_DAYS_DEFAULT,
  calcDoubleWage,
  type DoubleWageInput,
  type DoubleWageInputs,
  type DoubleWageMonth,
  type DoubleWageResult,
  type DoubleWageScenario,
} from './shuangbei';

export {
  JIABAN_MONTHLY_WORK_DAYS_DEFAULT,
  JIABAN_MONTHLY_WORK_DAYS_LEGACY,
  calcOvertimePay,
  type OvertimeInput,
  type OvertimeInputs,
} from './jiabanfei';

export {
  DAIGANG_LIVING_ALLOWANCE_RATE,
  DAIGANG_MONTHLY_PAY_DAYS_DEFAULT,
  calcStandbyWage,
  type StandbyMonth,
  type StandbyWageInput,
  type StandbyWageInputs,
} from './daigang';

export {
  JIAFU_RATE_HIGH,
  JIAFU_RATE_LOW,
  calcArrearsPenalty,
  type ArrearsCategory,
  type ArrearsItem,
  type ArrearsPenaltyInput,
  type ArrearsPenaltyInputs,
  type ArrearsPenaltyResult,
} from './tuoqian';

export {
  JINGYE_EARLY_RELEASE_MONTHS,
  JINGYE_MAX_MONTHS,
  JINGYE_PENALTY_CAP_MULTIPLE,
  JINGYE_RATE_GUIDELINE,
  JINGYE_RATE_JUDICABLE,
  calcNonCompeteComp,
  type NonCompeteInput,
  type NonCompeteInputs,
  type NonCompeteResult,
} from './jingye';

export {
  BINGJIA_MIN_RATE,
  BINGJIA_MONTHLY_PAY_DAYS_DEFAULT,
  calcSickPay,
  type SickLeaveMonth,
  type SickPayInput,
  type SickPayInputs,
} from './bingjia';

export {
  XBF_PUNITIVE_FLOOR_FEN,
  XBF_PUNITIVE_MULTIPLE,
  calcRefund,
  type PunitiveRisk,
  type RefundClause,
  type RefundInput,
  type RefundInputs,
  type RefundResult,
} from './tuifei';
