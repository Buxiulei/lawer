// app/src/lib/agent/__tests__/citation-block.test.ts
// G4 依据纪律的两侧：注入侧「把合规修成最省力那条路」，出口侧「光秃条号留痕」。
import { describe, expect, it } from 'vitest';

import { bareArticleCitations, packCitationGuide, precedentContamination, statuteBlocks, valueBlocks } from '../citation-block';
import type { KnowledgePack } from '../retrieval';

const base: KnowledgePack = {
  id: 'statute-x',
  type: '法条卡',
  title: '测试法条卡',
  keywords: [],
  applies_to: [],
  region: '北京',
  confidence: '原文核实',
  updated: '2026-08-21',
  body: '## 条文原文\n\n> 用人单位有下列情形之一的……',
};

describe('引用块拼装：照抄比缩写省力', () => {
  it('法条块 = 条号 + 逐字原文 + 来源卡', () => {
    const p = {
      ...base,
      facts: { statute_quotes: [{ law: '中华人民共和国劳动合同法', article: '第四十七条', text: '经济补偿按劳动者在本单位工作的年限……' }] },
    };
    const [block] = statuteBlocks(p);
    expect(block).toContain('《中华人民共和国劳动合同法》第四十七条');
    expect(block).toContain('> 经济补偿按劳动者在本单位工作的年限……');
    expect(block).toContain('（来源卡：statute-x）');
  });

  it('卡里 law 已带书名号也不会拼成双层《《》》', () => {
    const p = { ...base, facts: { statute_quotes: [{ law: '《劳动合同法》', article: '第38条', text: '原文' }] } };
    expect(statuteBlocks(p)[0]).toContain('《劳动合同法》第38条');
    expect(statuteBlocks(p)[0]).not.toContain('《《');
  });

  // 生效期间不是装饰：拿一个没有年份的社平工资上庭，对方一句「你说的哪一年的」就问住了
  it('数字块必带生效期间与来源卡', () => {
    const p = {
      ...base,
      type: '数据卡',
      facts: { values: [{ key: 'min_wage_monthly', value: 2540, unit: '元/月', effective_from: '2025-09-01', confidence: '原文核实' }] },
    };
    const [block] = valueBlocks(p);
    expect(block).toContain('2540 元/月');
    expect(block).toContain('生效期间 2025-09-01');
    expect(block).toContain('来源卡：statute-x');
  });

  it('卡标待核实 → 块里明写「必须一并告诉用户」；已核实则不加这句假标注', () => {
    const mk = (confidence: string) => ({
      ...base,
      facts: { values: [{ key: 'fengding_jishu_monthly', value: 47103.25, unit: '元/月', effective_from: '2024-06-19', confidence }] },
    });
    expect(valueBlocks(mk('待核实'))[0]).toContain('可信度「待核实」');
    expect(valueBlocks(mk('原文核实'))[0]).not.toContain('可信度');
  });

  // 库里 8 张法条卡只有 1 张带 statute_quotes、103 张判例卡一张都没有。
  // 取不到就给**形状**，绝不去正文散文里抠内容当"逐字原文"——抠错一句用户会当庭念出来。
  it('卡没有结构化字段 → 给填空模板，且明说只给编号视为未完成', () => {
    const guide = packCitationGuide(base);
    expect(guide).toContain('逐字原文');
    expect(guide).toContain('视为未完成');
    expect(guide).toContain('statute-x');
  });

  it('判例卡的模板要的是案号+来源+裁判要旨，不是法条那套', () => {
    expect(packCitationGuide({ ...base, type: '判例卡' })).toContain('案号');
  });

  it('有结构化字段 → 给拼好的块，不再给填空模板', () => {
    const p = { ...base, facts: { statute_quotes: [{ law: '劳动合同法', article: '第47条', text: '原文' }] } };
    const guide = packCitationGuide(p);
    expect(guide).toContain('照抄即可');
    expect(guide).not.toContain('视为未完成');
  });
});

describe('判例引用块 + 出口侧污染检测（ISSUE-03）', () => {
  const card: KnowledgePack = {
    ...base,
    id: 'case-yunqi-tiaogang-baoding-2024',
    type: '判例卡',
    title: '把怀孕女职工从北京调到河北保定 = 调岗不合法不合理（2024北京仲裁十大典型案例·案例四）',
    body: '## 案情要旨\n\n邓某原在北京工作。她将怀孕情况告知公司当日，公司即通知将其调岗至河北保定，理由是"日志作假"。',
    facts: {
      case_facts: {
        case_no: '官方案例，未公开案号',
        court: '仲裁裁决 → 一审、二审判决与仲裁结果一致',
        gist: '邓某原在北京工作。她将怀孕情况告知公司当日，公司即通知将其调岗至河北保定。',
        holding: '仲裁委支持邓某继续履行劳动合同，一审、二审判决结果与仲裁一致。',
      },
    },
  };

  it('判例块把卡字段拼齐，并明写「用户事实一个字都不许写进判例案情」', () => {
    const guide = packCitationGuide(card);
    expect(guide).toContain('案情要旨');
    expect(guide).toContain('仲裁委支持邓某继续履行劳动合同');
    expect(guide).toContain('你的情况与之相似之处是');
    expect(guide).toContain('一个字都不许写进判例案情');
  });

  it('没有 case_facts 的判例卡退回填空模板，不空拼一个块', () => {
    expect(packCitationGuide({ ...card, facts: undefined })).toContain('视为未完成');
  });

  const userFacts = '某置业顾问有限公司 向公司告知已怀孕 8 周 通知明早到河北保定新岗位报到 岗位工资都没说';

  // 正样本抄真实转录（评测官在 S04 抓到的那段）
  it('**真实污染段被检出**：用户的「新岗位」被写进了判例案情', () => {
    const polluted =
      '你们公司的情况跟官方典型案例几乎一模一样：2024 年北京市劳动人事争议仲裁十大典型案例·案例四（邓某诉某置业公司）——女职工告知怀孕当日即被通知调岗河北保定、次日报到，且未明确新岗位及薪资待遇。';
    expect(precedentContamination(polluted, [card], userFacts)).toContain('新岗位');
  });

  it('只复述卡字段 + 相似点另起一句 → 干净', () => {
    const clean =
      '2024 年北京市劳动人事争议仲裁十大典型案例·案例四：邓某将怀孕情况告知公司当日，公司即通知调岗至河北保定。你的情况与之相似之处是：同样在告知怀孕后被调往外地。';
    expect(precedentContamination(clean, [card], userFacts)).toEqual([]);
  });

  it('不含判例引用的句子不看；缺卡或缺事实时不猜', () => {
    expect(precedentContamination('明早照常到原岗位打卡，新岗位的事先别答应。', [card], userFacts)).toEqual([]);
    expect(precedentContamination('案例四说……新岗位', [], userFacts)).toEqual([]);
    expect(precedentContamination('案例四说……新岗位', [card], '')).toEqual([]);
  });
});

