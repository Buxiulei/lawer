// app/src/lib/agent/calc/date.ts
// 计算器共用的日期件（第一批 jingji-buchang.ts 原地抽出，两批公式共用，行为零变化）。
//
// 铁律：日期串一律经 db/time 的 fromSql 按 UTC 解析（ADR-002），禁止裸 new Date(串)。
// 理由见 parseDate 上的注释——差一天就可能让工龄掉一档、让二倍工资的窗口少一个月。

import { fromSql, toSql } from '@/lib/db/time';

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

/**
 * 收 'YYYY-MM-DD'、canonical 'YYYY-MM-DD HH:MM:SS'、ISO 'YYYY-MM-DDTHH:MM:SS(.mmm)?Z'。
 * 显式数字时区偏移（'+08:00'）不收：归一成 canonical 后按 UTC 解析会把它悄悄当成 UTC，
 * 宁可报错也不要给出差一天的工龄。
 */
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?)?$/;

/** 'YYYY-MM'。逐月工资明细、逐月实发这类按自然月给的入参用它。 */
const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function daysInMonth(year: number, month1to12: number): number {
  // Date.UTC 的 day=0 取上个月最后一天，month 传 1-based 即为本月天数。
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function parseDate(value: string, field: string): Ymd {
  const matched = DATE_RE.exec(value);
  if (!matched) {
    throw new Error(`${field} 不是合法日期串（需 YYYY-MM-DD 或 canonical/ISO 时间串）：${value}`);
  }
  // 一律先归一成 canonical 串、再交给 fromSql 按 UTC 解析（ADR-002），不分情况自己 new Date：
  // 裸 new Date('YYYY-MM-DD HH:MM:SS') 按**本地时区**解析，UTC+8 机器上 '2020-07-01 00:00:00'
  // 会落到 06-30——工龄恰好卡在六个月档时直接掉一档，N 少算半个月。
  const at = fromSql(`${matched[1]} ${matched[2] ?? '00:00:00'}`);
  // 非法月份得 Invalid Date；2 月 30 日这种则会滚到下个月，靠回写比对才抓得住。
  if (Number.isNaN(at.getTime()) || toSql(at).slice(0, 10) !== matched[1]) {
    throw new Error(`${field} 不是真实存在的日期：${value}`);
  }
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() };
}

/** 解析 'YYYY-MM'，返回该月 1 日。月份非 01-12 抛错。 */
export function parseMonth(value: string, field: string): Ymd {
  const matched = MONTH_RE.exec(value);
  if (!matched) {
    throw new Error(`${field} 不是合法月份串（需 YYYY-MM）：${value}`);
  }
  const m = Number(matched[2]);
  if (m < 1 || m > 12) throw new Error(`${field} 不是真实存在的月份：${value}`);
  return { y: Number(matched[1]), m, d: 1 };
}

export const asOrdinal = (p: Ymd) => p.y * 10000 + p.m * 100 + p.d;
export const asUtcMs = (p: Ymd) => Date.UTC(p.y, p.m - 1, p.d);

/** 加 n 个自然月，日超出目标月长度时截到月末（1-31 加一个月 = 2-28/29）。 */
export function addMonths(p: Ymd, n: number): Ymd {
  const total = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { y, m, d: Math.min(p.d, daysInMonth(y, m)) };
}

/** 加 n 个自然日。按 UTC 毫秒推进，不受本机时区与夏令时影响。 */
export function addDays(p: Ymd, n: number): Ymd {
  const at = new Date(asUtcMs(p) + n * 86_400_000);
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() };
}

/** 闭区间天数：同一天为 1 天，from 晚于 to 时为 0。年假折算的「已过日历天数」用它。 */
export function daysBetweenInclusive(from: Ymd, to: Ymd): number {
  const diff = (asUtcMs(to) - asUtcMs(from)) / 86_400_000;
  return diff < 0 ? 0 : diff + 1;
}

export const monthStart = (p: Ymd): Ymd => ({ y: p.y, m: p.m, d: 1 });
export const monthEnd = (p: Ymd): Ymd => ({ y: p.y, m: p.m, d: daysInMonth(p.y, p.m) });

export const ymdText = (p: Ymd) =>
  `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
export const monthText = (p: Ymd) => `${p.y}-${String(p.m).padStart(2, '0')}`;
