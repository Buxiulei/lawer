/**
 * 公司关系图谱的分层布局：图 → 坐标的纯函数，不碰 DOM，可单测。
 *
 * 三条带（从上到下）照关系链的方向读：谁控着谁在上，被追责的用工主体居中，
 * 只有品牌关联、没有法律关联证据的观察对象沉底。带内用重心法（barycenter）
 * 迭代排序减少连线交叉。
 */

export type GraphBand = 'control' | 'subject' | 'watch';

export interface LayoutNodeInput {
  id: string;
  eventCount: number;
  litigationCount: number;
}

export interface LayoutEdgeInput {
  from: string;
  to: string;
  relation: string;
}

export interface PositionedNode {
  id: string;
  band: GraphBand;
  /** 第几条带，0 在最上 */
  row: number;
  /** 带内第几个，0 在最左 */
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
}

export interface PositionedEdge {
  from: string;
  to: string;
  /** 二次贝塞尔的 d 属性 */
  path: string;
  /** relation 的短标签（截到第一个括号） */
  label: string;
  labelX: number;
  labelY: number;
  /** 估算的标签底宽，画的时候拿它铺一块底避让线条 */
  labelWidth: number;
  /** 同带内的横向连线，画法与跨带的不同 */
  sameRow: boolean;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: PositionedNode[];
  edges: PositionedEdge[];
}

export const NODE_W = 184;
export const NODE_H = 92;
/** 卡间距要留够一条曲线穿过去的宽度，跨带的边就靠这些缝走 */
const COL_GAP = 48;
const ROW_GAP = 136;
const PADDING = 40;
/** 同带横线向下鼓出的高度：弧顶要落到卡片下沿以外，标签才不压脸 */
const SAME_ROW_BOW = 120;
/** 跨带曲线的侧鼓系数，越大弯得越厉害 */
const BOW_K = 0.07;
const LABEL_FONT_PX = 11;
const BAND_ORDER: GraphBand[] = ['control', 'subject', 'watch'];
const CROSSING_PASSES = 4;

/**
 * 节点归带：
 * - 没有下游、也没有涉诉/事件痕迹的（含完全孤立的）＝观察层，沉底；
 * - 只出不进的＝控股/实控层，置顶；
 * - 其余（被人持股或实控、且真的在用工或涉诉的）＝主体层，居中。
 */
function bandOf(
  node: LayoutNodeInput,
  hasIn: boolean,
  hasOut: boolean,
): GraphBand {
  if (!hasOut && node.litigationCount === 0 && node.eventCount === 0) return 'watch';
  if (!hasIn) return 'control';
  return 'subject';
}

/** 短标签：截到第一个括号，再超长就省略——边上只放一眼能读完的词 */
function shortLabel(relation: string): string {
  const head = relation.split(/[(（]/)[0].trim();
  const text = head || relation;
  return text.length > 10 ? `${text.slice(0, 9)}…` : text;
}

/** 中英混排的粗略宽度，够用来判断标签会不会压到节点 */
function labelWidthOf(text: string): number {
  let w = 0;
  for (const ch of text) w += /[一-鿿＀-￯]/.test(ch) ? LABEL_FONT_PX : LABEL_FONT_PX * 0.56;
  return Math.round(w) + 12;
}

function bandRows(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
): { rows: string[][]; bands: GraphBand[] } {
  const ids = new Set(nodes.map((n) => n.id));
  const kept = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const hasIn = new Set(kept.map((e) => e.to));
  const hasOut = new Set(kept.map((e) => e.from));

  const buckets = new Map<GraphBand, string[]>(BAND_ORDER.map((b) => [b, []]));
  for (const node of nodes) {
    buckets.get(bandOf(node, hasIn.has(node.id), hasOut.has(node.id)))!.push(node.id);
  }

  const bands = BAND_ORDER.filter((b) => buckets.get(b)!.length > 0);
  return { rows: bands.map((b) => buckets.get(b)!), bands };
}

/** 一种排法下的连线交叉数，只数两端落在同一对带之间的边 */
function countCrossings(rows: string[][], edges: LayoutEdgeInput[]): number {
  const col = new Map<string, number>();
  const rowOf = new Map<string, number>();
  rows.forEach((row, r) => row.forEach((id, i) => (col.set(id, i), rowOf.set(id, r))));

  let total = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [e1, e2] = [edges[i], edges[j]];
      if (rowOf.get(e1.from) !== rowOf.get(e2.from)) continue;
      if (rowOf.get(e1.to) !== rowOf.get(e2.to)) continue;
      const top = col.get(e1.from)! - col.get(e2.from)!;
      const bottom = col.get(e1.to)! - col.get(e2.to)!;
      if (top * bottom < 0) total++;
    }
  }
  return total;
}

