/* ── 壳层图标：中性几何，不用法槌天平 ─────────────────────────
   原先长在 AppShell.tsx 里，侧栏和顶栏都要用，抽出来共用一份。 */

export function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5.5" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M4 4l16 16" />
      <path d="M9.6 9.7A3 3 0 0014.3 14M6.3 6.9C4 8.6 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.5 4.3-1.1M19 15.4c1.6-1.6 2.5-3.4 2.5-3.4S18 5.5 12 5.5c-.7 0-1.4.1-2 .3" strokeLinejoin="round" />
    </svg>
  );
}

export function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
    </svg>
  );
}

export function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M20 14.2A8.2 8.2 0 019.8 4 8.5 8.5 0 1020 14.2z" />
    </svg>
  );
}

export function AutoIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5.5" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 010 17z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 顶栏「案件档案」按钮：一个对折的档案夹 */
export function FolderIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.5 7.5a2 2 0 012-2h3.3l1.7 2h8a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />
    </svg>
  );
}
