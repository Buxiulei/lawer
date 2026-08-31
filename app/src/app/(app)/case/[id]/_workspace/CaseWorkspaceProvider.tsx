'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { hasOpenModal, useHotkeys } from '@/app/_ui/hotkeys';

/**
 * 工作区的**状态层**：一个案件一棵树，桌面与手机零差异。
 *
 * 分野实现的三层里，这是「没有差异」的那一层——手机和桌面跑的是同一份状态，
 * 差异全部推到编排层（WorkspaceGrid 的容器查询）。这么切的理由是批 1 那个坑：
 * tab 是路由跳转会卸载 Workbench，正在生成的 SSE 回答当场没了。状态挂在这里、
 * 编排只改 CSS，宽度怎么变都不会重建那棵树。
 *
 * 红线：
 *  ① **视口判定不进 render**。本文件不许出现 matchMedia / innerWidth / useMediaQuery——
 *    照视口切树等于把上面那个坑换个地方复现（拖窗口跨断点时 SSE 当场断）。
 *    需要读几何的地方（F6 找可见栏）只在事件回调里读。
 *  ② 全站只允许一个实例。「两棵树都渲染、CSS 藏一棵」是这类布局最常见的糊弄法，
 *    它在截图上完全正确，代价是所有请求跑两遍、SSE 开两条。下面有守卫盯着。
 */

export interface ViewerState {
  /** 查看器标题（原件名 / 法条号）。正文由 B 路经 viewerHost 投送。 */
  title: string;
}

interface CaseWorkspaceValue {
  caseId: string;
  /** 卷宗栏 / 查看器的 DOM 宿主，页面用 portal 往里投送内容 */
  dossierHost: HTMLElement | null;
  viewerHost: HTMLElement | null;
  setDossierHost: (el: HTMLElement | null) => void;
  setViewerHost: (el: HTMLElement | null) => void;
  /** 有页面认领了卷宗栏（认领与「这一档宽度显不显示」无关，后者是 CSS 的事） */
  dossierClaimed: boolean;
  claimDossier: () => () => void;
  viewer: ViewerState | null;
  openViewer: (viewer: ViewerState) => void;
  closeViewer: () => void;
}

const Ctx = createContext<CaseWorkspaceValue | null>(null);

export function useCaseWorkspace(): CaseWorkspaceValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      'useCaseWorkspace 必须在 CaseWorkspaceProvider 内使用。' +
        '缺它是因为这棵树不在 case/[id]/layout.tsx 之下——' +
        '把用到工作区的组件挪进 /case/[id] 路由，或者在这里补一个 Provider。',
    );
  }
  return ctx;
}

/** 壳层这类「有就用、没有也得活」的地方用它。 */
export function useOptionalCaseWorkspace(): CaseWorkspaceValue | null {
  return useContext(Ctx);
}