/**
 * 重心法减交叉：把每一带按相邻带里邻居的平均位置重排，上下交替扫，
 * 每扫完记一次交叉数，最后取最好的那一版——重心法会来回震荡，
 * 不留最优就可能停在差的那一相位上。
 */
function reduceCrossings(rows: string[][], edges: LayoutEdgeInput[]): string[][] {
  const neighbors = new Map<string, string[]>();
  const push = (a: string, b: string) => {
    const list = neighbors.get(a);
    if (list) list.push(b);
    else neighbors.set(a, [b]);
  };
  for (const e of edges) {
    push(e.from, e.to);
    push(e.to, e.from);
  }

  const rowOf = new Map<string, number>();
  rows.forEach((row, r) => row.forEach((id) => rowOf.set(id, r)));

  let current = rows.map((row) => [...row]);
  let best = current.map((row) => [...row]);
  let bestScore = countCrossings(best, edges);

  for (let pass = 0; pass < CROSSING_PASSES; pass++) {
    const order =
      pass % 2 === 0
        ? current.map((_, r) => r)
        : current.map((_, r) => current.length - 1 - r);

    for (const r of order) {
      // 每排完一带就重算列号（Gauss-Seidel），本轮后面的带用得上刚排好的结果
      const col = new Map<string, number>();
      current.forEach((row) => row.forEach((id, i) => col.set(id, i)));
      // sort 是稳定的：没有跨带邻居的节点用自己当前位置当键，原地不动
      const key = (id: string): number => {
        const cross = (neighbors.get(id) ?? []).filter((n) => rowOf.get(n) !== r);
        if (cross.length === 0) return col.get(id)!;
        return cross.reduce((sum, n) => sum + (col.get(n) ?? 0), 0) / cross.length;
      };
      current[r] = [...current[r]].sort((a, b) => key(a) - key(b));
    }

    const score = countCrossings(current, edges);
    if (score < bestScore) {
      bestScore = score;
      best = current.map((row) => [...row]);
    }
  }
  return best;
}

/** 端口：多条边接同一个节点时沿上/下边分开落点，不都挤在正中间 */
function portX(center: number, index: number, total: number): number {
  if (total <= 1) return center;
  const spread = Math.min(36, (NODE_W - 24) / (total - 1));
  return center + (index - (total - 1) / 2) * spread;
}

/** 标签盒的半高，判重叠用 */
const LABEL_HALF_H = 9;
/** 挤在一起时上下错开的候选量，第一档 0 表示原位 */
const LABEL_NUDGES = [0, -20, 20, -40, 40];

/**
 * 标签互不遮挡：同一道空隙里横向撞车的标签上下错开。
 * 落点本来就锚在带间空隙里，错开幅度不出空隙，所以不会撞到卡片。
 */
function separateLabels(
  edges: { labelX: number; labelY: number; labelWidth: number }[],
): void {
  const taken: { x0: number; x1: number; y: number }[] = [];

  for (const e of [...edges].sort((a, b) => a.labelX - b.labelX)) {
    const x0 = e.labelX - e.labelWidth / 2;
    const x1 = e.labelX + e.labelWidth / 2;
    const clash = (y: number) =>
      taken.some(
        (t) => x1 > t.x0 && x0 < t.x1 && Math.abs(y - t.y) < LABEL_HALF_H * 2,
      );

    const y = LABEL_NUDGES.map((d) => e.labelY + d).find((cand) => !clash(cand));
    e.labelY = round(y ?? e.labelY);
    taken.push({ x0, x1, y: e.labelY });
  }
}

