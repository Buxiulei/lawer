/**
 * shadcn 组件要用的几个图标。刻意不引 lucide/tabler：
 * 全站图标一直是手写内联 SVG（中性几何，不用法槌天平），
 * 为这几个形状拖一整个图标库进来不划算。
 */
const stroke = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function XIcon({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke}>
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

export function CheckIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke} strokeWidth={2.4}>
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

export function ChevronRightIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke}>
      <path d="M7.5 4.5l5 5.5-5 5.5" />
    </svg>
  );
}

export function ChevronDownIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke}>
      <path d="M4.5 7.5l5.5 5 5.5-5" />
    </svg>
  );
}

/** 侧栏折叠：一个面板 + 一条竖线 */
export function PanelLeftIcon({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden {...stroke}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </svg>
  );
}
