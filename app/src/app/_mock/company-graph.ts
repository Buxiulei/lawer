/**
 * 公司关系图谱 mock：结构即 GET /api/v1/cases/:id/company-graph 的响应形状，
 * 接后端时换数据源、页面组件签名不变。
 *
 * 数据是脱敏演示件：公司名/人名/案号都是化名，不是任何真实主体。
 */

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
  /** 涉诉计数：近 5 年劳动争议相关 */
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

export const mockCompanyGraph: CompanyGraph = {
  meta: {
    generated: '2026-08-20',
    updated: '2026-08-21',
    source: '公开检索（脱敏示例，真实来源不入仓库）',
    confidenceNote:
      'edges 的 confidence 标注一手/多源/单一摘要；A科技—B信用无直接股权链一手证据，仅同实控人（张某）平行主体',
    updateNote:
      '裁判文书检索补强：新增 F/G 用工主体节点、案件计数入节点、签约壳-用工主体边升置信',
    tiers: {
      1: '圈1·每日监控',
      2: '圈2·每周监控',
      3: '圈3·仅快照存档不监控',
    },
  },
  nodes: [
    {
      id: 'shell_a',
      name: 'A科技发展(北京)有限公司',
      role: '现用人单位/目标主体',
      tier: 1,
      eventCount: 0,
      litigationCount: 0,
      creditCode: '91110000XXXXXXXX63',
      legalRep: '张某',
      note: '签约壳：股东为香港离岸 Alpha Holdings (HK) 100%（外资空壳），法定代表人张某。劳动争议 0——实际用工/发薪在 B信用，A科技更像持牌签约主体。追股东责任时穿透到 HK 股东+张某。',
    },
    {
      id: 'payroll_b',
      name: 'B信用管理(北京)有限公司',
      role: '2021-2026发薪主体/目标主体',
      tier: 1,
      eventCount: 1,
      litigationCount: 16,
      regCapital: '20亿',
      note: '实际发薪/用工主体（本案对手）。裁判文书网北京劳动争议 16 件（2022-09~11 单日8-10件批量起诉员工=裁员清退特征），朝阳法院强制执行记录；外地仲裁另在案。追责主战场。',
    },
    {
      id: 'holder_c',
      name: 'C科技发展(北京)有限公司',
      role: 'B信用100%股东',
      tier: 1,
      eventCount: 0,
      litigationCount: 0,
      note: 'B信用 100% 股东=控股层，本身不用工故劳动争议 0（这不是遗漏，是壳/控股层的结构特征）；B信用无可执行财产时的股权穿透第一追索对象。',
    },
    {
      id: 'person_zhang',
      name: '张某',
      role: '体系实控人/自然人',
      tier: 2,
      eventCount: 1,
      litigationCount: 1,
      note: '2021-10起限高、2023-03单月4次被执行、累计约50余万、朝阳法院；连接两目标主体的自然人节点',
    },
    {
      id: 'hk_alpha',
      name: 'Alpha Holdings (HK) Limited',
      role: 'A科技100%股东(香港)',
      tier: 3,
      eventCount: 0,
      litigationCount: 0,
      note: '香港离岸，公开记录已下线，需香港查册付费；追股东责任时补',
    },
    {
      id: 'brand_d',
      name: 'D投资管理(北京)有限公司',
      role: '同品牌运营实体',
      tier: 3,
      eventCount: 0,
      litigationCount: 0,
      note: '与目标主体无直接股权/人事关联一手证据，仅品牌关联，观察',
    },
    {
      id: 'brand_e',
      name: 'E金融信息服务(北京)有限公司',
      role: '同品牌运营实体',
      tier: 3,
      eventCount: 0,
      litigationCount: 0,
      note: '同上，法律关联证据不足，观察',
    },
    {
      id: 'labor_f',
      name: 'F保险销售服务(北京)股份有限公司',
      role: '同体系用工主体(保险线)',
      tier: 2,
      eventCount: 0,
      litigationCount: 4,
      note: '裁判文书反挖：2022-09 朝阳法院批量劳动争议 4 件（员工甲/乙/丙/丁同批），保险销售业务线用工主体。',
    },
    {
      id: 'leasing_g',
      name: 'G融资租赁(北京)有限公司',
      role: '同体系用工主体(融资租赁线)',
      tier: 2,
      eventCount: 0,
      litigationCount: 3,
      note: '裁判文书反挖：员工戊案（京0X民终XXXX号）涉混同用工认定，融资租赁业务线；国际与北京两融资租赁主体，混同抗辩要点。',
    },
  ],
  edges: [
    {
      from: 'hk_alpha',
      to: 'shell_a',
      relation: '持股100%',
      confidence: '高',
      evidenceUrl: 'https://example.com/registry/1',
    },
    {
      from: 'holder_c',
      to: 'payroll_b',
      relation: '持股100%(法人独资)',
      confidence: '高',
      evidenceUrl: 'https://example.com/registry/2',
    },
    {
      from: 'person_zhang',
      to: 'shell_a',
      relation: '担任法定代表人',
      confidence: '高',
      evidenceUrl: 'https://example.com/registry/3',
    },
    {
      from: 'person_zhang',
      to: 'payroll_b',
      relation: '同一实控体系(非直接股权，平行主体)',
      confidence: '中',
      evidenceUrl: 'https://example.com/news/1',
    },
    {
      from: 'person_zhang',
      to: 'brand_d',
      relation: '持股93.33%(2014旧报道，或已过时)',
      confidence: '低',
      evidenceUrl: 'https://example.com/news/2',
    },
    {
      from: 'shell_a',
      to: 'payroll_b',
      relation: '同属同一品牌矩阵(无股权链一手证据，不作连带责任现成证据)',
      confidence: '中',
      evidenceUrl: 'https://example.com/registry/1',
      note: '签约壳↔用工主体：同实控人张某+2022-09同期批量案佐证',
    },
    {
      from: 'person_zhang',
      to: 'labor_f',
      relation: '实控',
      confidence: '中',
      note: '同品牌+批量案同期',
    },
    {
      from: 'person_zhang',
      to: 'leasing_g',
      relation: '实控',
      confidence: '中',
      note: '同体系融资租赁线',
    },
  ],
  events: [
    {
      id: 'ev_1',
      nodeId: 'payroll_b',
      happenedAt: '2026-08-18',
      kind: '被执行',
      urgent: true,
      title: '新增强制执行记录',
      detail: '朝阳法院新增一条对 B信用 的强制执行立案（演示数据）',
    },
    {
      id: 'ev_2',
      nodeId: 'person_zhang',
      happenedAt: '2026-07-30',
      kind: '限高',
      urgent: false,
      title: '限制高消费记录仍在有效期',
      detail: '张某限高措施持续中（演示数据）',
    },
  ],
};