export function layoutCompanyGraph(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
): GraphLayout {
  if (nodes.length === 0) {
    return { width: PADDING * 2, height: PADDING * 2, nodes: [], edges: [] };
  }

  const ids = new Set(nodes.map((n) => n.id));
  const kept = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);

  const { rows: initial, bands } = bandRows(nodes, kept);
  const rows = reduceCrossings(initial, kept);

  const rowWidths = rows.map((row) => row.length * NODE_W + (row.length - 1) * COL_GAP);
  const maxWidth = Math.max(...rowWidths);

  const placed: PositionedNode[] = [];
  const byId = new Map<string, PositionedNode>();
  rows.forEach((row, r) => {
    const left = PADDING + (maxWidth - rowWidths[r]) / 2;
    const y = PADDING + r * (NODE_H + ROW_GAP);
    row.forEach((id, c) => {
      const x = left + c * (NODE_W + COL_GAP);
      const node: PositionedNode = {
        id,
        band: bands[r],
        row: r,
        col: c,
        x,
        y,
        width: NODE_W,
        height: NODE_H,
        cx: x + NODE_W / 2,
        cy: y + NODE_H / 2,
      };
      placed.push(node);
      byId.set(id, node);
    });
  });

  // 端口分配：先按对端横坐标排序，同一条边在两头拿到互不交叉的落点
  const outPorts = new Map<string, string[]>();
  const inPorts = new Map<string, string[]>();
  const edgeKey = (e: LayoutEdgeInput) => `${e.from}->${e.to}`;
  const addPort = (map: Map<string, string[]>, id: string, key: string) => {
    const list = map.get(id);
    if (list) list.push(key);
    else map.set(id, [key]);
  };
  for (const e of kept) {
    if (byId.get(e.from)!.row === byId.get(e.to)!.row) continue;
    addPort(outPorts, e.from, edgeKey(e));
    addPort(inPorts, e.to, edgeKey(e));
  }
  const sortByPeer = (list: string[], peer: (key: string) => string) =>
    list.sort((k1, k2) => byId.get(peer(k1))!.cx - byId.get(peer(k2))!.cx);
  outPorts.forEach((list) => sortByPeer(list, (k) => k.split('->')[1]));
  inPorts.forEach((list) => sortByPeer(list, (k) => k.split('->')[0]));

  // 跨两带的边要从中间那排的卡缝里穿过去，不能从卡片脸上压过
  const gapsByRow = rows.map((row) => {
    const cards = row.map((id) => byId.get(id)!);
    const gaps = [cards[0].x - COL_GAP];
    for (let i = 1; i < cards.length; i++) {
      gaps.push((cards[i - 1].x + cards[i - 1].width + cards[i].x) / 2);
    }
    const last = cards[cards.length - 1];
    gaps.push(last.x + last.width + COL_GAP);
    return gaps;
  });
  const rowCenterY = (r: number) => PADDING + r * (NODE_H + ROW_GAP) + NODE_H / 2;

  const laidEdges: RawEdge[] = kept.map((e) => {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const label = shortLabel(e.relation);
    const labelWidth = labelWidthOf(label);
    const sameRow = a.row === b.row;

    let x0: number;
    let y0: number;
    let x1: number;
    let y1: number;
    let cpx: number;
    let cpy: number;

    if (sameRow) {
      // 同带：从两张卡的下沿走一道浅弧兜到带下方，不从卡脸上横穿
      x0 = a.cx;
      y0 = a.y + a.height;
      x1 = b.cx;
      y1 = b.y + b.height;
      cpx = (x0 + x1) / 2;
      cpy = y0 + SAME_ROW_BOW;
    } else {
      const down = a.row < b.row;
      const outList = outPorts.get(e.from) ?? [];
      const inList = inPorts.get(e.to) ?? [];
      const key = edgeKey(e);
      const sx = portX(a.cx, Math.max(0, outList.indexOf(key)), outList.length);
      const tx = portX(b.cx, Math.max(0, inList.indexOf(key)), inList.length);
      x0 = sx;
      y0 = down ? a.y + a.height : a.y;
      x1 = tx;
      y1 = down ? b.y - 5 : b.y + b.height + 5;
      const span = Math.abs(a.row - b.row);
      if (span > 1) {
        // 让曲线在 t=0.5 正好落在中间那排的某条卡缝上：cp = 2P − (P0+P2)/2。
        // 从最近的缝试起，缝太窄兜不住就往外挪一条，实在不行走最外侧那条道。
        const midRow = Math.min(a.row, b.row) + Math.floor(span / 2);
        const py = rowCenterY(midRow);
        const straightX = x0 + ((py - y0) / (y1 - y0)) * (x1 - x0);
        const blockers = placed.filter((n) => n.id !== e.from && n.id !== e.to);
        const candidates = [...gapsByRow[midRow]].sort(
          (g1, g2) => Math.abs(g1 - straightX) - Math.abs(g2 - straightX),
        );
        const control = (gapX: number) => ({
          x: 2 * gapX - (x0 + x1) / 2,
          y: 2 * py - (y0 + y1) / 2,
        });
        const pick =
          candidates.find((g) => {
            const cp = control(g);
            return clearsCards(x0, y0, cp.x, cp.y, x1, y1, blockers);
          }) ?? candidates[candidates.length - 1];
        ({ x: cpx, y: cpy } = control(pick));
      } else {
        // 弦的法线方向鼓一点：竖直边几乎是直的，斜边弯开，平行边不重叠
        const dx = x1 - x0;
        const dy = y1 - y0;
        cpx = (x0 + x1) / 2 - dy * BOW_K;
        cpy = (y0 + y1) / 2 + dx * BOW_K;
      }
    }

    // 标签落点：同带走弧顶；跨带的锚到第一道带间空隙——跨两带的边中点正好
    // 压在中间那排卡片上，锚到空隙里才不用硬躲。
    const anchorY = sameRow
      ? undefined
      : (a.row < b.row ? a.y + a.height : b.y + b.height) + ROW_GAP / 2;
    const t = anchorY === undefined ? 0.5 : (solveT(y0, cpy, y1, anchorY) ?? 0.5);

    return {
      from: e.from,
      to: e.to,
      x0,
      y0,
      cpx,
      cpy,
      x1,
      y1,
      label,
      labelX: bezierAt(x0, cpx, x1, t),
      labelY: bezierAt(y0, cpy, y1, t),
      labelWidth,
      sameRow,
    };
  });

  separateLabels(laidEdges);
  return frame(placed, laidEdges);
}

