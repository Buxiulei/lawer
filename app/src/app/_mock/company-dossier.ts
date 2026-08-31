/**
 * 公司档案 mock：**演示件**，形状由 @/lib/dossier/contract 定义。
 * 真数据走 B 的 GET /api/v1/company/dossiers/{id}；这份只在 demo 案件里出现。
 *
 * 数据是脱敏演示件：公司名/案号/引文都是化名，不是任何真实主体或真实文书。
 *
 * 【演示件也守同一条红线】这份 mock 里的数字是**故意**编成"够得着门槛"的：
 * 可判定 12 篇 ≥ 门槛 5，所以比例出得来；二审段只有 2 篇，所以那一段照样显示
 * 样本不足。演示里就该看得见"有的段出数、有的段不出数"这个真实形状——
 * 一份全都出数的演示会让人以为样本不足是罕见情况，而它是常态。
 */

import type { DossierQuote } from '@/lib/company/dossier-billing';
import type { ProbeResult } from '@/lib/company/probe';
import type { DossierView } from '@/lib/dossier/contract';
import { demoDate } from './clock';

export const DEMO_DOSSIER_ID = 'dsr_demo';

/** 采集截止日：数据只到这一天。演示里取「三天前」，读起来像刚跑完一轮。 */
const AS_OF = demoDate(-3);
const SOURCE = '裁判文书网·人机接力取证';

export const mockDossier: DossierView = {
  id: DEMO_DOSSIER_ID,
  companyName: '星曜网络科技（北京）有限公司',
  blocks: [
    { block: 'graph', state: 'done', startedAt: demoDate(-9), finishedAt: demoDate(-9), errorText: null },
    { block: 'litigation', state: 'done', startedAt: demoDate(-8), finishedAt: demoDate(-3), errorText: null },
    { block: 'stats', state: 'done', startedAt: demoDate(-3), finishedAt: demoDate(-3), errorText: null },
    { block: 'patterns', state: 'done', startedAt: demoDate(-3), finishedAt: demoDate(-3), errorText: null },
  ],
  queuePosition: null,
  outcome: {
    docsTotal: 41,
    docsFulltext: 17,
    docsOutcomeDecided: 12,
    workerFavorableN: 7,
    minSample: 5,
    // 单位提起 4 件——这正是"不区分程序位置的胜诉率是错的数"的现场
    byApplicant: { worker: 8, employer: 4, unknown: 0 },
    sampleN: 12,
    asOf: AS_OF,
    source: SOURCE,
  },
  duration: {
    minSample: 5,
    segments: [
      {
        key: 'arbitration',
        n: 9,
        medianDays: 58,
        sampleN: 9,
        asOf: AS_OF,
        source: SOURCE,
      },
      {
        key: 'firstInstance',
        n: 6,
        medianDays: 104,
        sampleN: 6,
        asOf: AS_OF,
        source: SOURCE,
      },
      // 这一段样本不足，界面上要单独说不出数，其它三段照常出
      {
        key: 'secondInstance',
        n: 2,
        medianDays: null,
        sampleN: 2,
        asOf: AS_OF,
        source: SOURCE,
      },
      {
        key: 'execution',
        n: 5,
        medianDays: 33,
        sampleN: 5,
        asOf: AS_OF,
        source: SOURCE,
      },
    ],
  },
  patterns: [
    {
      id: 'pat_demo_1',
      pattern: '解除通知同时写「客观情况重大变化」和「经营困难」，两个理由都不举证',
      evidence: [
        {
          caseNo: '（示例）京0X民初XXXX号',
          quote:
            '本院认为，被告主张因客观情况发生重大变化解除劳动合同，但未提交证据证明该客观情况的具体内容',
          docUrl: null,
        },
        {
          caseNo: '（示例）京0X民终XXXX号',
          quote: '被告未就其主张的经营困难提交财务凭证等证据，本院不予采信',
          docUrl: null,
        },
      ],
      model: 'deepseek-v4-pro',
      generatedAt: AS_OF,
    },
    {
      id: 'pat_demo_2',
      pattern: '协商解除谈崩后倒查考勤，把迟到早退累加成旷工',
      evidence: [
        {
          caseNo: '（示例）京0X民初YYYY号',
          quote: '被告于协商解除未果后方以旷工为由解除，其提交的考勤记录形成时间晚于解除通知',
          docUrl: null,
        },
      ],
      model: 'deepseek-v4-pro',
      generatedAt: AS_OF,
    },
  ],
  // 演示里也如实摆出丢弃计数：编造率的体温计不该只在后台可见
  droppedPatterns: 1,
  venue: {
    venue: '北京朝阳',
    covered: true,
    cards: [],
  },
  coverageNote:
    '本档案不构成该主体全部涉诉记录，仅为本次免登录公开检索与人机接力取证能触达的部分。2021 年起劳动争议文书上网率大幅下降，未上网的案件不在其中，偏差方向未知。',
  tenureYears: 5,
  refund: null,
  graphReady: true,
};

