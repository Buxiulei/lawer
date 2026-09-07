import type { Metadata } from 'next';
import Link from 'next/link';

import {
  TERMS_HREF,
  TERMS_OVERSEAS_HREF,
  TERMS_OVERSEAS_TITLE,
  TERMS_PROCESSORS_TITLE,
  TERMS_TITLE,
} from '@/app/_ui/termsLinks';

import { Pending, Section, TermsShell } from '../_components/chrome';
import { isPending, PROCESSORS, type Cell } from './processors';

// app/src/app/terms/processors/page.tsx
// 受托方清单（协议第五条第 7 款）。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量。
// ─────────────────────────────────────────────────────
//
// 【为什么单起一页而不是塞进协议第五条】清单会变（换一家短信通道、加一个模型服务商），
// 而协议正文一改就要走第十四条的变更通知流程（提前 7 日、站内 + 短信/邮件）。
// 把会变的那一份挂在协议外面、由协议指过来，是让"换一家服务商"不必每次惊动全体用户；
// 代价是这一页必须自己保持最新——所以清单是数据（processors.ts），由判据按行按栏数。

export const metadata: Metadata = {
  title: TERMS_PROCESSORS_TITLE,
  description: '我们委托了哪些第三方处理你的个人信息：名称、用途与所在地，逐条列出。',
};

/** 一栏。定了就印那个字；没定就印醒目的占位——空格子与"未定"在页面上必须长得不一样。 */
function CellText({ cell }: { cell: Cell }) {
  return isPending(cell) ? <Pending>{cell.pending}</Pending> : <>{cell}</>;
}

/**
 * 【为什么不静态预渲染】页顶那条「预览版」横幅由 TermsShell 按协议生效旗渲染，
 * 而旗只在服务端读得到。被预渲染的形态是：旗**烙进构建产物**——协议正式发布那天
 * 运维打开旗、重启进程，三张页顶上那条"尚未生效"原样还在，而没有一处会报错。
 */
export const dynamic = 'force-dynamic';

export default function ProcessorsPage() {
  return (
    <TermsShell
      title={TERMS_PROCESSORS_TITLE}
      lead={
        <>
          <p>
            本页是《{TERMS_TITLE}》第五条第 7 款的组成部分：我们委托了哪些第三方处理你的个人信息，
            它们各自拿到什么、拿去做什么、在哪儿。
          </p>
          <p>
            清单变动时这一页随之更新。涉及境外接收方的那一条，另有
            <Link
              href={TERMS_OVERSEAS_HREF}
              className="mx-1 text-primary-ink underline underline-offset-4"
            >
              {TERMS_OVERSEAS_TITLE}
            </Link>
            逐项说明，并且要单独取得你的同意。
          </p>
        </>
      }
      footer={
        <>
          <Link href={TERMS_HREF} className="text-primary-ink underline underline-offset-4">
            《{TERMS_TITLE}》
          </Link>
          <Link
            href={TERMS_OVERSEAS_HREF}
            className="text-primary-ink underline underline-offset-4"
          >
            {TERMS_OVERSEAS_TITLE}
          </Link>
        </>
      }
    >
      <Section no="一" title="清单">
        <div className="flex flex-col gap-3">
          {PROCESSORS.map((p, i) => (
            <div
              key={i}
              data-processor-row="1"
              className="rounded-[12px] border border-line bg-surface p-4 sm:p-5"
            >
              <h3 className="text-[15px] font-semibold text-ink">
                <CellText cell={p.name} />
              </h3>
              <dl className="mt-2 flex flex-col gap-1.5">
                <div className="grid gap-1 sm:grid-cols-[5rem_1fr] sm:gap-3">
                  <dt className="text-[13px] text-ink-2">用途</dt>
                  <dd className="text-[14px] leading-7 text-ink">{p.purpose}</dd>
                </div>
                <div className="grid gap-1 sm:grid-cols-[5rem_1fr] sm:gap-3">
                  <dt className="text-[13px] text-ink-2">所在地</dt>
                  <dd className="text-[14px] leading-7 text-ink">
                    <CellText cell={p.location} />
                  </dd>
                </div>
                {p.note && (
                  <div className="grid gap-1 sm:grid-cols-[5rem_1fr] sm:gap-3">
                    <dt className="text-[13px] text-ink-2">另外</dt>
                    <dd className="text-[14px] leading-7 text-ink-2">{p.note}</dd>
                  </div>
                )}
              </dl>
            </div>
          ))}
        </div>
      </Section>

      <Section no="二" title="你上传的文件什么时候会经过它们">
        <p>
          证据文件平时只加密存放在我们自己的服务器上。
          <strong className="font-semibold text-ink">
            只有你自己发起「内容提取 / 转写 / 材料简报」这类按量服务时
          </strong>
          ，那一份材料才会经上表中的模型服务商处理；不发起就不会，
          而这类服务在执行前会先向你报价、由你确认（协议第七条第 3 款）。
        </p>
        <p>
          我们不把你的档案用于向第三方营销——这一条写在协议第五条第 3 款里，
          不是这一页的客套话。
        </p>
      </Section>
    </TermsShell>
  );
}
