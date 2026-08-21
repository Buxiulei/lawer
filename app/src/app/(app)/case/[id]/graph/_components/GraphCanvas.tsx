'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CompanyGraph, GraphNode } from '@/app/_mock/company-graph';
import { boundingBox, type GraphLayout, type PositionedNode } from '@/lib/graph/layout';
import { cn } from '@/app/_ui/cn';
import { Button } from '@/components/shadcn/button';
import { edgeDash, hasArrow, TIER_RING } from './graphStyle';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
/** 小屏进来先只看圈1，包围盒往外留这么多 */
const FOCUS_PADDING = 28;
/** 按下后移动超过这个距离才算拖动，否则算点击节点 */
const DRAG_SLOP = 4;
const DOUBLE_TAP_MS = 320;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 把一块内容装进画布：短边留白，长边贴边 */
function fitBox(
  box: { x: number; y: number; width: number; height: number },
  rect: { width: number; height: number },
): Box {
  const aspect = rect.height / rect.width;
  const w = Math.max(box.width, box.height / aspect);
  const h = w * aspect;
  return {
    x: box.x + box.width / 2 - w / 2,
    y: box.y + box.height / 2 - h / 2,
    w,
    h,
  };
}

export function GraphCanvas({
  graph,
  layout,
  selectedId,
  onSelect,
  discreet,
}: {
  graph: CompanyGraph;
  layout: GraphLayout;
  selectedId: string | null;
  onSelect: (id: string) => void;
  discreet: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<Box>({ x: 0, y: 0, w: layout.width, h: layout.height });
  const viewRef = useRef(view);
  viewRef.current = view;

  /** 全图视野的宽度，缩放倍数以它为 1x */
  const baseW = useRef(layout.width);
  const initialView = useRef<Box | null>(null);

  const nodeById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph.nodes],
  );
  const urgentIds = useMemo(
    () => new Set(graph.events.filter((e) => e.urgent).map((e) => e.nodeId)),
    [graph.events],
  );
  const lowConfidence = useMemo(
    () =>
      new Set(
        graph.edges.filter((e) => e.confidence === '低').map((e) => `${e.from}->${e.to}`),
      ),
    [graph.edges],
  );
  const relationOf = useMemo(
    () => new Map(graph.edges.map((e) => [`${e.from}->${e.to}`, e.relation])),
    [graph.edges],
  );
  /** 发薪链：签约壳与用工主体在同一带里的那条横线，加粗 */
  const isPayrollChain = useCallback(
    (from: string, sameRow: boolean) =>
      sameRow && layout.nodes.find((n) => n.id === from)?.band === 'subject',
    [layout.nodes],
  );

  const focusBox = useMemo(() => {
    const tier1 = layout.nodes.filter((n) => nodeById.get(n.id)?.tier === 1);
    return boundingBox(tier1, FOCUS_PADDING);
  }, [layout.nodes, nodeById]);

  const fullBox = useMemo(
    () => ({ x: 0, y: 0, width: layout.width, height: layout.height }),
    [layout.width, layout.height],
  );

  const showAll = useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setView(fitBox(fullBox, rect));
  }, [fullBox]);

  const resetView = useCallback(() => {
    if (initialView.current) setView(initialView.current);
  }, []);

  // 初始视野：小屏先聚焦圈1子图，宽屏直接给全图
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;

    const apply = () => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const full = fitBox(fullBox, rect);
      baseW.current = full.w;
      const narrow = window.matchMedia('(max-width: 639px)').matches;
      const target = narrow && focusBox ? fitBox(focusBox, rect) : full;
      initialView.current = target;
      setView(target);
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fullBox, focusBox]);

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setView((v) => {
      const min = baseW.current / MAX_ZOOM;
      const max = baseW.current / MIN_ZOOM;
      const w = Math.min(max, Math.max(min, v.w / factor));
      const k = w / v.w;
      const px = v.x + ((clientX - rect.left) / rect.width) * v.w;
      const py = v.y + ((clientY - rect.top) / rect.height) * v.h;
      return { x: px - (px - v.x) * k, y: py - (py - v.y) * k, w, h: v.h * k };
    });
  }, []);

  // 滚轮缩放要挡掉页面滚动，React 的 onWheel 是被动监听，只能自己挂
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  /* ── 拖拽平移 + 双指捏合 ─────────────────────────────────── */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; view: Box; moved: boolean } | null>(null);
  const pinchDist = useRef(0);
  const lastTap = useRef(0);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const points = [...pointers.current.values()];
    if (points.length === 2) {
      drag.current = null;
      pinchDist.current = Math.hypot(
        points[0].x - points[1].x,
        points[0].y - points[1].y,
      );
    } else if (points.length === 1) {
      drag.current = { x: e.clientX, y: e.clientY, view: viewRef.current, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const points = [...pointers.current.values()];

    if (points.length >= 2) {
      const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (pinchDist.current > 0 && dist > 0) {
        zoomAt(
          (points[0].x + points[1].x) / 2,
          (points[0].y + points[1].y) / 2,
          dist / pinchDist.current,
        );
      }
      pinchDist.current = dist;
      return;
    }

    const start = drag.current;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!start || !rect?.width) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!start.moved) {
      // 抓起来之前不夺走指针，否则节点上的点击会被吃掉
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      start.moved = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // 指针已经不在了（松手与移动挤在一帧）：不捕获也能继续跟着拖
      }
    }
    setView((v) => ({
      ...v,
      x: start.view.x - (dx / rect.width) * v.w,
      y: start.view.y - (dy / rect.height) * v.h,
    }));
  };

  const endPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchDist.current = 0;
    if (pointers.current.size === 0) {
      const tapped = drag.current && !drag.current.moved;
      drag.current = null;
      // 双触复位：触屏没有 dblclick，两次快速点空白当复位
      if (tapped && e.pointerType !== 'mouse') {
        const now = Date.now();
        if (now - lastTap.current < DOUBLE_TAP_MS) resetView();
        lastTap.current = now;
      }
    }
  };

  const zoom = baseW.current / view.w;

  // 画布按 3:2 走：图本身是横的，手机上给个竖长的框会把图挤成中间一小条
  return (
    <div>
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className="aspect-3/2 max-h-[560px] w-full touch-none rounded-[12px] border border-line bg-surface"
        role="img"
        aria-label={`公司关系图谱，${graph.nodes.length} 个主体、${graph.edges.length} 条关系。图中每张卡片都可以用 Tab 键选中、回车打开详情。`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={resetView}
      >
        <defs>
          <marker
            id="graph-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill="var(--ink-2)" />
          </marker>
        </defs>

        {layout.edges.map((e) => {
          const key = `${e.from}->${e.to}`;
          const relation = relationOf.get(key) ?? '';
          const low = lowConfidence.has(key);
          const bold = isPayrollChain(e.from, e.sameRow);
          const labelText = low ? `${e.label} · 低` : e.label;
          const boxWidth = e.labelWidth + (low ? 24 : 0);

          return (
            <g key={key} opacity={low ? 0.45 : 1}>
              <path
                d={e.path}
                fill="none"
                stroke="var(--ink-2)"
                strokeWidth={bold ? 2.6 : 1.4}
                strokeDasharray={edgeDash(relation)}
                markerEnd={hasArrow(relation) ? 'url(#graph-arrow)' : undefined}
              />
              <rect
                x={e.labelX - boxWidth / 2}
                y={e.labelY - 9}
                width={boxWidth}
                height={18}
                rx={5}
                fill="var(--bg)"
              />
              <text
                x={e.labelX}
                y={e.labelY}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={11}
                fill="var(--ink-2)"
              >
                {labelText}
              </text>
            </g>
          );
        })}

        {layout.nodes.map((pos) => {
          const node = nodeById.get(pos.id);
          if (!node) return null;
          return (
            <NodeCard
              key={pos.id}
              pos={pos}
              node={node}
              urgent={urgentIds.has(pos.id)}
              selected={selectedId === pos.id}
              discreet={discreet}
              onSelect={onSelect}
            />
          );
        })}
      </svg>

      {/* 控件放画布外：390 宽下浮在图上会正好压住右上角那张卡 */}
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="num text-[12px] text-ink-2">{zoom.toFixed(1)}x</span>
        <Button variant="outline" size="sm" onClick={showAll}>
          看全图
        </Button>
      </div>
    </div>
  );
}

