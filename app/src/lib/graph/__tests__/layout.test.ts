import { describe, expect, it } from 'vitest';
import { mockCompanyGraph } from '@/app/_mock/company-graph';
import {
  boundingBox,
  layoutCompanyGraph,
  type LayoutEdgeInput,
  type LayoutNodeInput,
} from '../layout';

const NODES: LayoutNodeInput[] = mockCompanyGraph.nodes.map((n) => ({
  id: n.id,
  eventCount: n.eventCount,
  litigationCount: n.litigationCount,
}));
const EDGES: LayoutEdgeInput[] = mockCompanyGraph.edges.map((e) => ({
  from: e.from,
  to: e.to,
  relation: e.relation,
}));

function bandOfNode(id: string) {
  const layout = layoutCompanyGraph(NODES, EDGES);
  return layout.nodes.find((n) => n.id === id)!.band;
}

describe('layoutCompanyGraph', () => {
  it('控股股东在上、用工主体居中、品牌观察层沉底', () => {
    for (const id of ['hk_alpha', 'holder_c', 'person_zhang']) {
      expect(bandOfNode(id), id).toBe('control');
    }
    for (const id of ['shell_a', 'payroll_b', 'labor_f', 'leasing_g']) {
      expect(bandOfNode(id), id).toBe('subject');
    }
    for (const id of ['brand_d', 'brand_e']) {
      expect(bandOfNode(id), id).toBe('watch');
    }
  });

  it('带的先后顺序与纵坐标一致：控股层的 y 小于主体层、主体层小于观察层', () => {
    const { nodes } = layoutCompanyGraph(NODES, EDGES);
    const yOf = (band: string) =>
      Math.min(...nodes.filter((n) => n.band === band).map((n) => n.y));
    expect(yOf('control')).toBeLessThan(yOf('subject'));
    expect(yOf('subject')).toBeLessThan(yOf('watch'));
  });

  it('坐标全是有限数，画布尺寸能装下所有节点', () => {
    const layout = layoutCompanyGraph(NODES, EDGES);
    for (const n of layout.nodes) {
      for (const v of [n.x, n.y, n.cx, n.cy, n.width, n.height]) {
        expect(Number.isFinite(v), `${n.id} 坐标是 ${v}`).toBe(true);
      }
      expect(n.x + n.width).toBeLessThanOrEqual(layout.width);
      expect(n.y + n.height).toBeLessThanOrEqual(layout.height);
    }
    expect(layout.nodes).toHaveLength(NODES.length);
  });

  it('同一带内的卡片互不重叠', () => {
    const { nodes } = layoutCompanyGraph(NODES, EDGES);
    for (const a of nodes) {
      for (const b of nodes) {
        if (a === b || a.row !== b.row) continue;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width;
        expect(overlap, `${a.id} 与 ${b.id} 重叠`).toBe(false);
      }
    }
  });

  it('每条边都有不含 NaN 的贝塞尔路径，端点落在两头节点上', () => {
    const layout = layoutCompanyGraph(NODES, EDGES);
    expect(layout.edges).toHaveLength(EDGES.length);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));

    for (const e of layout.edges) {
      expect(e.path).toMatch(/^M [-\d.]+ [-\d.]+ Q [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+$/);
      expect(e.path).not.toContain('NaN');

      const [x0, y0] = e.path.split(' ').slice(1, 3).map(Number);
      const a = byId.get(e.from)!;
      expect(x0).toBeGreaterThanOrEqual(a.x - 1);
      expect(x0).toBeLessThanOrEqual(a.x + a.width + 1);
      expect(y0).toBeGreaterThanOrEqual(a.y - 1);
      expect(y0).toBeLessThanOrEqual(a.y + a.height + 1);
    }
  });

  it('连线不从别人的卡片上压过去（跨两带的走卡缝）', () => {
    const layout = layoutCompanyGraph(NODES, EDGES);

    for (const e of layout.edges) {
      const [x0, y0, cpx, cpy, x1, y1] = e.path
        .split(' ')
        .filter((tok) => tok !== 'M' && tok !== 'Q')
        .map(Number);

      for (let step = 1; step < 40; step++) {
        const t = step / 40;
        const u = 1 - t;
        const px = u * u * x0 + 2 * u * t * cpx + t * t * x1;
        const py = u * u * y0 + 2 * u * t * cpy + t * t * y1;
        const hit = layout.nodes.find(
          (n) =>
            n.id !== e.from &&
            n.id !== e.to &&
            px > n.x &&
            px < n.x + n.width &&
            py > n.y &&
            py < n.y + n.height,
        );
        expect(hit?.id, `${e.from}->${e.to} 压过 ${hit?.id}`).toBeUndefined();
      }
    }
  });

  it('边标签截到第一个括号，且不压在任何一张卡片上', () => {
    const layout = layoutCompanyGraph(NODES, EDGES);
    const labels = layout.edges.map((e) => e.label);
    expect(labels).toContain('持股100%');
    expect(labels).toContain('同一实控体系');
    expect(labels.some((l) => l.includes('('))).toBe(false);

    for (const e of layout.edges) {
      const half = e.labelWidth / 2;
      const covered = layout.nodes.some(
        (n) =>
          e.labelX + half > n.x &&
          e.labelX - half < n.x + n.width &&
          e.labelY + 8 > n.y &&
          e.labelY - 8 < n.y + n.height,
      );
      expect(covered, `${e.from}->${e.to} 的标签压住了节点`).toBe(false);
    }
  });

  it('孤立节点也排得进去，指向不存在节点的边被丢掉', () => {
    const layout = layoutCompanyGraph(
      [
        { id: 'lonely', eventCount: 0, litigationCount: 0 },
        { id: 'busy', eventCount: 0, litigationCount: 3 },
      ],
      [
        { from: 'busy', to: 'ghost', relation: '持股100%' },
        { from: 'busy', to: 'busy', relation: '自环' },
      ],
    );
    expect(layout.edges).toHaveLength(0);
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(['busy', 'lonely']);
    expect(layout.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(
      true,
    );
  });

  it('空图不炸，返回可用的空画布', () => {
    const layout = layoutCompanyGraph([], []);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(Number.isFinite(layout.width)).toBe(true);
    expect(Number.isFinite(layout.height)).toBe(true);
    expect(boundingBox([], 24)).toBeNull();
  });

  it('同一份输入两次布局结果一致（减交叉不引入随机性）', () => {
    expect(layoutCompanyGraph(NODES, EDGES)).toEqual(layoutCompanyGraph(NODES, EDGES));
  });

  it('圈1 包围盒把目标主体都框进去并留出边距', () => {
    const layout = layoutCompanyGraph(NODES, EDGES);
    const tier1 = new Set(
      mockCompanyGraph.nodes.filter((n) => n.tier === 1).map((n) => n.id),
    );
    const focus = layout.nodes.filter((n) => tier1.has(n.id));
    const box = boundingBox(focus, 24)!;

    for (const n of focus) {
      expect(n.x).toBeGreaterThanOrEqual(box.x);
      expect(n.x + n.width).toBeLessThanOrEqual(box.x + box.width);
      expect(n.y).toBeGreaterThanOrEqual(box.y);
      expect(n.y + n.height).toBeLessThanOrEqual(box.y + box.height);
    }
    expect(box.width).toBeLessThan(layout.width);
  });
});
