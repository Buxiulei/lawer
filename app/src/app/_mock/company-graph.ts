/**
 * 公司关系图谱 mock：**演示件**，形状由 @/lib/graph/contract 定义（那里是唯一事实源，
 * 也是 GET /api/v1/cases/:id/company-graph 的响应形状）。
 * 真数据走 lib/graph/build.ts；这份只在 demo 案件里出现。
 *
 * 数据是脱敏演示件：公司名/人名/案号都是化名，不是任何真实主体。
 *
 * 日期走 ./clock 相对「今天」现算。这份图谱的叙事基准是「昨天生成、今天更新」，
 * 所以 meta 两个日期不能落到未来；历史涉诉月份按与更新日的间隔往前推。
 */

import type { CompanyGraph } from '@/lib/graph/contract';
import { demoDate, demoMonth, demoYear } from './clock';

export type {
  CompanyGraph,
  GraphEdge,
  GraphEvent,
  GraphNode,
  GraphTier,
} from '@/lib/graph/contract';

export const mockCompanyGraph: CompanyGraph = {
  meta: {
    generated: demoDate(-1),
    updated: demoDate(0),
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
      role: `${demoYear(-5)}-${demoYear(0)}发薪主体/目标主体`,
      tier: 1,
      eventCount: 1,
      litigationCount: 16,
      regCapital: '20亿',
      note: `实际发薪/用工主体（本案对手）。裁判文书网北京劳动争议 16 件（${demoMonth(-47)}~${demoMonth(-45).slice(5)} 单日8-10件批量起诉员工=裁员清退特征），朝阳法院强制执行记录；外地仲裁另在案。追责主战场。`,
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
      note: `${demoMonth(-58)}起限高、${demoMonth(-41)}单月4次被执行、累计约50余万、朝阳法院；连接两目标主体的自然人节点`,
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
      note: `裁判文书反挖：${demoMonth(-47)} 朝阳法院批量劳动争议 4 件（员工甲/乙/丙/丁同批），保险销售业务线用工主体。`,
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
      relation: `持股93.33%(${demoYear(-12)}旧报道，或已过时)`,
      confidence: '低',
      evidenceUrl: 'https://example.com/news/2',
    },
    {
      from: 'shell_a',
      to: 'payroll_b',
      relation: '同属同一品牌矩阵(无股权链一手证据，不作连带责任现成证据)',
      confidence: '中',
      evidenceUrl: 'https://example.com/registry/1',
      note: `签约壳↔用工主体：同实控人张某+${demoMonth(-47)}同期批量案佐证`,
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
      happenedAt: demoDate(-3),
      kind: '被执行',
      urgent: true,
      title: '新增强制执行记录',
      detail: '朝阳法院新增一条对 B信用 的强制执行立案（演示数据）',
    },
    {
      id: 'ev_2',
      nodeId: 'person_zhang',
      happenedAt: demoDate(-22),
      kind: '限高',
      urgent: false,
      title: '限制高消费记录仍在有效期',
      detail: '张某限高措施持续中（演示数据）',
    },
  ],
};
