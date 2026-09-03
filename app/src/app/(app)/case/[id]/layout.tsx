import type { ReactNode } from 'react';
import { SessionGate } from '@/app/_ui/session';
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
 *
 * 【登录态失效的闸门也挂在这儿（F-202）】它必须在 layout 上：驾驶舱、问它、证据、
 * 文书、公司档案、关系图六个子页各有各的取数与各自的「重试」，而 401 的出路只有一条。
 * 挂一次，六个子页里一行 401 分支都不用有——也就没有"下一处忘了写"的地方。
 * 闸门本体见 _ui/session，结构守卫见 _ui/__tests__/session-single-entry.test.tsx。
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
      <WorkspaceGrid>
        <SessionGate next={`/case/${id}`}>{children}</SessionGate>
      </WorkspaceGrid>
    </CaseWorkspaceProvider>
  );
}
