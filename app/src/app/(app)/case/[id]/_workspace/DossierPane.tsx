'use client';

import { useCaseWorkspace } from './CaseWorkspaceProvider';

/**
 * 卷宗栏（呈现层）。**一点状态、一个请求都不持有**——它只是一块带无障碍名字、
 * 能被 F6 聚焦的地皮，内容由页面 `useDossierPortal` 投送进来。
 *
 * 这么切是为了让它可弃：第三栏若被自证死刑判据（查看器打开率 <15%）判掉，
 * 删掉这个文件不会带走任何业务逻辑。
 *
 * 自闭合是有讲究的：JSX 里写成 `<aside></aside>` 之间只要有一个换行，
 * DOM 里就多一个空白文本节点。现在不靠 :empty 判断，但别给后面的人埋这个雷。
 */
export function DossierPane() {
  const { setDossierHost } = useCaseWorkspace();
  return (
    <aside
      ref={setDossierHost}
      data-pane="dossier"
      tabIndex={-1}
      aria-label="卷宗栏"
      className="ws-pane ws-dossier"
    />
  );
}
