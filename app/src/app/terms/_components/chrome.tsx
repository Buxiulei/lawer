// app/src/app/terms/_components/chrome.tsx
// 条款族三张新页（协议正文 / 境外模型 / 受托方清单）共用的骨架与排版件。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量：这几页在**注册之前**就要能读，那时还没有案件、
// 也就没有领域可问。
// ─────────────────────────────────────────────────────
//
// 【为什么单起一份，而不是让三页各画各的】三页的抬头、版心宽度、页脚回链一模一样。
// 各画一遍的形态是：改一处（比如页脚补一条互指链接）只改到其中一页，
// 而另外两页照常渲染、看起来完全正常——只是从那两页出发的人找不到第三页。
//
// 【为什么不顺手把 /terms/ai-labeling 也改成用它】那一页已经在线、判据钉着它的产物，
// 而本票要动它的只有一句自称。顺手重构一个没坏的东西，是把本票的风险面从
//「三张新页」扩大到「四张页」，换来的只是少几行重复的 JSX。
import Link from 'next/link';

import { Pending } from '@/app/_ui/Pending';
import { termsLive } from '@/lib/auth/consent';
import { TERMS_PREVIEW_BANNER } from '@/lib/consent';
import { TubashuMark } from '@/components/shell/TubashuMark';

import type { TermsQuote } from '../quotes';

// 占位件住在共用 UI 层（协议页与「帮助与投诉」页共用同一个），这里只转手
export { Pending };

/**
 * 一张条款页的外壳：抬头（品牌 + 标题 + 引言）、正文、页脚。
 *
 * @param footer 页脚里除「回到首页」之外的链接。协议正文页要指向它的两张附属页，
 *   附属页要指回协议——不给回链的形态是：从协议点进来的人读完卡在这一页，
 *   而这一页说的每一句都以协议那一条为前提。
 */
export function TermsShell({
  title,
  lead,
  children,
  footer,
}: {
  title: string;
  lead: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[760px] flex-col px-4 py-8 sm:px-6 sm:py-12">
      {/* 协议还没生效时，三张页都在这一处顶上挂横幅（经理裁决 2026-09-07）。
          挂在外壳而不是各页各写一条：三页共用一个外壳，各写一遍的形态是
          某一页漏了——而那一页读起来与生效后的正本一模一样，没有任何东西会报错。 */}
      <TermsPreviewBanner />
      <header className="border-b border-line pb-5">
        <div className="flex items-center gap-2.5">
          <TubashuMark size={24} className="size-6" />
          <span className="text-[15px] font-semibold text-ink">土八鼠</span>
        </div>
        <h1 className="mt-4 text-[21px] font-semibold text-ink sm:text-[24px]">{title}</h1>
        <div className="prose-measure mt-2 flex flex-col gap-2 text-[14px] leading-7 text-ink-2">
          {lead}
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="mt-10 flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-5 text-[13px] leading-6 text-ink-2">
        <Link href="/" className="text-primary-ink underline underline-offset-4">
          回到首页
        </Link>
        {footer}
      </footer>
    </div>
  );
}

/**
 * 「这一页还不是生效的正本」那条横幅。协议生效旗开着时**什么都不渲染**
 * （旗名与读法只在 lib/auth/consent.termsLive 一处，这里不再抄一遍变量名）。
 *
 * 【为什么是横幅而不是把页面撤掉】页上印着的法条原文、受托方清单、境外接收方说明是
 * **现在就成立**的告知，首页与登录页页脚也已经指过来了。整页拿掉的形态是那几条链接静默 404，
 * 而"合规条款读不到"看起来只像"链接坏了"。
 *
 * 【为什么用 amber 而不是 danger】DESIGN.md 色彩纪律：danger 留给风险与不可逆结论；
 * 这里的事实是"还没发布"，与 <Pending/> 同一类（同色是刻意的：一页上那些方括号占位
 * 与这条横幅说的是同一件事——这份文本还没定稿）。
 */
export function TermsPreviewBanner() {
  if (termsLive()) return null;
  return (
    <p
      data-terms-preview="1"
      className="mb-5 rounded-[10px] border-l-4 border-amber bg-amber-wash px-3.5 py-2.5 text-[13.5px] leading-6 font-medium text-amber-ink"
    >
      {TERMS_PREVIEW_BANNER}
    </p>
  );
}

/** 一节。`no` 是条号（「一」「二」…），与协议正文的编号一致，便于对照引用。 */
export function Section({
  no,
  title,
  children,
}: {
  no: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-[17px] font-semibold text-ink">
        <span className="num mr-2 text-ink-2">{no}</span>
        {title}
      </h2>
      <div className="prose-measure mt-2 flex flex-col gap-3 text-[14.5px] leading-7 text-ink-2">
        {children}
      </div>
    </section>
  );
}

/** 编号条目。协议正文按款编号，读的人要能引「第五条第 5 款」。 */
export function Clause({ no, children }: { no: number; children: React.ReactNode }) {
  return (
    <p className="flex gap-2">
      <span className="num shrink-0 text-ink-2">{no}.</span>
      <span className="flex-1">{children}</span>
    </p>
  );
}

/**
 * 一段逐字引文。**法名、条款位置与原文一起印**：只印原文的形态是，
 * 读的人核不回去（协议横跨五部法律加两部规章，凭一段话找不到它出自哪一部的哪一条）。
 */
export function Quote({ q }: { q: TermsQuote }) {
  return (
    <blockquote className="border-l-2 border-line pl-3 text-[14px] leading-7 text-ink">
      <span className="text-ink-2">
        {q.law}
        {q.at}：
      </span>
      「{q.text}」
    </blockquote>
  );
}

/**
 * 与用户有重大利害关系的条款（民法典 §496 第二款 / 消保法 §26 第一款要求"以显著方式提请注意"）。
 * 加粗不是排版偏好，是**提示义务的落地形态**——所以它是一个有名字的件，不是散落的 <strong>：
 * 散落的形态是某一条被顺手改成普通文字，页面照常渲染，而那一条从此可能不成为合同的内容。
 */
export function Key({ children }: { children: React.ReactNode }) {
  return <strong data-key-term="1" className="font-semibold text-ink">{children}</strong>;
}