/**
 * 免费探测演示（§2.3）：四个数字 + 一行工商状态 + 采集时点。
 * 数字编成**层层子集**（有链接 9 ⊆ 劳动争议 14 ⊆ 全部涉诉 23），与 probe.ts 的
 * assertPayload 同一条包含关系——演示件也走真载荷的形状，不然演示会教出错的直觉。
 */
export const mockProbe: ProbeResult = {
  company_key: 'name:星曜网络科技（北京）有限公司',
  status: 'hit',
  cache_state: 'fresh',
  quota_left: 2,
  payload: {
    entity_matched: true,
    entity_name: '星曜网络科技（北京）有限公司',
    uscc: null,
    gs_status: '存续',
    relation_count: 6,
    litigation_count: 23,
    labor_count: 14,
    doc_url_count: 9,
    as_of: AS_OF,
  },
};

/**
 * 报价演示（v3 拆包按模块）：六块各自计价、各自摊开口径。
 *
 * 数值照 pricing_config 的兜底价手算，与服务端 quoteDossier 对同一份入参算出来的一致：
 *   venue 0 / entity 60 / graph 200 / docs_list 80（核心小计 340）
 *   docs_stats = 9 篇 × 70 = 630
 *   patterns   = 240 起（含前 20 篇，本次 9 篇）= 240   ← 未超基线篇数就不印那个负的增量项
 *   合计 1210
 * 演示里就该看得见深度两块比核心贵得多这个真实形状。
 */
export const mockQuote: DossierQuote = {
  companyKey: 'name:星曜网络科技（北京）有限公司',
  name: '星曜网络科技（北京）有限公司',
  uscc: null,
  dossierId: null,
  billableDocs: 9,
  items: [
    { module: 'venue', label: '仲裁地实操', isCore: true, priceBasis: 'free', gongdao: 0, alreadyPaid: false },
    { module: 'entity', label: '主体体检', isCore: true, priceBasis: 'fixed', gongdao: 60, alreadyPaid: false },
    { module: 'graph', label: '关联谱系', isCore: true, priceBasis: 'fixed', gongdao: 200, alreadyPaid: false },
    { module: 'docs_list', label: '涉诉清单', isCore: true, priceBasis: 'fixed', gongdao: 80, alreadyPaid: false },
    {
      module: 'docs_stats',
      label: '涉诉深度统计',
      isCore: false,
      priceBasis: 'per_doc',
      gongdao: 630,
      formula: '9 篇 × 70 = 630',
      alreadyPaid: false,
    },
    {
      module: 'patterns',
      label: '人事套路归纳',
      isCore: false,
      priceBasis: 'base_plus_per_doc',
      gongdao: 240,
      formula: '240 起（含前 20 篇，本次 9 篇）= 240',
      alreadyPaid: false,
    },
  ],
  total: 1210,
  coreSubtotal: 340,
  membershipCreditAvailable: false,
  payableGongdao: 1210,
  balance: 3000,
  shortfall: 0,
  intakeReserve: 300,
  litigationSlaDays: 7,
  minDocurlToSell: 5,
};
