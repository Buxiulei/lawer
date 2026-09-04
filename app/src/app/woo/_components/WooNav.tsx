'use client';

// 后台两页之间的切换条。
//
// 【为什么要有它】/woo/users 与 /woo/codes 是两棵互不相连的页面树，此前彼此之间
// 一个链接都没有——从账号管理台去兑换码，只能手敲地址。后台不进全站导航是**刻意**的
// （见 users/page.tsx 头注释：它压根不在 (app) 路由组里，没有地方能把它列进侧栏），
// 但"不进全站导航"要防的是普通用户撞见入口，不是让已经站在后台里的人认不得路。
//
// 【它必须只在已放行时渲染】这一条自己不判权，也判不了——登录态是 localStorage 里的
// JWT，服务端渲染时读不到。所以挂载它的两处都把它放在**接口放行之后**：
//   · /woo/codes：AdminCodesView 的 404 分支走 notFound()，走到 return 就是已放行；
//   · /woo/users：AdminUsersPanels 拿 AdminUsersView 回报的放行信号做闸。
// 直接挂在 page.tsx 顶上会让非白名单的人也看见「账号 / 兑换码」两个字，
// 那等于在一张本该与 404 同形的页面上承认这里有个后台。
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/app/_ui/cn';

/** 两个页签的唯一真源：新增后台页时只改这里，判据（woo-nav.test.tsx）按它逐条核。 */
export const WOO_TABS = [
  { href: '/woo/users', label: '账号' },
  { href: '/woo/codes', label: '兑换码' },
] as const;

export function WooNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="后台" className="mb-4 flex items-center gap-1 border-b border-line pb-2">
      {WOO_TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-[10px] px-3 py-2 text-[14px] transition-colors duration-150 ease-out',
              active
                ? 'bg-surface-2 font-medium text-primary-ink-on-surface'
                : 'text-ink-2 hover:bg-surface-2',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
