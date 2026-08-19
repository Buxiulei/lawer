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
