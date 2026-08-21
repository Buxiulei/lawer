// app/src/lib/agent/calc/jiabanfei.ts
// 加班费三档（北京口径）。口径唯一来源：knowledge/packs/calc/jiabanfei.md，
// 法条原文见 knowledge/packs/statutes/jgf-2024-534-jieda-1.md 第 57 问。改数字前先改卡片。
//
// 三档倍数（《北京市工资支付规定》第十四条，与《劳动法》第四十四条一致）：
//   · 工作日延时      150%（按小时）
//   · 休息日未补休    200%（安排了同等时间补休的**不付**——入参只给未补休的部分）
//   · 法定休假日      300%（**不得以补休替代**，安排了补休也照付）
//
// 折算分母是这张卡最主要的口径冲突：534 号第 57 问第 5 项写 **21.75 天 / 174 小时**（2024 年
// 北京高院与市仲裁委的现行裁审解答），《北京市工资支付规定》第四十三条写 **20.92 天**（2003 年
// 政府规章）。卡片的结论是：本卡按 21.75 出数，20.92 属**可争取项而非稳拿项**，作为谈判参考。
// 所以本文件缺省 21.75，20.92 由入参覆盖并打 flag——两个数都是有法源的，不能私自二选一。
//
// 与年假的 21.75 不是一回事：年假的分母由《企业职工带薪年休假实施办法》第十一条**写死**，
// 不受本处争议影响（见 nianjia.ts 的 NIANJIA_MONTHLY_PAY_DAYS）。
//
// 不做的事：工时制度的认定（综合计算工时、不定时工作制是否「经批准」）与加班事实的举证
// 都是 agent 层的判断，本文件只按给定的小时/天数出数。

import { yuan } from './format';
import { MIN_WAGE_FEN_DEFAULT } from './jingji-buchang';
import {
  CALC_FLAG,
  CALC_VERSION,
  type CalcBasis,
  type CalcFlag,
  type CalcResult,
  type CalcStep,
  type InputSource,
} from './types';

// ───────────────────────────── 常量 ─────────────────────────────

/**
 * 加班费日工资基数的折算分母：**21.75** 天/月（534 号第 57 问第 5 项，小时为 174）。
 * 与年假的 NIANJIA_MONTHLY_PAY_DAYS 数值相同但法源不同，改一个不等于改另一个。
 */
export const JIABAN_MONTHLY_WORK_DAYS_DEFAULT = 21.75;

/**
 * 旧折算标准：**20.92** 天/月（《北京市工资支付规定》第四十三条）。
 * 分母越小日工资越高，按 20.92 算比按 21.75 多拿——属可争取项，传入本值即按它出数。
 */
export const JIABAN_MONTHLY_WORK_DAYS_LEGACY = 20.92;

/** 日工资折算成小时的除数（工资支付规定第四十三条：小时工资按日工资除以 8 小时）。 */
const HOURS_PER_DAY = 8;

const RATE_WEEKDAY = 1.5;
const RATE_REST_DAY = 2;
const RATE_HOLIDAY = 3;

// ───────────────────────────── 入参与快照 ─────────────────────────────

export interface OvertimeInput {
  /**
   * 加班费计算基数（月，分）。口径按 534 号第 57 问：合同约定优先；约定按最低工资或低于
   * 合同约定工资标准的可被击破；未约定的按实发工资**全部项目**（扣除上月加班费与伙食补助）。
   */
  monthlyBaseFen: number;
  /** 工作日延时加班小时数。 */
  weekdayOvertimeHours?: number;
  /** 休息日加班**未安排补休**的天数。安排了同等时间补休的不计。 */
  restDayDays?: number;
  /** 休息日加班未补休的零星小时数（不足整天的部分）。 */
  restDayHours?: number;
  /** 法定休假日加班天数。安排补休也照付，不得替代。 */
  holidayDays?: number;
  /** 法定休假日加班的零星小时数。 */
  holidayHours?: number;
  /** 覆盖折算天数（缺省 21.75；传 JIABAN_MONTHLY_WORK_DAYS_LEGACY 即按 20.92 出数）。 */
  monthlyWorkDays?: number;
  /** 覆盖最低工资（分）。基数低于此数的按此数计（工资支付规定第四十四条末款）。 */
  minWageFen?: number;
  inputSources?: Record<string, InputSource>;
}

