'use client';

import type { VenueSection } from '@/lib/dossier/contract';
import { VENUE_NOT_COVERED } from '@/lib/dossier/present';
import { Badge } from '@/components/shadcn/badge';

/**
 * 仲裁地实操与判案风格。
 *
 * 【未覆盖的辖区只出那一句，不出任何风格描述】首发只做北京朝阳。
 * 这里绝不能有"各地仲裁流程大同小异，一般需要……"这类兜底话术——
 * 那种句子读起来像内容，实际是没核实过的辖区在冒充核实过的辖区，
 * 而用户会照着它准备材料、算时间。
 *
 * 覆盖的辖区，卡里是知识库的**原文**（loader 剥掉 frontmatter 后的正文），
 * 一个字不改写、不摘要——摘要就是生成，生成就有编的空间。
 */
export function VenueCards({ section }: { section: VenueSection }) {
  if (!section.covered) {
    return (
      <p data-veil="" className="prose-measure text-[14px] leading-7 text-ink-2">
        {VENUE_NOT_COVERED}
      </p>
    );
  }

  if (section.cards.length === 0) {
    return (
      <p data-veil="" className="prose-measure text-[14px] leading-7 text-ink-2">
        这个仲裁地的存档卡这次没读出来，页面不拿通用说法顶替。稍后再看一次。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {section.cards.map((card) => (
        <details
          key={card.id}
          className="overflow-hidden rounded-[12px] border border-border bg-card"
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-3 text-[15px] leading-7 font-medium text-ink">
            <span className="min-w-0 flex-1">{card.title}</span>
            <Badge tone={card.confidence === '原文核实' ? 'success' : 'amber'}>
              {card.confidence}
            </Badge>
          </summary>
          <div className="border-t border-line px-4 py-3">
            {/* 原文照贴：等宽预格式化保住表格与缩进，不做 markdown 渲染也就不会改写它 */}
            <pre
              data-veil=""
              className="max-h-[60vh] overflow-auto text-[13px] leading-6 whitespace-pre-wrap text-ink"
            >
              {card.body}
            </pre>
            <p data-veil="" className="mt-2 text-[12.5px] leading-6 text-ink-2">
              存档卡 <span className="num">{card.id}</span> · 更新于{' '}
              <span className="num">{card.updated}</span> · 可信度 {card.confidence}
            </p>
            {card.sources.length > 0 && (
              <ul data-veil="" className="mt-1 flex flex-col gap-0.5">
                {card.sources.map((s) => (
                  <li key={s} className="text-[12.5px] leading-6 break-all text-ink-2">
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
