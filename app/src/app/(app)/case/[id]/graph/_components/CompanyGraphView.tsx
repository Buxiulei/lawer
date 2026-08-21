'use client';

import { useMemo, useState } from 'react';
import type { CompanyGraph } from '@/app/_mock/company-graph';
import { useDiscreet } from '@/app/_ui/discreet';
import { formatDate } from '@/app/_ui/format';
import {
  bandsOf,
  layoutCompanyGraph,
  type LayoutEdgeInput,
  type LayoutNodeInput,
} from '@/lib/graph/layout';
import { EmptyState } from '@/components/shadcn/empty-state';
import {
  EDGE_DASH,
  EDGE_KIND_LABEL,
  edgeKind,
  PAYROLL_CHAIN_WIDTH,
  TIER_RING,
  type EdgeKind,
} from './graphStyle';
import { GraphCanvas } from './GraphCanvas';
import { NodeSheet } from './NodeSheet';

/**
 * 发薪链的边标签。这条边的 relation 原文说的是品牌矩阵（还带一句"不作连带责任
 * 现成证据"），跟"加粗=发薪链"的视觉语义打架，边上只放它的结构身份，
 * relation 原文在抽屉的关联关系里逐字展示，信息不丢。
 */
const PAYROLL_CHAIN_LABEL = '签约壳↔用工主体';

const TIER_ORDER = [1, 2, 3] as const;
const EDGE_KIND_ORDER: EdgeKind[] = ['equity', 'control', 'brand'];

export function CompanyGraphView({ graph }: { graph: CompanyGraph | null }) {
  const { discreet } = useDiscreet();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { layout, payrollChain } = useMemo(() => {
    const nodes: LayoutNodeInput[] = (graph?.nodes ?? []).map((n) => ({
      id: n.id,
      eventCount: n.eventCount,
      litigationCount: n.litigationCount,
    }));
    const base: LayoutEdgeInput[] = (graph?.edges ?? []).map((e) => ({
      from: e.from,
      to: e.to,
      relation: e.relation,
    }));

    // 两端都落在主体层的边＝签约壳↔用工主体的发薪链，边上换成结构身份的标签
    const bands = bandsOf(nodes, base);
    const chain = new Set(
      base
        .filter(
          (e) => bands.get(e.from) === 'subject' && bands.get(e.to) === 'subject',
        )
        .map((e) => `${e.from}->${e.to}`),
    );

    return {
      payrollChain: chain,
      layout: layoutCompanyGraph(
        nodes,
        base.map((e) =>
          chain.has(`${e.from}->${e.to}`) ? { ...e, label: PAYROLL_CHAIN_LABEL } : e,
        ),
      ),
    };
  }, [graph]);

  const legendKinds = EDGE_KIND_ORDER.filter((kind) =>
    graph?.edges.some((e) => edgeKind(e.relation) === kind),
  );
  // 发薪链只改粗细不改线型，图例得照它本来的线型画，不然跟图上对不上
  const chainEdge = graph?.edges.find((e) => payrollChain.has(`${e.from}->${e.to}`));
  const legendTiers = TIER_ORDER.filter((tier) =>
    graph?.nodes.some((n) => n.tier === tier),
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
        payrollChain={payrollChain}
        selectedId={selectedId}
        onSelect={setSelectedId}
        discreet={discreet}
      />

      {/* 图例只列这份数据里真出现的样式，不声明没人用的线型 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] leading-6 text-ink-2">
        {legendKinds.map((kind) => (
          <LegendLine key={kind} label={EDGE_KIND_LABEL[kind]} dash={EDGE_DASH[kind]} />
        ))}
        {chainEdge && (
          <LegendLine
            label="发薪链"
            dash={EDGE_DASH[edgeKind(chainEdge.relation)]}
            width={PAYROLL_CHAIN_WIDTH}
          />
        )}
        {legendTiers.map((tier) => (
          <span key={tier} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`size-3 rounded-full border-2 ${TIER_RING[tier]}`} />
            {graph.meta.tiers[tier]}
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

function LegendLine({
  label,
  dash,
  width = 1.4,
}: {
  label: string;
  dash?: string;
  width?: number;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="26" height="8" aria-hidden className="shrink-0">
        <line
          x1="1"
          y1="4"
          x2="25"
          y2="4"
          stroke="var(--ink-2)"
          strokeWidth={width}
          strokeDasharray={dash}
        />
      </svg>
      {label}
    </span>
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