export interface OvertimeInputs {
  monthlyBaseFen: number;
  weekdayOvertimeHours: number;
  restDayDays: number;
  restDayHours: number;
  holidayDays: number;
  holidayHours: number;
  monthlyWorkDays: number;
  minWageFen: number;
}

// ───────────────────────────── 法律依据 ─────────────────────────────

const JIABAN_PACK = 'calc-jiabanfei';
const BJ_GONGZI = '《北京市工资支付规定》';
const JGF534 =
  '京高法发〔2024〕534号《北京市高级人民法院、北京市劳动人事争议仲裁委员会关于审理劳动争议案件解答（一）》';

const JIABAN_BASIS: CalcBasis[] = [
  { law: '《中华人民共和国劳动法》', article: '第四十四条', packId: JIABAN_PACK },
  { law: BJ_GONGZI, article: '第十四条', packId: JIABAN_PACK },
  { law: BJ_GONGZI, article: '第四十三条', packId: JIABAN_PACK },
  { law: BJ_GONGZI, article: '第四十四条', packId: JIABAN_PACK },
  { law: JGF534, article: '第57问', packId: 'statute-jgf-2024-534-jieda-1' },
  {
    law: '《最高人民法院关于审理劳动争议案件适用法律问题的解释（一）》（法释〔2020〕26号）',
    article: '第四十二条',
    packId: JIABAN_PACK,
  },
];

/** 算式里「2天」后面那截零星小时，没有就不出现。 */
const extraHours = (hours: number) => (hours > 0 ? `+${hours}h` : '');

// ───────────────────────────── 主函数 ─────────────────────────────

/**
 * 加班费三档合计。kind 用 '加班费'，与 claims.kind 枚举一致。
 *
 * 每一档各自取整成分后相加：三档是三笔可分别列进请求事项、也会被分别质证的账，
 * 分项之和必须等于总额。
 */
