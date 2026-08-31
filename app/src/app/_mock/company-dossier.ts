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

import type { DossierQuote, DossierView } from '@/lib/dossier/contract';
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

/** 报价演示：拆价可见，文书块带时延与退款承诺。 */
export const mockQuote: DossierQuote = {
  lines: [
    {
      feature: 'dossier_graph',
      label: '公司谱系',
      gongdao: 480,
      delivers: '签约主体、发薪主体、控股股东与同体系用工主体的关系图，以及各自的工商登记。',
      slaWorkdays: null,
      refundPromise: null,
      optional: true,
    },
    {
      feature: 'dossier_litigation',
      label: '公司判例档案',
      gongdao: 1200,
      delivers: '这家公司的劳动争议判例清单、结果统计与套路归纳。',
      slaWorkdays: 7,
      refundPromise: '可判定结果的文书不足 5 篇时，这一块全额退还，已采到的判例清单仍然保留。',
      optional: true,
    },
  ],
  totalGongdao: 1680,
  cache: { hit: false, ageDays: null, cachedGongdao: 480 },
  entitlementAvailable: false,
  balanceGongdao: 3000,
};
