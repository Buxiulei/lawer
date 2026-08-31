import type { ReactNode } from 'react';
import { CaseWorkspaceProvider } from './_workspace/CaseWorkspaceProvider';
import { WorkspaceGrid } from './_workspace/WorkspaceGrid';

/**
 * 一个案件 = 一个工作区。
 *
 * 放在 layout 而不是 page：Next 在同一个 layout 下切 page 时不重建 layout，
 * 于是工作区的状态、卷宗栏与查看器的 DOM 宿主跨 /case/[id] 与 /case/[id]/ask
 * 一直活着。两个 page 只决定主区里放什么。
 *
 * （余下一半：主区内容本身仍随 page 换，跨这两条路由时 Workbench 还是会重建。
 *   把两个 page 的内容也提上来是 Workbench 那一刀的事，见 docs 里批 6 的分工。）
 */
export default async function CaseLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <CaseWorkspaceProvider caseId={id}>
      <WorkspaceGrid>{children}</WorkspaceGrid>
    </CaseWorkspaceProvider>
  );
}
