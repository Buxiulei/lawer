import type { Metadata } from 'next';
import { AdminCodesView } from './AdminCodesView';

/**
 * 兑换码管理页。**刻意放在 (app) 路由组之外**：不挂 AppShell，
 * 底部 Tab / 顶栏里不该出现一个通往后台的入口——那是给所有用户看的导航。
 *
 * 【这一页本身不鉴权，也不能鉴权】登录态是 localStorage 里的 JWT（见 _ui/auth），
 * 服务端渲染时读不到，所以这里没有"服务端判权后 404"这条路。
 * **真正的闸门在 /api/v1/admin/codes**：非白名单一律空体 404。
 * 这一页的静态骨架谁都能下载，但它里面没有任何数据——数据要等那条接口放行。
 */
export const metadata: Metadata = {
  title: '兑换码',
  // 后台不进搜索引擎。这不是安全措施（真正的闸门在接口），是不要主动把地址喂出去。
  robots: { index: false, follow: false },
};

export default function AdminCodesPage() {
  return <AdminCodesView />;
}