// #48/#49 之后判例卡字段完整度不齐（6/5/4 项不等，另有 3 张多案汇编卡全空），
// 空字段处理因此是**常态路径不是边界情况**——缺哪项就不输出哪项，绝不填占位符：
// 让模型去补一个空占位，正是判例污染的入口。
describe('判例块的空字段处理（各完整度档）', () => {
  const mk = (case_facts: Record<string, string>): KnowledgePack => ({
    ...base, id: 'case-x', type: '判例卡', title: '某判例卡', facts: { case_facts },
  });

  it('字段齐全 → 每项都出现', () => {
    const g = packCitationGuide(mk({ case_no: 'A', court: 'B', gist: 'C', issue: 'D', holding: 'E', reasoning: 'F' }));
    for (const label of ['案号/出处', '审级', '案情要旨', '争议焦点', '结果', '裁判理由']) expect(g).toContain(label);
  });

  it('judged_at 之类空字符串字段 → 该项整行不输出，不留占位符', () => {
    const g = packCitationGuide(mk({ gist: 'C', holding: 'E', judged_at: '', issue: '   ' }));
    expect(g).toContain('案情要旨');
    expect(g).not.toContain('争议焦点'); // 只有空白，不输出
    expect(g).not.toContain('判决日期');
    // 没有「字段名：」后面空着的行（散文里正常的冒号结尾不算）
    expect(g).not.toMatch(/^(案号\/出处|审级|案情要旨|争议焦点|结果|裁判理由)：\s*$/m);
  });

  it('只有 holding 一项也能拼（最低完整度档）', () => {
    expect(packCitationGuide(mk({ holding: '仲裁委支持继续履行' }))).toContain('仲裁委支持继续履行');
  });

  it('多案汇编卡 case_facts 全空 → 退回填空模板，不产出空壳判例块', () => {
    const g = packCitationGuide(mk({}));
    expect(g).toContain('视为未完成');
    expect(g).not.toContain('【可直接照抄的引用块】');
  });
});

describe('出口侧：光秃条号检测（只留痕，不动正文）', () => {
  it.each([
    ['依《劳动合同法》第 39 条第 2 项，可能被认定"严重违反规章制度"解除，这是 0 补偿的解除', '真实转录·S09'],
    ['岗位是劳动合同必备条款，变更原则上必须协商一致 + 书面形式（《劳动合同法》第 35 条）', '真实转录·S04'],
  ])('「%s」判为光秃（%s）', (t) => {
    expect(bareArticleCitations(t).length).toBeGreaterThan(0);
  });

  // 【窗口必须双向】中文两种语序都自然，只查一侧就是教训 8 的重演
  it.each([
    ['《劳动合同法》第38条："用人单位未及时足额支付劳动报酬的，劳动者可以解除劳动合同"', '原文在条号之后'],
    ['"用人单位未及时足额支付劳动报酬的"——这是《劳动合同法》第38条的原话', '原文在条号之前'],
    ['正确写法是援引《劳动合同法》第 38 条：\n> 第三十八条 用人单位有下列情形之一的', 'markdown 引用块'],
  ])('「%s」不算光秃（%s）', (t) => {
    expect(bareArticleCitations(t)).toEqual([]);
  });

  it('一段里多处光秃逐处报，且返回值去掉空格便于读', () => {
    const v = bareArticleCitations('见《劳动合同法》第 35 条，另见《劳动合同法》第 40 条。');
    expect(v).toHaveLength(2);
    expect(v[0]).not.toContain(' ');
  });

  it('正文里没有条号 → 空数组（不是所有回复都涉法）', () => {
    expect(bareArticleCitations('今天下班前把这三样导出到个人邮箱。')).toEqual([]);
  });

  // 【这条钉的是一个真实的漏判】首版只要"附近有引号"就放过，于是上面那句 S09 转录
  // （引号里是 8 字术语「严重违反规章制度」）被判成合格引用。加引号的术语不是逐字条文。
  it('引号里是短术语不算逐字原文，引号里是整句条文才算', () => {
    expect(bareArticleCitations('《劳动合同法》第39条所说的"严重违反"情形')).toHaveLength(1);
    expect(bareArticleCitations('《劳动合同法》第38条："用人单位未及时足额支付劳动报酬的"')).toEqual([]);
  });
});
