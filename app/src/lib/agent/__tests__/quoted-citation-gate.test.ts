// app/src/lib/agent/__tests__/quoted-citation-gate.test.ts
// 第五道确定性闸：伪逐字引号引用。
//
// 样本取自评测官的最小复现文档（REPRO-2026-08-23-S14检索外编造引用.md），**不自造**——
// 判据要钉的是模型当时真写出来的那句话，编一句相似的会把判据钉在想象的形态上。
import { describe, expect, it } from 'vitest';

import {
  quotedStatuteSpans,
  stripUnsupportedQuotes,
  unsupportedVerbatimQuotes,
  VERBATIM_UNVERIFIED,
} from '../citation-block';
import type { KnowledgePack } from '../retrieval';

const pack = (id: string, body: string): KnowledgePack =>
  ({ id, title: id, type: '法条卡', region: '北京', confidence: '原文核实', updated: '2026-08-19', body, facts: {} }) as KnowledgePack;

/** S14 那轮实际检索到的 6 张卡，无任何 534/statute pack（复现文档页脚） */
const S14_INJECTED = [
  pack('sop-nianzhongjiang-guquan-ticheng', '年终奖与股权提成的处理口径……'),
  pack('case-nianzhongjiang-beijing-koujing', '北京年终奖扣发案例……'),
  pack('case-lirun-20-jixiao-weiyuejin-11114', '绩效违约金案例……'),
  pack('sop-quxiao-jixiao-jiangjin', '取消绩效奖金的处理……'),
  pack('case-nianzhongjiang-jishu-2n-jing0105-33722', '年终奖计入基数案例……'),
  pack('case-buqian-tongzhi-shuangbei-8452', '不签通知双倍案例……'),
];

/** 复现文档里的回复原句（正样本：必须触发） */
const S14_REPLY =
  '基数不是你的到手 14000，是**应得工资**。你报税 16500，更接近这个数。' +
  '依据是京高法发〔2024〕534号《解答（一）》第55问第(4)项："《劳动合同法实施条例》第二十七条中的\'应得工资\'包含由个人缴纳的社会保险费和住房公积金以及所得税。"';

describe('第五闸 · 正样本：检索包里没有的"逐字引用"必须触发', () => {
  it('S14 #3 实测原句被抓住', () => {
    const bad = unsupportedVerbatimQuotes(S14_REPLY, S14_INJECTED);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain('包含由个人缴纳的社会保险费');
  });

  it('改口而不是静默删——用户看到的是"我需要核实"，不是缺一段', () => {
    const { text, stripped } = stripUnsupportedQuotes(S14_REPLY, S14_INJECTED);
    expect(stripped).toHaveLength(1);
    expect(text).toContain(VERBATIM_UNVERIFIED);
    expect(text).not.toContain('包含由个人缴纳的社会保险费');
    // 前面的分析照留，只换掉那句伪逐字
    expect(text).toContain('应得工资');
    expect(text).toContain('16500');
  });
});

describe('第五闸 · 负样本：本轮注入里有支撑的引用不得触发', () => {
  it('引号内容逐字来自注入块 → 放行（G4 预格式化块内引用）', () => {
    const injected = [
      pack('statute-534', '第55问（1）劳动者每月应得工资与实得工资的主要差别在于各类扣款和费用，应得工资包括个人应当承担的社会保险费。'),
    ];
    const reply =
      '京高法发〔2024〕534号《解答（一）》第55问第(1)项："劳动者每月应得工资与实得工资的主要差别在于各类扣款和费用，应得工资包括个人应当承担的社会保险费。"';
    expect(unsupportedVerbatimQuotes(reply, injected)).toEqual([]);
  });

  it('排版差异（空格/全半角括号）不算改写', () => {
    const injected = [pack('p', '期间以时、日、月、年计算。')];
    expect(unsupportedVerbatimQuotes('《民事诉讼法》第八十五条规定：" 期间以时、日、月、年计算。 "', injected)).toEqual([]);
  });
});

describe('第五闸 · 防误剥：这三类引号是 charter §6 明确要求的东西', () => {
  it.each([
    ['你刚才说"我是不是真的很没用，35岁不到就已经废了"，这句我听见了', '引用户原话'],
    ['明天照读这句："这份我先带回去看看，明天上午给您答复。"', '**可照读话术**——产品最有用的部分'],
    ['这几句绝不能说："我不干了，你们看着办"、"随便你们怎么弄"', '标注禁语'],
  ])('%s（%s）不被误抓', (reply) => {
    expect(unsupportedVerbatimQuotes(reply, S14_INJECTED)).toEqual([]);
  });

  it('没有任何注入时也不误抓正当引号（只抓被当作条文的那些）', () => {
    expect(unsupportedVerbatimQuotes('照读："我先带回去看看。"', [])).toEqual([]);
  });
});

describe('第五闸 · 识别条件：两条件之一成立才算"被当作条文"', () => {
  it('引号内含法条形态 → 算', () => {
    expect(quotedStatuteSpans('他说："依据第八十七条应当支付二倍赔偿金。"')).toHaveLength(1);
  });

  it('引号前有"规定/原文"这类宣称逐字的引导语 → 算', () => {
    expect(quotedStatuteSpans('《解答（一）》第55问规定："应得工资包括个人应当承担的社会保险费。"')).toHaveLength(1);
  });

  it('两条件都不成立 → 不算（普通引号）', () => {
    expect(quotedStatuteSpans('你可以这样说："这份我先带回去看看。"')).toHaveLength(0);
  });
});

describe('第五闸 · 分轨：正文改口，文书拒收', () => {
  it('文书通道拒收并回喂改正指令（发出去的东西不能带伪引用出门）', async () => {
    const { executeTool, newTurnState } = await import('../tools');
    const { makeAgentFixture, makeSink, fixtureSearcher } = await import('./fixtures');
    const { CitationGuard } = await import('../citation-guard');
    const f = makeAgentFixture();
    const state = newTurnState();
    state.retrieved = S14_INJECTED; // 本轮注入里没有 534
    const ctx = {
      db: f.db, caseId: f.caseId, userId: f.userId, threadId: 1, sourceMessageId: null,
      citations: new CitationGuard(), crisisCardAlreadyGiven: false, searcher: fixtureSearcher(),
      state, emit: makeSink().emit,
    } as never;
    const res = executeTool(
      'draft_write',
      JSON.stringify({
        kind: '仲裁申请书',
        title: '仲裁申请书',
        content: '依据第55问第(4)项："《劳动合同法实施条例》第二十七条中的\'应得工资\'包含由个人缴纳的社会保险费和住房公积金以及所得税。"',
        send_consequences: '发出后进入仲裁程序',
      }),
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain('查无此文');
    expect(res.content).toContain('不要凭记忆复述条文');
  });
});
