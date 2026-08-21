'use client';

import { useMemo, useState } from 'react';
import type { CompanyGraph } from '@/app/_mock/company-graph';
import { useDiscreet } from '@/app/_ui/discreet';
import { formatDate } from '@/app/_ui/format';
import { layoutCompanyGraph } from '@/lib/graph/layout';
import { EmptyState } from '@/components/shadcn/empty-state';
import { GraphCanvas } from './GraphCanvas';
import { NodeSheet } from './NodeSheet';

/** 图例里的线型示意，与画布上的线一套画法 */
const LEGEND: { label: string; dash?: string; width?: number }[] = [
  { label: '股权/持股', width: 1.4 },
  { label: '同法代/实控', dash: '7 5', width: 1.4 },
  { label: '品牌/分支关联', dash: '2 5', width: 1.4 },
  { label: '发薪链', width: 2.6 },
];

const TIER_DOT = [
  { tier: 1, cls: 'border-danger', label: '圈1' },
  { tier: 2, cls: 'border-amber', label: '圈2' },
  { tier: 3, cls: 'border-line', label: '圈3' },
];

export function CompanyGraphView({ graph }: { graph: CompanyGraph | null }) {
  const { discreet } = useDiscreet();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const layout = useMemo(
    () =>
      layoutCompanyGraph(
        graph?.nodes.map((n) => ({
          id: n.id,
          eventCount: n.eventCount,
          litigationCount: n.litigationCount,
        })) ?? [],
        graph?.edges.map((e) => ({ from: e.from, to: e.to, relation: e.relation })) ?? [],
      ),
    [graph],
  );

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="pt-1">
        <Header />
        <EmptyState
          title="公司调查完成后这里会生成关系图谱"
          description="调查会把签约主体、发薪主体、控股股东和同体系的用工主体串起来，标出谁有钱可执行、谁是追责主战场。"
        />
      </div>
    );
  }

  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="pt-1">
      <Header />

      <GraphCanvas
        graph={graph}
        layout={layout}
        selectedId={selectedId}
        onSelect={setSelectedId}
        discreet={discreet}
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] leading-6 text-ink-2">
        {LEGEND.map((item) => (
          <span key={item.label} className="inline-flex items-center gap-1.5">
            <svg width="26" height="8" aria-hidden className="shrink-0">
              <line
                x1="1"
                y1="4"
                x2="25"
                y2="4"
                stroke="var(--ink-2)"
                strokeWidth={item.width}
                strokeDasharray={item.dash}
              />
            </svg>
            {item.label}
          </span>
        ))}
        {TIER_DOT.map((t) => (
          <span key={t.tier} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`size-3 rounded-full border-2 ${t.cls}`} />
            {graph.meta.tiers[t.tier as 1 | 2 | 3]}
          </span>
        ))}
      </div>

      <p className="prose-measure mt-3 text-[13px] leading-6 text-ink-2">
        点卡片看这家为什么这样标；捏合或滚轮缩放、拖动平移，双击复位。
      </p>
      <p className="prose-measure num mt-1 text-[13px] leading-6 text-ink-2">
        更新于 {formatDate(graph.meta.updated)} · {graph.meta.source}
      </p>

      <NodeSheet
        graph={graph}
        node={selected}
        onClose={() => setSelectedId(null)}
        onSelect={setSelectedId}
      />
    </div>
  );
}

function Header() {
  return (
    <header className="py-3">
      <h1 className="text-[20px] font-semibold text-ink">公司图谱</h1>
      <p className="prose-measure mt-0.5 text-[15px] leading-7 text-ink-2">
        跟你签合同的、给你发工资的、背后控股的，常常不是同一家。这张图把它们的关系摆开，
        方便你决定告谁、向谁要钱。
      </p>
    </header>
  );
}
