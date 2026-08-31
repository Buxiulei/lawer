'use client';

import { XIcon } from '@/components/shadcn/icons';
import { useCaseWorkspace } from './CaseWorkspaceProvider';

/**
 * 查看器（呈现层）。跟引用走：点一条引用，这里开出原件。
 * 同 DossierPane，**不持有任何业务 state**：标题来自工作区状态，正文由
 * `useViewerPortal` 投送。开的动作（引用桥）在 B 路。
 *
 * 关的路径有两条且都在这里之外：右上角这个按钮调 closeViewer，
 * Esc 走 _ui/hotkeys 的层序（查看器 → 抽屉 → 无）。
 */
export function ViewerPane() {
  const { setViewerHost, viewer, closeViewer } = useCaseWorkspace();
  return (
    <aside
      data-pane="viewer"
      tabIndex={-1}
      aria-label="原件查看器"
      className="ws-pane ws-viewer"
    >
      <div className="flex h-11 items-center justify-between gap-2 border-b border-line">
        <h2 className="fs-s truncate font-semibold text-ink">{viewer?.title ?? ''}</h2>
        <button
          type="button"
          onClick={closeViewer}
          aria-label="关闭查看器"
          className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-[10px] text-ink-2 transition-colors duration-150 ease-out hover:bg-surface-2"
        >
          <XIcon />
        </button>
      </div>
      <div ref={setViewerHost} className="pt-3" />
    </aside>
  );
}
