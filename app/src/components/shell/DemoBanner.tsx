'use client';

import Link from 'next/link';
import { useAuthToken } from '@/app/_ui/auth';
import { useDiscreet } from '@/app/_ui/discreet';

/**
 * 演示案件横幅：demo 里的公司、金额、时间线全是编的，凡是 demo 的页面都得写着这句。
 *
 * 底色用 surface-2 不用警报色——这不是出错，只是告诉你"眼前这份不是你的"。
 * 低调模式下文案中性化：横幅在页顶最显眼，不能是全站唯一漏字的地方。
 */
export function DemoBanner() {
  const { discreet } = useDiscreet();
  // 首帧恒为未登录，水合后翻正；横幅本身两种情况都显示，只是链接文案不同
  const signedIn = useAuthToken() !== null;

  const label = discreet
    ? '开始我自己的'
    : signedIn
      ? '回到我的案件'
      : '开始我自己的案件';

  return (
    <div className="border-b border-line bg-surface-2 px-3 py-2 lg:px-4">
      <p className="mx-auto flex max-w-[900px] flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] leading-6 text-ink-2">
        <span>{discreet ? '演示内容' : '这是演示案件，内容为虚构示例'}</span>
        <span aria-hidden>·</span>
        {/* 接 cases 列表接口前，已登录的人也只能去 /login——全站还没有"我自己的案件"这个地址 */}
        {/* min-h-11 把命中区撑到 44（原来只有 24px 高），-my-2.5 把多出来的 20px 从版式里减掉——
            横幅高度不变，只是变得点得中。不走 BreadcrumbLink：那是面包屑的语义槽，这里是横幅正文里的一句。 */}
        <Link
          href="/login"
          className="-my-2.5 inline-flex min-h-11 items-center font-medium text-primary-ink underline-offset-4 hover:underline"
        >
          {label} →
        </Link>
      </p>
    </div>
  );
}