interface RawEdge extends Omit<PositionedEdge, 'path'> {
  x0: number;
  y0: number;
  cpx: number;
  cpy: number;
  x1: number;
  y1: number;
}

/**
 * 画布按真正画出来的东西定尺寸：绕道的曲线会甩到卡片阵列外面，
 * 光按卡片算画布会把它们裁掉。算完整包围盒再整体平移回留白内。
 */
function frame(nodes: PositionedNode[], edges: RawEdge[]): GraphLayout {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  for (const n of nodes) {
    grow(n.x, n.y);
    grow(n.x + n.width, n.y + n.height);
  }
  for (const e of edges) {
    for (let step = 0; step <= 20; step++) {
      const t = step / 20;
      grow(bezierAt(e.x0, e.cpx, e.x1, t), bezierAt(e.y0, e.cpy, e.y1, t));
    }
    grow(e.labelX - e.labelWidth / 2, e.labelY - LABEL_HALF_H);
    grow(e.labelX + e.labelWidth / 2, e.labelY + LABEL_HALF_H);
  }

  const dx = PADDING - minX;
  const dy = PADDING - minY;

  for (const n of nodes) {
    n.x = round(n.x + dx);
    n.y = round(n.y + dy);
    n.cx = round(n.cx + dx);
    n.cy = round(n.cy + dy);
  }

  return {
    width: round(maxX - minX + PADDING * 2),
    height: round(maxY - minY + PADDING * 2),
    nodes,
    edges: edges.map((e) => ({
      from: e.from,
      to: e.to,
      path: `M ${round(e.x0 + dx)} ${round(e.y0 + dy)} Q ${round(e.cpx + dx)} ${round(e.cpy + dy)} ${round(e.x1 + dx)} ${round(e.y1 + dy)}`,
      label: e.label,
      labelX: round(e.labelX + dx),
      labelY: round(e.labelY + dy),
      labelWidth: e.labelWidth,
      sameRow: e.sameRow,
    })),
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 采样判断一条二次贝塞尔有没有从这些卡片上压过去，留 6px 余量 */
function clearsCards(
  x0: number,
  y0: number,
  cpx: number,
  cpy: number,
  x1: number,
  y1: number,
  cards: PositionedNode[],
): boolean {
  const MARGIN = 6;
  for (let step = 0; step <= 60; step++) {
    const t = step / 60;
    const px = bezierAt(x0, cpx, x1, t);
    const py = bezierAt(y0, cpy, y1, t);
    const hit = cards.some(
      (n) =>
        px > n.x - MARGIN &&
        px < n.x + n.width + MARGIN &&
        py > n.y - MARGIN &&
        py < n.y + n.height + MARGIN,
    );
    if (hit) return false;
  }
  return true;
}

function bezierAt(p0: number, p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

/** 二次贝塞尔上取到指定纵坐标的 t，取不到就返回 null */
function solveT(p0: number, p1: number, p2: number, target: number): number | null {
  const a = p0 - 2 * p1 + p2;
  const b = 2 * (p1 - p0);
  const c = p0 - target;
  const inRange = (t: number) => (t >= 0 && t <= 1 ? t : null);

  if (Math.abs(a) < 1e-6) return b === 0 ? null : inRange(-c / b);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  return inRange((-b + root) / (2 * a)) ?? inRange((-b - root) / (2 * a));
}

/** 圈1 子图的包围盒：小屏进来先聚焦这一块 */
export function boundingBox(
  nodes: PositionedNode[],
  padding: number,
): { x: number; y: number; width: number; height: number } | null {
  if (nodes.length === 0) return null;
  const x0 = Math.min(...nodes.map((n) => n.x)) - padding;
  const y0 = Math.min(...nodes.map((n) => n.y)) - padding;
  const x1 = Math.max(...nodes.map((n) => n.x + n.width)) + padding;
  const y1 = Math.max(...nodes.map((n) => n.y + n.height)) + padding;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
