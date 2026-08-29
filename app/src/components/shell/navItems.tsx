import type { ReactNode } from 'react';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';

export interface NavItem {
  key: string;
  label: string;
  /**
   * 低调模式下顶替 label 的中性词。不给就说明这个栏目名本来就中性
   * （「我的」），两种模式下写法一致。
   */
  discreetLabel?: string;
  /** 相对当前案件的路径构造 */
  href: (caseId: string) => string;
  /** 命中判定：pathname 是否属于该 tab */
  match: (pathname: string, caseId: string) => boolean;
  icon: ReactNode;
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
    href: (id) => `/case/${id}`,
    match: (p, id) => p === `/case/${id}` || p === '/intake',
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
    href: (id) => `/case/${id}/ask`,
    match: (p, id) => p.startsWith(`/case/${id}/ask`),
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
    href: (id) => `/case/${id}/evidence`,
    match: (p, id) => p.startsWith(`/case/${id}/evidence`),
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
    href: (id) => `/case/${id}/drafts`,
    match: (p, id) => p.startsWith(`/case/${id}/drafts`) || p.startsWith(`/case/${id}/docs`),
    icon: (
      <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
        <path d="M6 3.5h7.5L18 8v12.5H6z" />
        <path d="M13.5 3.5V8H18M9 12h6M9 15.5h4" />
      </svg>
    ),
  },
];

/**
 * 「我的」不进底部 Tab——四格被案件四栏占满了。
 * 移动端它在顶栏，PC 侧栏里仍然跟在四栏后面。位置变了，可达性没变。
 */
export const ACCOUNT_NAV_ITEM: NavItem = {
  key: 'account',
  label: '我的',
  href: () => '/account',
  match: (p) => p.startsWith('/account') || p.startsWith('/settings'),
  icon: (
    <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
    </svg>
  ),
};

/** PC 侧栏用：案件四栏 + 我的 */
export const NAV_ITEMS: NavItem[] = [...CASE_NAV_ITEMS, ACCOUNT_NAV_ITEM];