export function CaseWorkspaceProvider({
  caseId,
  children,
}: {
  caseId: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dossierHost, setDossierHost] = useState<HTMLElement | null>(null);
  const [viewerHost, setViewerHost] = useState<HTMLElement | null>(null);
  const [dossierClaims, setDossierClaims] = useState(0);
  const [viewer, setViewer] = useState<ViewerState | null>(null);

  const claimDossier = useCallback(() => {
    setDossierClaims((n) => n + 1);
    return () => setDossierClaims((n) => n - 1);
  }, []);

  const openViewer = useCallback((next: ViewerState) => setViewer(next), []);
  const closeViewer = useCallback(() => setViewer(null), []);

  // ── 单实例守卫 ────────────────────────────────────────────
  // 数的是 DOM 而不是 React 实例：要防的正是「两棵树都渲染、CSS 藏一棵」，
  // 那种写法在 React 层面也确实是两个实例，但真正能看见的证据在 DOM 上。
  useEffect(() => {
    const n = document.querySelectorAll('[data-workspace]').length;
    if (n <= 1) return;
    console.error(
      `[工作区] 页面上有 ${n} 个工作区实例，应当只有 1 个。\n` +
        '为什么要拦：两棵树都会各自发请求、各开一条 SSE，屏幕上却只看得见一棵，' +
        '账单和上下文都会翻倍，而截图完全正常。\n' +
        '怎么办：工作区只许挂在 case/[id]/layout.tsx，别在 page 里再包一层；' +
        '要按宽度分栏请用容器查询，不要渲染两棵再用 CSS 藏一棵。',
    );
  }, []);

  // ── F6 / Esc ───────────────────────────────────────────────
  const step = useCallback((delta: number): boolean => {
    const root = rootRef.current;
    if (!root) return false;
    // 只在事件回调里读几何，不进 render（红线①）
    const panes = [...root.querySelectorAll<HTMLElement>('[data-pane]')].filter(
      (p) => p.getClientRects().length > 0,
    );
    if (panes.length < 2) return false;
    const active = document.activeElement;
    const here = panes.findIndex(
      (p) => p === active || (active instanceof Node && p.contains(active)),
    );
    const next = here + delta;
    // 走出末端**不接管**：F6 的平台惯例是把焦点交还给浏览器界面，
    // 无条件 preventDefault 会把这条惯例吃掉，键盘用户从此出不去页面。
    if (next < 0 || next >= panes.length) return false;
    panes[next].focus();
    return true;
  }, []);

  useHotkeys(
    useMemo(
      () => ({
        f6: () => step(1),
        'shift+f6': () => step(-1),
        escape: () => {
          // 层序：查看器 → 抽屉 → 无。抽屉是 Radix 模态，它自己会吃这一下，
          // 我们要做的只是别抢在它前面。
          if (hasOpenModal()) return false;
          if (!viewer) return false;
          closeViewer();
          return true;
        },
      }),
      [step, viewer, closeViewer],
    ),
    20,
  );

  const value = useMemo<CaseWorkspaceValue>(
    () => ({
      caseId,
      dossierHost,
      viewerHost,
      setDossierHost,
      setViewerHost,
      dossierClaimed: dossierClaims > 0,
      claimDossier,
      viewer,
      openViewer,
      closeViewer,
    }),
    [
      caseId,
      dossierHost,
      viewerHost,
      dossierClaims,
      claimDossier,
      viewer,
      openViewer,
      closeViewer,
    ],
  );

  return (
    <Ctx.Provider value={value}>
      {/* data-workspace 同时是三件事的锚点：容器查询的容器（globals.css）、
          AppShell 判断这一屏该不该解限宽的钩子、单实例守卫数的那个东西。 */}
      <div
        ref={rootRef}
        data-workspace=""
        {...(dossierClaims > 0 || viewer ? { 'data-panes': '' } : {})}
      >
        {children}
      </div>
    </Ctx.Provider>
  );
}

/**
 * 页面用：把一段内容投送到卷宗栏。
 *
 * 用 portal 不用「把节点存进 context」：后者每次 render 都是新节点，
 * 存进父组件的 state 会 render→setState→render 转成死循环；
 * portal 让这段内容**留在调用方的 React 树里**（state / SSE 全都不受影响），
 * 只有 DOM 落到卷宗栏。Pane 因此一点业务 state 都不用持有。
 */
export function useDossierPortal(children: ReactNode): ReactNode {
  const { claimDossier, dossierHost } = useCaseWorkspace();
  // 传 null 的页面不认领：没有卷宗栏可放的页面不该腾出那一栏
  const active = children != null && children !== false;
  useEffect(() => (active ? claimDossier() : undefined), [active, claimDossier]);
  return active && dossierHost ? createPortal(children, dossierHost) : null;
}

/** 同上，投送到查看器正文区。 */
export function useViewerPortal(children: ReactNode): ReactNode {
  const { viewerHost } = useCaseWorkspace();
  return viewerHost ? createPortal(children, viewerHost) : null;
}
