'use client';

import { useState } from 'react';
import { Button } from '@/components/shadcn/button';
import { useDiscreet } from './discreet';

/**
 * 低调模式下的「整块折叠」壳。
 *
 * 【为什么有些内容折叠而不是进糊层】糊层（[data-veil]）适合一段一段的正文——按住就能看清，
 * 排版不变。但接入话术是**一整块要原样复制的等宽文本**，糊起来既读不了也复制不了，
 * 而它逐字带着「土八鼠 / 劳动仲裁 / 案件档案库」。这类内容的正解是默认不渲染，
 * 想看的人自己点开。
 *
 * 【为什么抽成公共壳】同一份话术现在出现在两处：设置页的 AgentSetupCard 与
 * 接入指南 /settings/agent。第一处的折叠逻辑由 setup-card-discreet.test 钉着，
 * 第二处曾把同样的内容搬到一个**不折叠**的新页面上——守卫按组件名锁在旧卡上，
 * 看不见新页，于是低调模式下整段话术明文摊在屏幕上，而两边都没有任何报错。
 * 逻辑只写一份，新页面接的是同一个壳；页面级守卫见各自 __tests__ 下的 discreet 组。
 *
 * 常规模式下这层完全透明：直接渲染 children，不加任何包裹节点。
 */
export function DiscreetCollapse({
  label,
  children,
}: {
  /** 折叠态那颗按钮上的字。**必须是中性的**——它是低调模式下唯一露在外面的一行。 */
  label: string;
  children: React.ReactNode;
}) {
  const { discreet } = useDiscreet();
  const [expanded, setExpanded] = useState(false);

  if (!discreet) return <>{children}</>;

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex min-h-11 w-full items-center text-[15px] text-ink-2 hover:text-ink"
      >
        {label}
      </button>
    );
  }

  return (
    <>
      {children}
      <div className="mt-4 border-t border-line pt-3">
        <Button size="sm" variant="secondary" onClick={() => setExpanded(false)}>
          收起
        </Button>
      </div>
    </>
  );
}
