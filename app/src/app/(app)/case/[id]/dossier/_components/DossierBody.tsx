'use client';

import Link from 'next/link';
import type { DossierView } from '@/lib/dossier/contract';
import { TENURE_DISCLAIMER } from '@/lib/dossier/present';
import { NeutralLabel } from '@/app/_ui/NeutralLabel';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Sensitive } from '@/components/Sensitive';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { BlockProgress } from './BlockProgress';
import { PatternSection } from './PatternSection';
import { OutcomeCard, DurationCards } from './StatsSection';
import { VenueCards } from './VenueCards';

/**
 * 公司档案页正文。
 *
 * 【低调模式红线】页面标题、tab title、面包屑一律是「公司档案」这四个字，
 * 公司名只出现在正文的 Sensitive 里。顶栏是最容易被旁人瞥见的一条。
 *
 * 【段落顺序】进度 → 谱系入口 → 统计 → 套路 → 仲裁地。
 * 覆盖度声明**不排在最后**：设计要求它与统计卡「同屏同级」，
 * 排在页尾的话，一屏读不完时它就等于不存在——而它恰恰是读那些数字的前提。
 */
export function DossierBody({ caseId, dossier }: { caseId: string; dossier: DossierView }) {
  return (
    <div className="flex flex-col gap-6 pt-1">
      <header className="pt-3">
        <h1 className="text-[20px] font-semibold text-ink">
          <NeutralLabel plain="公司档案" neutral={NEUTRAL_WORD.dossier} />
        </h1>
        <p data-veil="" className="prose-measure mt-0.5 text-[15px] leading-7 text-ink-2">
          这家公司以前的劳动争议是怎么打的、打了多久、惯用哪几套说法。
          底下每个数字都跟着它的样本量和数据截止日——看不到这两样的数字不要信。
        </p>
        <Sensitive as="div" className="mt-2 block">
          <p className="text-[15px] leading-7 font-medium text-ink">{dossier.companyName}</p>
        </Sensitive>
      </header>

      <Section title="进展">
        <BlockProgress blocks={dossier.blocks} queuePosition={dossier.queuePosition} />
      </Section>

      <Section title="关联主体谱系">
        {dossier.graphReady ? (
          <>
            <p data-veil="" className="prose-measure text-[14px] leading-7 text-ink-2">
              跟你签合同的、给你发工资的、背后控股的，常常不是同一家。
            </p>
            <Button size="sm" variant="secondary" className="mt-2" asChild>
              <Link href={`/case/${caseId}/graph`}>看它们的关系</Link>
            </Button>
          </>
        ) : (
          <p data-veil="" className="prose-measure text-[14px] leading-7 text-ink-2">
            谱系还没跑完，跑完后这里会给出关系图入口。
          </p>
        )}
      </Section>

      <Section title="判例统计">
        {/* 覆盖度声明：结构化必渲染字段，与统计卡同屏同级，**不折叠**。
            外勤已经把这句话写出来了，把它降级成可折叠小字，
            等于让用户替我们承担诚实税。 */}
        {dossier.coverageNote && (
          <div
            data-veil=""
            data-testid="coverage-note"
            className="rounded-[10px] border border-amber-ink/25 bg-amber-wash px-3.5 py-3"
          >
            <p className="text-[13px] leading-6 font-medium text-amber-ink">这些数字覆盖到哪里</p>
            <p className="prose-measure mt-1 text-[14px] leading-7 text-ink">
              {dossier.coverageNote}
            </p>
          </div>
        )}

        {dossier.outcome ? (
          <div className="mt-3">
            <OutcomeCard stats={dossier.outcome} />
          </div>
        ) : (
          <p data-veil="" className="mt-3 prose-measure text-[14px] leading-7 text-ink-2">
            判例还没采完，统计要等它跑完才算。
          </p>
        )}

        {dossier.duration && (
          <>
            <h3 className="mt-4 text-[15px] font-semibold text-ink">各阶段耗时</h3>
            <p data-veil="" className="prose-measure mt-0.5 text-[14px] leading-7 text-ink-2">
              四段各算各的，不合成一个「平均时长」——四段的分布形状不一样，
              合起来的那个数说不了你的案子要多久。
            </p>
            <div className="mt-2 flex flex-col gap-2.5">
              <DurationCards stats={dossier.duration} />
            </div>
          </>
        )}

        {dossier.tenureYears !== null && (
          <p data-veil="" className="prose-measure mt-3 text-[13px] leading-6 text-ink-2">
            {TENURE_DISCLAIMER}
          </p>
        )}
      </Section>

      <Section title="它的应诉套路">
        <PatternSection patterns={dossier.patterns} dropped={dossier.droppedPatterns} />
      </Section>

      <Section title={`${dossier.venue.venue}的实操与判案风格`}>
        <VenueCards section={dossier.venue} />
      </Section>

      {dossier.refund?.refunded && (
        <Section title="这一块已退款">
          <p data-veil="" className="prose-measure text-[14px] leading-7 text-ink-2">
            {dossier.refund.reason}
            {dossier.refund.amountGongdao !== null && (
              <>
                ，已退回 <span className="num">{dossier.refund.amountGongdao}</span> 公道值
              </>
            )}
            。已经采到的判例条目仍然保留在上面。
          </p>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      {/* 小节标题不进糊层：低调模式下整页正文糊着时，还得看得出这一段讲什么 */}
      <h2 className="mb-2 text-[16px] leading-7 font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

/** 未建档时的招呼。**不摆任何演示数字**——真实案件下摆别人的统计比空白危险得多。 */
export function DossierNotOrdered({ caseId }: { caseId: string }) {
  return (
    <div className="pt-1">
      <header className="py-3">
        <h1 className="text-[20px] font-semibold text-ink">
          <NeutralLabel plain="公司档案" neutral={NEUTRAL_WORD.dossier} />
        </h1>
      </header>
      <div className="rounded-[12px] border border-dashed border-border bg-card px-5 py-10 text-center">
        <p className="text-[16px] font-semibold text-ink">这个案件还没有建过公司档案</p>
        <p data-veil="" className="prose-measure mx-auto mt-2 text-[15px] leading-7 text-ink-2">
          建档会去查这家公司的关联主体、把它以前的劳动争议判例调出来算统计、
          归纳它的应诉套路。判例那一块要真人登录取证，不是马上能拿到。
        </p>
        <div className="mt-5">
          <Badge tone="neutral">先看报价，确认了才扣</Badge>
        </div>
        <Button size="sm" className="mt-4" asChild>
          <Link href={`/case/${caseId}/dossier/order`}>看报价</Link>
        </Button>
      </div>
    </div>
  );
}
