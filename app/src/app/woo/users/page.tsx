// app/src/app/woo/users/page.tsx
// /woo/users 管理后台。
//
// ── 为什么这一页不在 (app) 路由组里 ──
// (app) 组的布局套的是 AppShell（侧栏 + 底部 Tab + 面包屑），任何挂在里面的页面
// 都得在导航里有个位置，否则壳层会渲染出一个"当前页不在任何 Tab 上"的怪状态。
// 而工单要求后台**不出现在任何普通用户可达的导航里**——入口只有直接输 URL。
// 放在路由组外，这件事就是**结构性**的：没有一个地方能把它列进导航，
// 而不是"我们记得没加那个链接"。判据见 __tests__/no-nav-entry.test.ts。
//
// ── 低调模式不适用 ──
// 低调模式（Sensitive / data-veil）是给劳动者在办公室里防人瞟屏幕的。后台是老板面板，
// 老板看的就是这些数，糊掉只会让他把糊层关了再看——那反而让开关变成摆设。
// 所以这一页不套 Sensitive、不加 data-veil。
import type { Metadata } from 'next';
import { AdminUsersPanels } from './_components/AdminUsersPanels';

export const metadata: Metadata = {
  title: '后台',
  // 后台不该被搜索引擎收录：一个能被搜出来的后台，等于把 404 那层遮挡自己撤了。
  robots: { index: false, follow: false },
};

export default function AdminUsersPage() {
  // 待审队列在最上面：它是**有人在等**的那一块（护照用户交完材料就卡在待审，
  // 只有这里能推动他），而下面的账号表是随时可查的。两块各自独立取数、
  // 各自处理 404，其中一块不通不该把另一块也拖成空白页。
  // 顺序与"审完了要通知下面一声"都在 AdminUsersPanels 里——这一页是服务端组件
  // （要 export metadata），递不了回调。
  return (
    <main className="mx-auto max-w-5xl px-4 pt-6">
      <AdminUsersPanels />
    </main>
  );
}
