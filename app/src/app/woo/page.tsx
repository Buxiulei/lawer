// app/src/app/woo/page.tsx
// /woo 根路径：后台的入口只有直接输 URL，主理人记的是「/woo 进管理页」。
// 这里不渲染任何内容，直接跳到用户管理页；非管理员在那一页照旧看到 404 那层遮挡。
// 不列导航（结构性约束见 users/page.tsx 头注释与 __tests__/no-nav-entry.test.ts）。
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: '后台',
  robots: { index: false, follow: false },
};

export default function WooIndexPage() {
  redirect('/woo/users');
}
