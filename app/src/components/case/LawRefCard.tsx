import type { LawRef } from '@/app/_mock/types';

/**
 * 法条依据：**分量 2**，借 GOV.UK Details。
 *
 * 批 1 起**默认折叠**——summary 一行给出条号和去处，展开才是逐字原文。
 * 依据要随手可查，但它不该和「现在做什么」抢同一份注意力。
 * 左侧 8px 灰边是它这一级的标记（行动卡是实边框+顶栏，草稿卡是细框+灰标题栏）。
 *
 * **「看逐字原文」必须始终在 DOM 里**，不许 lazy 到点开才渲染：
 * 评测 G4（法条引用四态）判的是归档正文，折叠不影响判据，
 * 但把原文挪出 DOM 就等于改了归档内容。<details> 天然满足这一点——
 * 收起状态下子节点仍在文档里，只是不显示。
 */
export function LawRefCard({ law }: { law: LawRef }) {
  return (
    <details data-veil="" className="group border-l-8 border-line pl-3">
      <summary className="flex min-h-11 cursor-pointer list-none items-start gap-2 py-1.5 text-[15px] leading-7 text-primary-ink marker:hidden">
        {/* 条号与「看逐字原文」放在同一条文字流里，不做两个 flex 项——
            分成两项时长条号会在中间断开、把后缀甩到下一行的行首。 */}
        <span className="min-w-0 flex-1">
          <span className="font-medium">{law.cite}</span>
          <span className="text-[14px] text-ink-2"> · 看逐字原文</span>
        </span>
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="mt-1.5 size-4 shrink-0 text-ink-2 transition-transform duration-150 ease-out group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9.5l6 6 6-6" />
        </svg>
      </summary>

      <p className="mt-1 text-[15px] leading-7 text-ink">{law.conclusion}</p>
      {/* 原文缩进，与结论拉开层次 */}
      <blockquote className="mt-2 mb-3 border-l-2 border-line pl-3 text-[15px] leading-7 text-ink-2">
        {law.fullText}
      </blockquote>
    </details>
  );
}
