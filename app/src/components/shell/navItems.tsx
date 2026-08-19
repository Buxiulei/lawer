import type { ReactNode } from 'react';

export interface NavItem {
  key: string;
  label: string;
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

export const NAV_ITEMS: NavItem[] = [
  {
    key: 'workbench',
    label: '工作台',
    href: (id) => `/case/${id}`,
    match: (p, id) => p === `/case/${id}` || p === '/intake',
    icon: (
      <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
        <path d="M4 7.5h16M4 12h11M4 16.5h7" />
      </svg>
    ),
  },
  {
    key: 'evidence',
    label: '证据',
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
    href: (id) => `/case/${id}/drafts`,
    match: (p, id) => p.startsWith(`/case/${id}/drafts`) || p.startsWith(`/case/${id}/docs`),
    icon: (
      <svg viewBox="0 0 24 24" className="size-6" {...stroke}>
        <path d="M6 3.5h7.5L18 8v12.5H6z" />
        <path d="M13.5 3.5V8H18M9 12h6M9 15.5h4" />
      </svg>
    ),
  },
  {
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
  },
];
