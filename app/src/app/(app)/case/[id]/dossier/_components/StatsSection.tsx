'use client';

import type { ReactNode } from 'react';
import type { DurationStats, OutcomeStats, StatProvenance } from '@/lib/dossier/contract';
import {
  canShowOutcomeRatio,
  canShowSegment,
  DURATION_SEGMENT_LABEL,
  hasProvenance,
  outcomeShortSentence,
  OUTCOME_METRIC_LABEL,
  provenanceMissingSentence,
  segmentShortSentence,
} from '@/lib/dossier/present';
import { formatDate } from '@/app/_ui/format';
import { Badge } from '@/components/shadcn/badge';

/**
 * 统计卡。
 *
 * 【这个组件的全部要点是它拒绝渲染什么】
 * 缺样本量 / 采集截止日 / 来源三件套任一 ⇒ 不出数字，出「缺什么」那句话；
 * 三件套齐但样本不够门槛 ⇒ 不出数字，出「样本不足＋四个数」那句话。
 * 判断写在组件里、有单测钉着，**不靠调用方自觉**——调用方会换人，组件不会。
 *
 * 门槛值一律从数据里读（`minSample`，源头是 pricing_config），
 * 界面上没有任何地方写死 5：门槛写死在界面上，改表就改不动它，
 * 而"门槛是多少"恰恰是这块诚实性的全部内容。
 */

/** 卡壳：标题 + 三件套页脚。页脚只在三件套齐时出现（不齐时那句话自己会说缺什么）。 */
function StatCard({
  title,
  provenance,
  children,
}: {
  title: string;
  provenance: StatProvenance;
  children: ReactNode;
}) {
  const complete = hasProvenance(provenance);
  return (
    <section className="rounded-[12px] border border-border bg-card px-4 py-3.5">
      <h3 className="text-[15px] leading-7 font-semibold text-ink">{title}</h3>
      <div data-veil="" className="mt-1.5">
        {children}
      </div>
      {complete && (
        <p data-veil="" className="mt-2.5 text-[12.5px] leading-6 text-ink-2">
          样本 <span className="num">{provenance.sampleN}</span> 篇 · 数据截至{' '}
          <span className="num">{formatDate(provenance.asOf!)}</span> · {provenance.source}
        </p>
      )}
    </section>
  );
}

/** 出不了数字时统一长这样：一段说明，没有任何百分号或中位数。 */
function ShortSample({ text }: { text: string }) {
  return (
    <>
      <Badge tone="amber">出不了这个数</Badge>
      <p className="prose-measure mt-1.5 text-[14px] leading-7 text-ink-2">{text}</p>
    </>
  );
}

export function OutcomeCard({ stats }: { stats: OutcomeStats }) {
  // 顺序有讲究：先看三件套齐不齐，再看样本够不够。
  // 反过来的话，一张缺来源的卡只要样本够就会出数字。
  if (!hasProvenance(stats)) {
    return (
      <StatCard title={OUTCOME_METRIC_LABEL} provenance={stats}>
        <ShortSample text={provenanceMissingSentence(stats)} />
      </StatCard>
    );
  }
  if (!canShowOutcomeRatio(stats)) {
    return (
      <StatCard title={OUTCOME_METRIC_LABEL} provenance={stats}>
        <ShortSample text={outcomeShortSentence(stats)} />
      </StatCard>
    );
  }

  const ratio = Math.round((stats.workerFavorableN / stats.docsOutcomeDecided) * 100);
  return (
    <StatCard title={OUTCOME_METRIC_LABEL} provenance={stats}>
      <p className="num text-[28px] leading-10 font-semibold text-ink">{ratio}%</p>
      <p className="prose-measure mt-0.5 text-[14px] leading-7 text-ink-2">
        可判定结果的 <span className="num">{stats.docsOutcomeDecided}</span> 篇里，
        劳动者全部或部分获支持 <span className="num">{stats.workerFavorableN}</span> 篇。
        入档共 <span className="num">{stats.docsTotal}</span> 条，
        取到全文 <span className="num">{stats.docsFulltext}</span> 篇。
      </p>
      {/* 申请人方分布与比例同屏并列：不区分谁把谁告了的比率会把方向读反——
          存在用人单位批量起诉员工的案子，那时"公司赢了"和"劳动者输了"不是同一件事。 */}
      <p className="prose-measure mt-2 text-[14px] leading-7 text-ink-2">
        这 <span className="num">{stats.docsOutcomeDecided}</span> 篇里，
        劳动者提起 <span className="num">{stats.byApplicant.worker}</span> 件、
        单位提起 <span className="num">{stats.byApplicant.employer}</span> 件
        {stats.byApplicant.unknown > 0 && (
          <>
            、看不出是谁提起的 <span className="num">{stats.byApplicant.unknown}</span> 件
          </>
        )}
        。
      </p>
    </StatCard>
  );
}

/**
 * 时长四段。**每段独立成卡、独立判样本量**，一段不足不牵连别段。
 * 这里没有、也不许有"平均处理时长"这样的合成卡：四段的分布形状完全不同，
 * 合成一个数等于告诉用户"你的案子大概要这么久"。
 */
export function DurationCards({ stats }: { stats: DurationStats }) {
  return (
    <>
      {stats.segments.map((seg) => {
        const title = DURATION_SEGMENT_LABEL[seg.key];
        if (!hasProvenance(seg)) {
          return (
            <StatCard key={seg.key} title={title} provenance={seg}>
              <ShortSample text={provenanceMissingSentence(seg)} />
            </StatCard>
          );
        }
        if (!canShowSegment(seg, stats.minSample)) {
          return (
            <StatCard key={seg.key} title={title} provenance={seg}>
              <ShortSample text={segmentShortSentence(seg, stats.minSample)} />
            </StatCard>
          );
        }
        return (
          <StatCard key={seg.key} title={title} provenance={seg}>
            <p className="num text-[28px] leading-10 font-semibold text-ink">
              {seg.medianDays} <span className="text-[16px] font-normal text-ink-2">天</span>
            </p>
            <p className="prose-measure mt-0.5 text-[14px] leading-7 text-ink-2">
              中位数。只用文书上载明的日期算，推断的不计。
            </p>
          </StatCard>
        );
      })}
    </>
  );
}
