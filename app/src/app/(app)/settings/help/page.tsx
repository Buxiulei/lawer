import type { Metadata } from 'next';
import Link from 'next/link';

import { HELP_COMPLAINTS_TITLE, TERMS_HREF, TERMS_TITLE } from '@/app/_ui/termsLinks';

import { ComplaintForm } from './_components/ComplaintForm';

// app/src/app/(app)/settings/help/page.tsx
// 「设置 → 帮助与投诉」（协议第十二条第 1 款的站内入口）。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量。
// ─────────────────────────────────────────────────────
//
// 【为什么是一整页，不是设置页里的一张卡】《生成式人工智能服务管理暂行办法》第十五条要的是
//「**便捷的**投诉、举报入口」，并且要「公布处理流程和反馈时限」——那是一段要读的字。
// 塞进设置页某张卡的折叠区里的形态是：它在，但要找它的人找不到，
// 而「找不到」与「没有」在合规上同形。设置页上留一条指过来的入口。

export const metadata: Metadata = { title: HELP_COMPLAINTS_TITLE };

export default function HelpPage() {
  return (
    <div className="pt-1 pb-4">
      <header className="py-3">
        <h1 className="text-[22px] leading-8 font-semibold tracking-tight text-ink">
          {HELP_COMPLAINTS_TITLE}
        </h1>
        <p className="prose-measure mt-2 text-[14px] leading-7 text-ink-2">
          服务出了问题、看到违法或侵权的生成内容、或者要查阅、更正、删除自己的个人信息，
          都从这里提。提交后会给你一个受理编号，处理流程与时限写在下面，也写在
          <Link href={TERMS_HREF} className="mx-1 text-primary-ink underline underline-offset-4">
            《{TERMS_TITLE}》
          </Link>
          第十二条。
        </p>
      </header>

      <div className="mt-2 flex flex-col gap-4">
        <ComplaintForm />
      </div>
    </div>
  );
}
