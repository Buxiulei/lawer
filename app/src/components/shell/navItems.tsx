import type { ReactNode } from 'react';
import { CASE_RESOLVER_PATH } from '@/app/_ui/bootstrap';
import { BYO, BYO_GUIDE_HREF } from '@/app/_ui/byoAgent';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';

export interface NavItem {
  key: string;
  label: string;
  /**
   * 低调模式下顶替 label 的中性词。不给就说明这个栏目名本来就中性
   * （「我的」），两种模式下写法一致。
   */
  discreetLabel?: string;
  /** 相对当前案件的路径构造。caseId 为 null = 还不知道是哪个案件 */
  href: (caseId: string | null) => string;
  /** 命中判定：pathname 是否属于该 tab */
  match: (pathname: string, caseId: string | null) => boolean;
  icon: ReactNode;
}

/**
 * 案件四栏共用的路径构造。**不知道是哪个案件时去解析页，不兜底成某个具体案件。**
 *
 * 这里曾经的兜底值是 'demo'（写在 AppShell 的 caseIdFrom 里），于是登录用户
 * 站在「我的」「设置」「首诊」任何一页上，点四栏中的任何一栏都进演示案件。
 * caseId 的类型带上 null 就是为了让下一个人没法再"随手给个默认值"糊过去。
 */
export function caseHref(caseId: string | null, suffix = ''): string {
  return caseId === null ? CASE_RESOLVER_PATH : `/case/${caseId}${suffix}`;
}

const stroke = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/**
 * 案件四栏：驾驶舱 / 问它 / 证据 / 文书。
 * 这四个是底部 Tab 的全部内容——产品方案定的四位，不多不少。
 */
export const CASE_NAV_ITEMS: NavItem[] = [
  {
    key: 'dashboard',
    label: '驾驶舱',
    discreetLabel: NEUTRAL_WORD.dashboard,
    href: (id) => caseHref(id),
    // 首诊页归驾驶舱这一栏，与是哪个案件无关，所以 id 为 null 时它照样命中
    match: (p, id) => (id !== null && p === `/case/${id}`) || p === '/intake',
    icon: (
      // 仪表盘：一道弧 + 一根指针。列表三横线让给了「问它」那边的语义
      <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
        <path d="M3.8 17.6a8.5 8.5 0 1 1 16.4 0" />
        <path d="M12 17.6l4.1-5.2" />
      </svg>
    ),
  },
  {
    key: 'ask',
    label: '问它',
    discreetLabel: NEUTRAL_WORD.ask,
    href: (id) => caseHref(id, '/ask'),
    match: (p, id) => id !== null && p.startsWith(`/case/${id}/ask`),
    icon: (
      <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
        <path d="M20 12.2c0 3.7-3.6 6.7-8 6.7-.9 0-1.8-.1-2.6-.4L5 20l1.1-3A6.3 6.3 0 0 1 4 12.2c0-3.7 3.6-6.7 8-6.7s8 3 8 6.7z" />
        <path d="M10.3 10.4a1.8 1.8 0 1 1 2.2 1.8v.9" />
      </svg>
    ),
  },
  {
    key: 'evidence',
    label: '证据',
    discreetLabel: NEUTRAL_WORD.evidence,
    href: (id) => caseHref(id, '/evidence'),
    match: (p, id) => id !== null && p.startsWith(`/case/${id}/evidence`),
    icon: (
      <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
        <path d="M12 3.5l7 3v5.2c0 4-2.9 7.5-7 8.8-4.1-1.3-7-4.8-7-8.8V6.5z" />
        <path d="M9.2 12.2l2 2 3.6-3.9" />
      </svg>
    ),
  },
  {
    key: 'drafts',
    label: '文书',
    discreetLabel: NEUTRAL_WORD.drafts,
    href: (id) => caseHref(id, '/drafts'),
    match: (p, id) =>
      id !== null && (p.startsWith(`/case/${id}/drafts`) || p.startsWith(`/case/${id}/docs`)),
    icon: (
      <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
        <path d="M6 3.5h7.5L18 8v12.5H6z" />
        <path d="M13.5 3.5V8H18M9 12h6M9 15.5h4" />
      </svg>
    ),
  },
];

/**
 * 「接自己的 agent」独立一栏。产品负责人 2026-09-03 明示这是核心能力，
 * 要「放在最左侧的栏目里，单独一栏」——所以它**不塞进「我的」**，
 * 也不排到四栏末尾，而是紧跟驾驶舱、排在问它之前。
 *
 * 【不进底部 Tab】移动端四格是案件四栏，满了；那边的入口在「我的」页顶部（既有）。
 * 位置不同，可达性没变——同 ACCOUNT_NAV_ITEM 的处理。
 *
 * 【文案不写在这里】label / discreetLabel 都取自 _ui/byoAgent 的 BYO，
 * 与首页、驾驶舱、账户页共用同一个入口。壳层手写字面量的那天，
 * 改口径的人改了 byoAgent 就以为改完了，而侧栏还念着老词。
 */
export const AGENT_NAV_ITEM: NavItem = {
  key: 'agent',
  label: BYO.navLabel,
  discreetLabel: BYO.navLabelNeutral,
  href: () => BYO_GUIDE_HREF,
  match: (p) => p === BYO_GUIDE_HREF || p.startsWith(`${BYO_GUIDE_HREF}/`),
  icon: (
    // 插头：两根引脚 + 插体 + 一段线。说的是"把外面的东西接进来"，
    // 与「我的」那个人像、四栏那批案件语义都不撞。
    <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
      <path d="M9 3.5v4M15 3.5v4" />
      <path d="M6.5 7.5h11v3.2a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 16.2v4.3" />
    </svg>
  ),
};

/**
 * 「我的」不进底部 Tab——四格被案件四栏占满了。
 * 移动端它在顶栏，PC 侧栏里仍然跟在四栏后面。位置变了，可达性没变。
 */
export const ACCOUNT_NAV_ITEM: NavItem = {
  key: 'account',
  label: '我的',
  href: () => '/account',
  // /settings 整棵子树归「我的」，**除了**已经自成一栏的接入页——
  // 不减掉它，站在 /settings/agent 上两栏会同时高亮，等于告诉用户"你在两个地方"。
  match: (p) =>
    p.startsWith('/account') || (p.startsWith('/settings') && !AGENT_NAV_ITEM.match(p, null)),
  icon: (
    <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
    </svg>
  ),
};

const [DASHBOARD_NAV_ITEM, ...CASE_NAV_ITEMS_AFTER_DASHBOARD] = CASE_NAV_ITEMS;

/**
 * PC 侧栏用：驾驶舱 → 接入 → 问它 / 证据 / 文书 → 我的。
 * 接入那一栏插在驾驶舱之后，是「核心功能前置」这条产品裁决的落点，不是排版口味。
 */
export const NAV_ITEMS: NavItem[] = [
  DASHBOARD_NAV_ITEM,
  AGENT_NAV_ITEM,
  ...CASE_NAV_ITEMS_AFTER_DASHBOARD,
  ACCOUNT_NAV_ITEM,
];
