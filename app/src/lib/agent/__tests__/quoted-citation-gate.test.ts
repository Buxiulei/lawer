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

describe('第五闸 · 对称直引号必须按奇偶配对（真语料 S03 暴露的假阳性）', () => {
  // 【这条用例的由来】真语料用对称 ASCII 直引号。正则贪心配对会把
  // 「上一段的闭引号」与「下一段的开引号」配成一对，把中间**模型自己的正文**当成引文——
  // 一个会**剥掉正当内容**的假阳性。单测里造的样本只有一对引号，永远暴露不了它。
  it('一行内多对直引号：不得把两对之间的正文当成引文', () => {
    const reply =
      '基数按前 12 个月"应得工资"，含奖金、津贴、补贴、加班费；年限从你最初入职算起（《劳动合同法实施条例》第二十七条）。' +
      '第二，N 只是"公司提出、协商一致解除"这一种情形的标准。';
    const spans = quotedStatuteSpans(reply).map((s) => s.quote);
    // 中间那段模型正文绝不能被当成"引文"
    expect(spans.some((q) => q.includes('含奖金、津贴'))).toBe(false);
  });

  it('对称引号内真的引了法条原文时照样抓得到', () => {
    const reply = '《劳动合同法》第八十七条："用人单位违反本法规定解除或者终止劳动合同的，应当支付赔偿金。"';
    expect(quotedStatuteSpans(reply).length).toBeGreaterThan(0);
  });
});


// ───────── C 件：比对单元从"整块"改为"按句/分号/冒号切出的片段" ─────────
//
// 【为什么改】8101783 批 S03 三跑的离线复算：§46 的引用形态是「总述句 + 适用的那一项」，
// 而卡里总述与该项之间隔着**没被引用的其它项**（(一)(三)(四)…）。整块比对必然对不上，
// 于是一个完全正确、且是法条引用最自然的写法被判成伪逐字、被剥成光秃。
describe('第五闸 · 跨子项拼接（manager 2026-08-25 裁定为需修）', () => {
  /** §46 卡的真身：总述 + 若干子项，逐字取自 statute-lhtf-jiechu-buchang-core */
  const S46 = [
    '第四十六条　有下列情形之一的，用人单位应当向劳动者支付经济补偿：',
    '（一）劳动者依照本法第三十八条规定解除劳动合同的；',
    '（二）用人单位依照本法第三十六条规定向劳动者提出解除劳动合同并与劳动者协商一致解除劳动合同的；',
    '（三）用人单位依照本法第四十条规定解除劳动合同的；',
  ].join('\n');
  const injected = [pack('statute-lhtf-jiechu-buchang-core', `## 条文原文\n\n> ${S46}`)];

  it('★总述 + 跳过(一)直接接(二) → 放行（修前被剥，S03 #2/#3 的真实形态）', () => {
    const reply =
      '《劳动合同法》第四十六条："有下列情形之一的，用人单位应当向劳动者支付经济补偿：（二）用人单位依照本法第三十六条规定向劳动者提出解除劳动合同并与劳动者协商一致解除劳动合同的"';
    expect(unsupportedVerbatimQuotes(reply, injected)).toEqual([]);
  });

  it('整块逐字、只引总述、只引单项 → 照旧放行（不因片段化改变既有结论）', () => {
    for (const q of [S46, '有下列情形之一的，用人单位应当向劳动者支付经济补偿：', '（三）用人单位依照本法第四十条规定解除劳动合同的']) {
      expect(unsupportedVerbatimQuotes(`《劳动合同法》第四十六条："${q}"`, injected)).toEqual([]);
    }
  });

  // 【防强度下滑的负样本】片段化只放行"跳选子项"，不放行"改字"
  it('★片段里改了字 → 仍然剥（每一段都得逐字，这是防编造的底线）', () => {
    const reply =
      '《劳动合同法》第四十六条："有下列情形之一的，用人单位应当向劳动者支付经济补偿：（二）用人单位提出解除劳动合同并与劳动者协商一致的"';
    expect(unsupportedVerbatimQuotes(reply, injected)).toHaveLength(1);
  });

  it('★编一个库里没有的子项 → 仍然剥', () => {
    const reply =
      '《劳动合同法》第四十六条："有下列情形之一的，用人单位应当向劳动者支付经济补偿：（八）用人单位单方调岗且劳动者不同意的"';
    expect(unsupportedVerbatimQuotes(reply, injected)).toHaveLength(1);
  });

  // 【碎词滥配】切完全是短词时不能算"每段都有支撑"，退回整块比对的结论
  it('★全是短碎片 → 不因切分而放行（退回整块比对）', () => {
    const reply = '《劳动合同法》第四十六条规定："劳动者；用人单位；经济补偿；解除的"';
    expect(unsupportedVerbatimQuotes(reply, injected)).toHaveLength(1);
  });

  it('S14 那句伪逐字在片段化之后依然被抓住（动闸必回归）', () => {
    expect(unsupportedVerbatimQuotes(S14_REPLY, S14_INJECTED)).toHaveLength(1);
  });
});

// ───────── D 件：剥除留痕（机器可读，判据只读不推断） ─────────
describe('第五闸 · 剥除留痕归因到条', () => {
  const injected = [pack('statute-x', '第八十七条　用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条规定的经济补偿标准的二倍向劳动者支付赔偿金。')];

  it('★剥除时写下被剥的是哪一条（法名|条号）', () => {
    const reply = '依《劳动合同法》第46条："用人单位应当支付三倍经济补偿并额外补助六个月工资"，你可以主张。';
    const { stripped, strippedArticles } = stripUnsupportedQuotes(reply, injected);
    expect(stripped).toHaveLength(1);
    expect(strippedArticles).toEqual(['劳动合同法|第46条']);
  });

  it('闸没开火时留痕为空——不制造"看起来有剥除"的假象', () => {
    const reply =
      '依《劳动合同法》第八十七条："用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条规定的经济补偿标准的二倍向劳动者支付赔偿金。"';
    const { stripped, strippedArticles } = stripUnsupportedQuotes(reply, injected);
    expect(stripped).toEqual([]);
    expect(strippedArticles).toEqual([]);
  });

  it('引号前找不到条号时不硬猜（宁可归因不到，也不绑错条）', () => {
    const reply = '有人跟我说："用人单位应当支付三倍经济补偿并额外补助六个月的工资待遇"，这靠谱吗？';
    const { stripped, strippedArticles } = stripUnsupportedQuotes(reply, injected);
    expect(stripped.length + strippedArticles.length).toBeLessThanOrEqual(1);
    expect(strippedArticles).toEqual([]);
  });
});
