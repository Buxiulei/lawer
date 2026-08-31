'use client';

import type { ReactNode } from 'react';
import { useCaseWorkspace } from './CaseWorkspaceProvider';
import { DossierPane } from './DossierPane';
import { ViewerPane } from './ViewerPane';

/**
 * 工作区的**编排层**：桌面与手机的差异全在这里，而且全靠 CSS 容器查询，
 * 一个 JS 分支都没有（阈值与轨道写在 globals.css「桌面工作台」那一段）。
 *
 * 为什么必须是容器查询而不是媒体查询：断点量的是**内容区宽度**，不是视口。
 * 侧栏展开与收起会让同一个 1440 视口分别落在 1152（双栏）和 1336（三栏），
 * 于是 ⌘B 的语义从「收起菜单」变成「腾出第三栏」。媒体查询看不见这件事，
 * 也就做不出那对对照图。
 *
 * 两个 data-* 是这一层唯一的输入：`data-dossier` 表示有没有页面认领卷宗栏，
 * `data-viewer` 表示查看器开没开。**它们跟宽度无关**——宽度归 CSS，
 * 「有没有东西可放」归 React。两件事分开，才不会又出现照视口切树。
 */
export function WorkspaceGrid({ children }: { children: ReactNode }) {
  const { dossierClaimed, viewer } = useCaseWorkspace();

  return (
    <div
      // px-4 / lg:px-6 是**壳层的页面留白**，跟设备走，与容器查询无关；
      // 它挂在这里而不是 AppShell 的 main 上，只为一件事：容器量的是内容盒，
      // 留白留在容器外面会让每一档都少 48px（见 AppShell 那处注释）。
      className="ws-grid px-4 lg:px-6"
      data-dossier={dossierClaimed ? '1' : '0'}
      data-viewer={viewer ? '1' : '0'}
    >
      {/* 主区自己就是一栏，F6 的第一站。tabIndex=-1 只为程序聚焦，不进 Tab 序 */}
      <div data-pane="main" tabIndex={-1} className="ws-main min-w-0">
        {children}
      </div>
      <DossierPane />
      <ViewerPane />
    </div>
  );
}