/**
 * 节点卡用 foreignObject 装一个真的 <button>：Tab 走位、回车打开、焦点圈
 * 都跟页面其它按钮一套，不用在 SVG 里另造一套键盘行为。
 */
function NodeCard({
  pos,
  node,
  urgent,
  selected,
  discreet,
  onSelect,
}: {
  pos: PositionedNode;
  node: GraphNode;
  urgent: boolean;
  selected: boolean;
  discreet: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <g>
      {urgent && (
        <rect
          className="graph-pulse"
          x={pos.x - 6}
          y={pos.y - 6}
          width={pos.width + 12}
          height={pos.height + 12}
          rx={16}
          fill="none"
          stroke="var(--danger)"
          strokeWidth={2}
        />
      )}
      <foreignObject x={pos.x} y={pos.y} width={pos.width} height={pos.height}>
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          aria-label={`${node.name}，${node.role}`}
          className={cn(
            'flex h-full w-full flex-col justify-center gap-1 rounded-[12px] border-2 bg-surface px-3 py-2 text-left shadow-soft transition-colors duration-150 ease-out hover:bg-muted',
            TIER_RING[node.tier],
            selected && 'ring-2 ring-primary ring-offset-2 ring-offset-bg',
          )}
        >
          <span
            className={cn(
              'line-clamp-2 text-[13px] leading-[17px] font-semibold text-ink',
              // 可点的元素上只打码不接管点按：点按要留给「打开详情」，
              // 名称与信用代码在抽屉里点一下临时显示（同 DataTable 的规矩）
              discreet && 'discreet-blur',
            )}
          >
            {node.name}
          </span>
          <span
            className={cn(
              'truncate text-[11px] leading-4 text-ink-2',
              discreet && 'discreet-blur',
            )}
          >
            {node.role}
          </span>
          <span className="num flex items-center gap-2 text-[11px] leading-4 text-ink-2">
            <span>
              近期 <span className="font-semibold text-ink">{node.eventCount}</span>
            </span>
            <span aria-hidden className="text-line">
              |
            </span>
            <span>
              涉诉{' '}
              <span
                className={cn(
                  'font-semibold',
                  node.litigationCount > 0 ? 'text-danger-ink' : 'text-ink',
                )}
              >
                {node.litigationCount}
              </span>
            </span>
          </span>
        </button>
      </foreignObject>
    </g>
  );
}