export function calcOvertimePay(input: OvertimeInput): CalcResult<OvertimeInputs> {
  const monthlyWorkDays = input.monthlyWorkDays ?? JIABAN_MONTHLY_WORK_DAYS_DEFAULT;
  const minWageFen = input.minWageFen ?? MIN_WAGE_FEN_DEFAULT;
  const weekdayOvertimeHours = input.weekdayOvertimeHours ?? 0;
  const restDayDays = input.restDayDays ?? 0;
  const restDayHours = input.restDayHours ?? 0;
  const holidayDays = input.holidayDays ?? 0;
  const holidayHours = input.holidayHours ?? 0;

  const flags: CalcFlag[] = [CALC_FLAG.jiabanBaseRule, CALC_FLAG.jiabanDivisorDisputed];
  if (monthlyWorkDays !== JIABAN_MONTHLY_WORK_DAYS_DEFAULT) {
    flags.push(CALC_FLAG.jiabanLegacyDivisor);
  }
  if (input.minWageFen === undefined) flags.push(CALC_FLAG.minWageUnverified);

  const baseFen = Math.max(input.monthlyBaseFen, minWageFen);
  if (input.monthlyBaseFen < minWageFen) flags.push(CALC_FLAG.minWageFloor);
  const dailyFen = baseFen / monthlyWorkDays;
  const hourlyFen = dailyFen / HOURS_PER_DAY;

  const steps: CalcStep[] = [
    {
      id: 'base',
      title: '加班费计算基数与日/小时基数',
      detail:
        `月基数 ${yuan(input.monthlyBaseFen)} 元` +
        (input.monthlyBaseFen < minWageFen
          ? ` < 北京市最低工资 ${yuan(minWageFen)} 元 → 按最低工资计（工资支付规定第四十四条末款）`
          : '') +
        `；日工资基数 = ${yuan(baseFen)} ÷ ${monthlyWorkDays} = ${yuan(dailyFen)} 元，` +
        `小时工资基数 = 日基数 ÷ 8 = ${yuan(hourlyFen)} 元。` +
        `分母 ${monthlyWorkDays} 的出处：${
          monthlyWorkDays === JIABAN_MONTHLY_WORK_DAYS_DEFAULT
            ? '534 号第 57 问第 5 项（21.75 天/174 小时），实务主流'
            : '《北京市工资支付规定》第四十三条（20.92 天），分母更小、日工资更高，属可争取项'
        }。` +
        `基数口径上先把「按什么算」争到位再谈小时数——合同把基数压到最低工资的，` +
        `依 534 号第 57 问第 1 项可按劳动合同约定的工资标准主张。`,
      valueFen: Math.round(dailyFen),
    },
  ];

  // 三档分别成账。
  const weekdayFen = Math.round(hourlyFen * weekdayOvertimeHours * RATE_WEEKDAY);
  const restDayFen = Math.round(
    (dailyFen * restDayDays + hourlyFen * restDayHours) * RATE_REST_DAY,
  );
  const holidayFen = Math.round((dailyFen * holidayDays + hourlyFen * holidayHours) * RATE_HOLIDAY);

  steps.push({
    id: 'weekday',
    title: '工作日延时加班 150%',
    detail:
      `${yuan(hourlyFen)} × ${weekdayOvertimeHours} 小时 × 150% = ${yuan(weekdayFen)} 元` +
      `（工资支付规定第十四条第一项）。`,
    valueFen: weekdayFen,
  });

  steps.push({
    id: 'rest-day',
    title: '休息日加班未补休 200%',
    detail:
      `${yuan(dailyFen)} × ${restDayDays} 天` +
      (restDayHours > 0 ? ` + ${yuan(hourlyFen)} × ${restDayHours} 小时` : '') +
      ` × 200% = ${yuan(restDayFen)} 元（工资支付规定第十四条第二项）。` +
      `公司安排了同等时间补休的那部分不付 200%，故此处只填未补休的天/小时数。`,
    valueFen: restDayFen,
  });

  if (holidayDays > 0 || holidayHours > 0) flags.push(CALC_FLAG.jiabanHolidayNoSwap);
  steps.push({
    id: 'holiday',
    title: '法定休假日加班 300%',
    detail:
      `${yuan(dailyFen)} × ${holidayDays} 天` +
      (holidayHours > 0 ? ` + ${yuan(hourlyFen)} × ${holidayHours} 小时` : '') +
      ` × 300% = ${yuan(holidayFen)} 元（工资支付规定第十四条第三项）。` +
      `法定休假日加班**不能以补休替代**，公司安排了补休也照付。`,
    valueFen: holidayFen,
  });

  const amountFen = weekdayFen + restDayFen + holidayFen;
  steps.push({
    id: 'amount',
    title: '三档合计',
    detail:
      `${yuan(weekdayFen)} + ${yuan(restDayFen)} + ${yuan(holidayFen)} = ${yuan(amountFen)} 元。` +
      `加班事实由劳动者举证（法释〔2020〕26号第四十二条），但考勤、加班审批记录由公司掌握的，` +
      `公司不提供须承担不利后果——离职前先把打卡记录、审批邮件导出。`,
    valueFen: amountFen,
  });

  const inputs: OvertimeInputs = Object.freeze({
    monthlyBaseFen: input.monthlyBaseFen,
    weekdayOvertimeHours,
    restDayDays,
    restDayHours,
    holidayDays,
    holidayHours,
    monthlyWorkDays,
    minWageFen,
  });

  return {
    kind: '加班费',
    amountFen,
    formula:
      `延时 ${yuan(hourlyFen)}×${weekdayOvertimeHours}h×150% + ` +
      `休息日 ${yuan(dailyFen)}×${restDayDays}天${extraHours(restDayHours)}×200% + ` +
      `法定节假日 ${yuan(dailyFen)}×${holidayDays}天${extraHours(holidayHours)}×300% ` +
      `= ${yuan(amountFen)} 元（日基数按 ${monthlyWorkDays} 折算）`,
    inputs,
    steps,
    flags,
    basis: JIABAN_BASIS,
    inputSources: input.inputSources,
    calcVersion: CALC_VERSION,
  };
}
