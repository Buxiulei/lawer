// app/src/lib/graph/contract.ts
// 公司关系图谱的**响应契约**：GET /api/v1/cases/:id/company-graph 的形状。
//
// 【为什么类型从 _mock 挪到这里】原来这些接口住在 app/_mock/company-graph.ts，
// 文件头自述「结构即 API 的响应形状」——那是一句靠人记住的话。真后端落地后
// 会有两个写入方（demo mock 与 lib/graph/build），一句注释拦不住它们各自漂移。
// 类型挪到 lib 里、mock 反过来引它，「形状只有一处」就从约定变成编译期事实。
// _mock/company-graph.ts 原样 re-export，既有 import 路径一个不改。

export type GraphTier = 1 | 2 | 3;

export interface GraphNode {
  id: string;
  name: string;
  /** 这家在本案里扮演什么，如「现用人单位/目标主体」 */
  role: string;
  /** 监控圈层，文案见 meta.tiers */
  tier: GraphTier;
  /** 近期事件条数 */
  eventCount: number;
  /** 涉诉计数：已入档的劳动争议条目数（不按年限截断，理由见 build.ts） */
  litigationCount: number;
  creditCode?: string;
  legalRep?: string;
  regCapital?: string;
  /** 为什么这样标——调查员的自解释判断原文，展示时不改写 */
  note: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** 关系原文，如「持股100%(法人独资)」 */
  relation: string;
  confidence: '高' | '中' | '低';
  evidenceUrl?: string;
  note?: string;
}

export interface GraphEvent {
  id: string;
  nodeId: string;
  happenedAt: string;
  kind: string;
  urgent: boolean;
  title: string;
  detail: string;
}

export interface CompanyGraph {
  meta: {
    generated: string;
    updated: string;
    source: string;
    confidenceNote: string;
    updateNote: string;
    /** 圈层文案，键是 tier */
    tiers: Record<GraphTier, string>;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  events: GraphEvent[];
}

/**
 * 圈层文案的唯一事实源。
 *
 * 图例（CompanyGraphView）与抽屉（NodeSheet）都读 `meta.tiers`，所以只要写入方
 * 给的是同一份字典，界面就说得一致。demo mock 里另有一份同样的字面量——
 * 那份是演示叙事的一部分不动它，改由 __tests__/tier-labels 咬住两边逐字相等：
 * 漂了会红，而不是等到用户在演示里看见「圈2·每周看一次」、在真数据里看见别的说法。
 *
 * 【为什么这三句里没有「监控」二字】原文是「圈1·每日监控 / 圈2·每周监控 /
 * 圈3·仅快照存档不监控」。这三句直接印在图例和节点抽屉的徽标上，而那两处**都不在**
 * data-veil/Sensitive 的遮蔽范围内——低调模式下整页正文糊着，这三个徽标照常明文可读，
 * 旁人一眼看得出这台手机在盯着谁。口径同 WatchEntry 与 lib/notify/copy 的守望计费通知：
 * **两种模式同一句**，而不是给低调模式另写一版（一句话两个版本，漂了没有任何一处会报错）。
 * 所以换的是这唯一事实源本身，换完明文模式也照样说得通——圈层本来就是"我们多久看一次"。
 */
export const GRAPH_TIER_LABELS: Record<GraphTier, string> = {
  1: '圈1·每天看一次',
  2: '圈2·每周看一次',
  3: '圈3·只存快照，不定期看',
};
