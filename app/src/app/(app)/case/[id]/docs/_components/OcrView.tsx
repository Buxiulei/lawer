'use client';

import { useState } from 'react';
import type { AnnotatedRiskFlag } from '@/app/_mock/docs-drafts';
import { LawRefCard } from '@/components/case/LawRefCard';
import { AppSheet } from '@/components/shadcn/app-sheet';
import { Badge, type BadgeTone } from '@/components/shadcn/badge';
import { Card } from '@/components/shadcn/card';
import { SensitiveText } from './SensitiveText';

const LEVEL_TONE: Record<AnnotatedRiskFlag['level'], BadgeTone> = {
  高: 'danger',
  中: 'amber',
  低: 'neutral',
};

interface Segment {
  text: string;
  /** 命中的风险条款，undefined 表示普通文字 */
  flag?: AnnotatedRiskFlag;
  /** 第几处标红，从 1 开始 */
  index?: number;
}

/** 在一行原文里找出所有风险片段，重叠的按先出现的算。 */
function segmentLine(line: string, flags: AnnotatedRiskFlag[]): Segment[] {
  const hits = flags
    .map((flag, i) => ({ flag, index: i + 1, at: line.indexOf(flag.quote) }))
    .filter((h) => h.at >= 0)
    .sort((a, b) => a.at - b.at);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.at < cursor) continue;
    if (hit.at > cursor) segments.push({ text: line.slice(cursor, hit.at) });
    segments.push({ text: hit.flag.quote, flag: hit.flag, index: hit.index });
    cursor = hit.at + hit.flag.quote.length;
  }
  if (cursor < line.length) segments.push({ text: line.slice(cursor) });
  return segments;
}

export function OcrView({
  ocrText,
  riskFlags,
}: {
  ocrText: string;
  riskFlags: AnnotatedRiskFlag[];
}) {
  const [active, setActive] = useState<{ flag: AnnotatedRiskFlag; index: number } | null>(
    null,
  );
  const lines = ocrText.split('\n').filter((l) => l.trim().length > 0);

  return (
    <Card>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="fs-m font-semibold text-ink">识别出的原文</h2>
        <p className="fs-s text-ink-2">
          {riskFlags.length > 0
            ? `标红 ${riskFlags.length} 处，点一下看为什么`
            : '这份文件没有需要标红的条款'}
        </p>
      </header>

      <div className="px-4 py-4">
        {lines.map((line, i) => (
          <p
            key={i}
            data-veil=""
            className="prose-measure mt-3 fs-m text-ink first:mt-0"
          >
            {segmentLine(line, riskFlags).map((seg, j) => {
              const { flag, index } = seg;
              if (!flag || !index) return <SensitiveText key={j} text={seg.text} />;
              return (
                <button
                  key={j}
                  type="button"
                  onClick={() => setActive({ flag, index })}
                  aria-label={`第 ${index} 处风险条款：${seg.text}`}
                  // inline + box-decoration-clone：长条款要能跟着正文换行，不能撑出横向滚动
                  className="inline box-decoration-clone rounded-r-[4px] border-l-[3px] border-danger bg-danger-wash px-1 py-0.5 text-left text-ink"
                >
                  <SensitiveText text={seg.text} />
                  <sup className="num ml-0.5 fs-xs font-semibold text-danger-ink">
                    {index}
                  </sup>
                </button>
              );
            })}
          </p>
        ))}

        <p className="mt-5 border-t border-border pt-3 fs-xs text-ink-2">
          原文按识别顺序分段呈现，未做改写。识别可能有个别错字，以你手上的纸质件或原始文件为准。
        </p>
      </div>

      <AppSheet
        open={active !== null}
        onClose={() => setActive(null)}
        title={active ? `第 ${active.index} 处风险条款` : '风险条款'}
      >
        {active && (
          <div className="flex flex-col gap-4">
            <div>
              <Badge tone={LEVEL_TONE[active.flag.level]}>风险 {active.flag.level}</Badge>
              <blockquote
                data-veil=""
                className="mt-2.5 border-l-4 border-danger bg-danger-wash px-3.5 py-3 fs-m text-ink"
              >
                <SensitiveText text={active.flag.quote} />
              </blockquote>
            </div>

            <div>
              <h3 className="fs-m font-semibold text-ink">为什么有风险</h3>
              <p data-veil="" className="mt-1.5 fs-m text-ink-2">
                <SensitiveText text={active.flag.note} />
              </p>
            </div>

            {active.flag.laws.length > 0 ? (
              <div>
                <h3 className="fs-m font-semibold text-ink">法条依据</h3>
                <div className="mt-2 flex flex-col gap-2">
                  {active.flag.laws.map((law) => (
                    <LawRefCard key={law.cite} law={law} />
                  ))}
                </div>
              </div>
            ) : (
              <p className="rounded-[10px] bg-surface-2 px-3 py-2 fs-s text-ink-2">
                这一处是事实和谈判层面的问题，没有对应的具体条文，处理办法写在上面。
              </p>
            )}
          </div>
        )}
      </AppSheet>
    </Card>
  );
}
