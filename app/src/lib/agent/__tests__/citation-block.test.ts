// app/src/lib/agent/__tests__/citation-block.test.ts
// G4 依据纪律的两侧：注入侧「把合规修成最省力那条路」，出口侧「光秃条号留痕」。
import { describe, expect, it } from 'vitest';

import {
  bareArticleCitations,
  citationSite,
  packCitationGuide,
  precedentContamination,
  renderCoreArticleFallback,
  statuteBlocks,
  unsupportedVerbatimQuotes,
  valueBlocks,
} from '../citation-block';
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


// ───────── 判据修一：邻条的原文不得替本条免责（4e10b7c 批 S03#2 真实样本）─────────
//
// 【修前必挂】旧实现只问"±60 窗口里有没有 blockquote"。S03#2 的正文里 §46 是光秃引用，
// 但窗口里落进了讲 **§87** 的那行 blockquote，于是机械判据报全过、judge 报 FAIL，
// 两层结论相反——发版前的第二层核验就是被这个读数拦下的。
describe('光秃条号 · 逐字原文的归属', () => {
  /** 逐字取自 2026-08-24T17-56-27Z.json（S03 第2/3跑）的回复正文 */
  const S03_2 = [
    '> 《劳动合同法》第四十七条　经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资的标准向劳动者支付。',
    '',
    '公司提出、协商一致解除，给的是 N（第四十六条第（二）项）。但如果是公司**违法解除**——',
    '',
    '> 第八十七条　用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条规定的经济补偿标准的二倍向劳动者支付赔偿金。',
  ].join('\n');

  it('★S03#2：§46 光秃，不得被讲 §87 的那行 blockquote 免责', () => {
    expect(bareArticleCitations(S03_2)).toContain('第四十六条');
  });

  it('同一段里 §47/§87 自己带了原文 → 照旧不判光秃（不误伤）', () => {
    const bare = bareArticleCitations(S03_2);
    expect(bare.some((x) => x.includes('四十七'))).toBe(false);
    expect(bare.some((x) => x.includes('八十七'))).toBe(false);
  });

  it('blockquote 讲的就是本条 → 放行', () => {
    const t = '《劳动合同法》第八十七条：\n> 第八十七条　用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条规定的经济补偿标准的二倍向劳动者支付赔偿金。';
    expect(bareArticleCitations(t)).toEqual([]);
  });

  // 【保守方向】原文没自报条号时仍然放行：判据误判是冤枉做对了的输出，宁可漏判
  it('★blockquote 没自报任何条号 → 仍然放行（宁可漏判，不误伤）', () => {
    const t = '《劳动合同法》第三十八条：\n> 用人单位有下列情形之一的，劳动者可以解除劳动合同：未及时足额支付劳动报酬的。';
    expect(bareArticleCitations(t)).toEqual([]);
  });

  // 【S03#1 形态】引号内的逐字原文**不问归属**——法条原文自己会交叉引用别的条
  it('★引号内原文含交叉引用（§46 正文提到§36）→ 照旧放行，不因归属规则误伤', () => {
    const t = '《劳动合同法》第四十六条：「用人单位依照本法第三十六条规定向劳动者提出解除劳动合同并与劳动者协商一致解除劳动合同的」，应当支付经济补偿。';
    expect(bareArticleCitations(t)).toEqual([]);
  });
});


// ───────── ② blockquote 形态识别（7a4c112 批 S14#2 两处真实误报）─────────
describe('光秃条号 · 标题行点名 + 紧跟 blockquote 给原文', () => {
  /** 逐字取自 2026-08-24T17-59-36Z.json（S14 第2/3跑）「三、依据」段 */
  const S14_2 = [
    '《劳动合同法》第八十七条：',
    '> 用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条规定的经济补偿标准的二倍向劳动者支付赔偿金。（来源卡：statute-lhtf-jiechu-buchang-core）',
    '',
    '《劳动合同法实施条例》第二十七条：',
    '> 劳动合同法第四十七条规定的经济补偿的月工资按照劳动者应得工资计算，包括计时工资或者计件工资以及奖金、津贴和补贴等货币性收入。（来源卡：statute-lhtf-jiechu-buchang-core）',
  ].join('\n');

  // 【修前必挂】原文**内部**的交叉引用（§87 正文里的"依照本法第四十七条"、
  // 实施条例§27 正文开头的"劳动合同法第四十七条"）被当成"这段在讲 §47"，
  // 于是两处最规范的引用形态双双被判光秃。
  it('★S14#2：两处「标题+blockquote」引用都不得判光秃', () => {
    expect(bareArticleCitations(S14_2)).toEqual([]);
  });

  it('★但自报条号的 blockquote 仍替不了隔壁那条（S03#2 不被放过）', () => {
    const t = '给的是 N（第四十六条第（二）项）。\n> 第八十七条　用人单位违反本法规定解除或者终止劳动合同的，应当支付赔偿金。';
    expect(bareArticleCitations(t)).toContain('第四十六条');
  });
});

// ───────── ① 位置口径：核心位 vs 辅助位 ─────────
describe('引用位置口径（判据与产线同源）', () => {
  it('★表格行 = 辅助位（S14#2 那行三种情形的量级对照）', () => {
    const t = '| 第 40 条（不胜任/客观情况变化） | N+1，再加一个月工资 | 约 16 万上下 |';
    expect(citationSite(t, t.indexOf('第 40 条'))).toBe('辅助位');
  });

  it('★结论句紧邻 = 核心位（S03#2 那句"给的是 N"）', () => {
    const t = '公司提出、协商一致解除，给的是 N（第四十六条第（二）项）。';
    expect(citationSite(t, t.indexOf('第四十六条'))).toBe('核心位');
  });

  it('金额结论紧邻 = 核心位', () => {
    const t = '按第八十七条，你可以主张 28.5 万赔偿金。';
    expect(citationSite(t, t.indexOf('第八十七条'))).toBe('核心位');
  });

  it('纯说明性旁引 = 辅助位（判不准就算辅助位，宁可漏判）', () => {
    const t = '这部分的立法沿革见第十二条的历次修订说明，供了解。';
    expect(citationSite(t, t.indexOf('第十二条'))).toBe('辅助位');
  });
});

// ───────── 行为件：核心位保底渲染 ─────────
describe('核心位保底渲染：消灭「核心位光秃」这个类别', () => {
  const card = (quotes: { law: string; article: string; text: string }[]) =>
    ({ id: 'statute-x', title: '法条卡', type: '法条卡', region: '北京', confidence: '原文核实', updated: '2026-08-19', body: '正文', facts: { statute_quotes: quotes } }) as unknown as Parameters<typeof renderCoreArticleFallback>[2][number];
  const S87 = { law: '劳动合同法', article: '第八十七条', text: '第八十七条　用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条规定的经济补偿标准的二倍向劳动者支付赔偿金。' };
  const injected = [card([S87])];
  const core = new Set(['劳动合同法|第87条']);

  // 【修前必挂】S03#1 §87 形态：2N 结论句只括注了条号，用户拿不到能念的原文
  it('★核心位光秃的⭐条 → 自动补上卡内逐字原文', () => {
    const t = '如果公司程序有瑕疵，按《劳动合同法》第八十七条，那是 2N。';
    const r = renderCoreArticleFallback(t, core, injected);
    expect(r.added).toEqual(['劳动合同法|第87条']);
    expect(r.text).toContain('用人单位违反本法规定解除或者终止劳动合同的');
    // 补完之后判据侧不再判它光秃（两侧同源）
    expect(bareArticleCitations(r.text)).toEqual([]);
  });

  it('★补进去的是卡内原文 → 天然过第五闸（不会被自己剥掉）', () => {
    const t = '按《劳动合同法》第八十七条，那是 2N。';
    const r = renderCoreArticleFallback(t, core, injected);
    expect(unsupportedVerbatimQuotes(r.text, injected)).toEqual([]);
  });

  it('辅助位不动（表格行给条号+大意本就是要求的写法）', () => {
    const t = '| 《劳动合同法》第八十七条 | 违法解除 | 2N |';
    expect(renderCoreArticleFallback(t, core, injected).added).toEqual([]);
  });

  it('全文已有该条原文 → 不重复补', () => {
    const t = '按《劳动合同法》第八十七条：「用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条规定的经济补偿标准的二倍向劳动者支付赔偿金。」那是 2N。';
    expect(renderCoreArticleFallback(t, core, injected).added).toEqual([]);
  });

  it('注入包里没有该条逐字原文 → 不动（补不出来就不补，绝不凭空生成）', () => {
    const t = '按《劳动合同法》第三十八条，你可以主张 2N。';
    expect(renderCoreArticleFallback(t, new Set(['劳动合同法|第38条']), injected).added).toEqual([]);
  });

  // ── c0680d3 批 S14#1 定断点后的口径修正（2026-08-25）──
  //
  // 首版按"⭐清单内"设门，S14#1 就挂在这上面：夹具 stage=风声，映射行声明 §46/§47/实施条例§27
  // 三条占满 cap=3，§40 进不了⭐ → 渲染跳过 → 用户面前留下「N+1（第40条第3项）」这个光秃结论，
  // 而 §40 的逐字原文**就在本轮注入包里**。⭐的 cap 管的是给模型的信号密度，
  // 本函数在出口侧跑、模型已经自己选择引用了这一条，cap 不该越界。
  it('★非⭐条但原文在手 + 核心位光秃 → 照补（S14#1 §40 的真实形态）', () => {
    const t = '按《劳动合同法》第八十七条，那是 2N。';
    expect(renderCoreArticleFallback(t, new Set(['劳动合同法|第46条']), injected).added).toEqual(['劳动合同法|第87条']);
  });

  it('★⭐清单内的优先占额度（超过封顶时先保核心条）', () => {
    const many = [
      { law: '劳动合同法', article: '第三十九条', text: '第三十九条　劳动者有下列情形之一的，用人单位可以解除劳动合同。' },
      { law: '劳动合同法', article: '第四十条', text: '第四十条　有下列情形之一的，用人单位提前三十日以书面形式通知劳动者本人。' },
      { law: '劳动合同法', article: '第四十一条', text: '第四十一条　有下列情形之一，需要裁减人员二十人以上的，可以裁减人员。' },
      S87,
    ];
    const t = '按第三十九条、第四十条、第四十一条、《劳动合同法》第八十七条，你可以主张 2N 赔偿金。';
    const r = renderCoreArticleFallback(t, new Set(['劳动合同法|第87条']), [card(many)]);
    expect(r.added).toHaveLength(3); // RENDER_CAP
    expect(r.added).toContain('劳动合同法|第87条'); // ⭐条必在
  });

  // 模型引的是"第40条第3项"，用户要念的也是那一项；糊上七个子项等于用噪音淹掉他要用的那句
  it('★点名了第 N 项 → 只补那一项，不糊整条', () => {
    const s40 = {
      law: '劳动合同法',
      article: '第四十条',
      text: '第四十条　有下列情形之一的，用人单位提前三十日以书面形式通知劳动者本人或者额外支付劳动者一个月工资后，可以解除劳动合同：\n（一）劳动者患病或者非因工负伤，在规定的医疗期满后不能从事原工作的；\n（三）劳动合同订立时所依据的客观情况发生重大变化，致使劳动合同无法履行的。',
    };
    const t = '公司按客观情况重大变化辞退（第40条第3项）→ 赔 N+1 = 159,000 元。';
    const r = renderCoreArticleFallback(t, new Set(['劳动合同法|第40条']), [card([s40])]);
    expect(r.added).toEqual(['劳动合同法|第40条']);
    expect(r.text).toContain('（三）劳动合同订立时所依据的客观情况发生重大变化');
    expect(r.text).not.toContain('劳动者患病或者非因工负伤'); // 第（一）项没被糊上来
  });
});

describe('缺陷① 同条回指：判定单位是本轮，不是窗口', () => {
  const FULL = '有下列情形之一的，用人单位应当向劳动者支付经济补偿：（一）劳动者依照本法第三十八条规定解除劳动合同的；';

  // S03#1 的真实形态：全文在 16 行外，后文回指同一条 → 旧实现按窗口判成光秃
  it('前文已给全文、后文回指同一条 → 不算光秃', () => {
    const t = `《劳动合同法》第四十六条：\n> ${FULL}\n\n${'（中间隔了很多行）\n'.repeat(8)}\n所以按第四十六条，你可以主张经济补偿。`;
    expect(bareArticleCitations(t).some((a) => a.includes('第四十六条'))).toBe(false);
  });

  // 【防修过头·反向样本一】全文从未出现 → 回指仍然是光秃
  it('全文从未出现过的回指**仍判光秃**', () => {
    const t = `先说结论。\n\n${'（很多行）\n'.repeat(8)}\n所以按《劳动合同法》第四十六条，你可以主张经济补偿。`;
    expect(bareArticleCitations(t).some((a) => a.includes('第四十六条'))).toBe(true);
  });

  // 【防修过头·反向样本二】邻条的原文不得**跨轮级**覆盖本条——否则一次局部误覆盖会扩散成整轮豁免。
  // 这正是轮级预扫只收「问过归属」路径（blockquote / 自家格式）的理由。
  it('**邻条原文不得跨轮覆盖本条**：给了 §46 全文，远处的 §47 仍判光秃', () => {
    const t = `《劳动合同法》第四十六条：\n> ${FULL}\n\n${'（隔行）\n'.repeat(10)}\n另外还有第四十七条的问题。`;
    expect(bareArticleCitations(t).some((a) => a.includes('第四十七条'))).toBe(true);
  });

  // 【已知边界·记录当前行为，非本次修法引入】§47 若**紧邻**§46 的引文（同一 ±60 窗口内），
  // 本地窗口判定会放行它。根因在 `unquotedVerbatimCovers` 的归属判定过宽，属另一条缺陷，
  // 不在本次①范围内；本次修法已确保它**不会经轮级集合扩散**到全文其它位置。
  it('【已知边界】§47 紧邻 §46 引文时被本地窗口放行（现状记录）', () => {
    const t = `《劳动合同法》第四十六条：\n> ${FULL}\n\n另外还有第四十七条的问题。`;
    expect(bareArticleCitations(t).some((a) => a.includes('第四十七条'))).toBe(false);
  });

  // 【合入门槛·lead 2026-08-25 指定】轮级集合最危险的形态：**给的全文里交叉引用了邻条**。
  // 法条原文交叉引用别的条是立法常态（§46 的项里写着"依照本法第三十八条…"），
  // 而那一行**打头的是「（一）」不是条号**——取不到归属。修前把"归属未知"当成"归属成立"，
  // §38 于是被登记进本轮已给全文集合，**整轮豁免**：4e10b7c 修掉的"邻条原文替本条免责"
  // 从轮级这条路重新打开了。真语料 S03 轮1 与本样本双复现。
  it('**给了 §46 全文（内含对 §38 的交叉引用），远处光秃引 §38 → 仍判光秃**', () => {
    const t = `《劳动合同法》第四十六条：\n> ${FULL}\n\n${'（隔行）\n'.repeat(10)}\n你可以依据第三十八条被迫解除，照样拿 N。`;
    expect(bareArticleCitations(t).some((a) => a.includes('第三十八条'))).toBe(true);
  });

  // 真语料 S15 轮1 的形态：条号前面还有《法名》。不认这个前缀就会把它判成"没给过"，
  // 于是一次**新的冤枉**——修一个洞不能靠制造一次冤枉来完成。
  it('《法名》+ 自报条号的引用行也算已给全文（S15 轮1 形态）', () => {
    const t = `> 《劳动合同法》第八十七条　用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条规定的经济补偿标准的二倍向劳动者支付赔偿金。\n\n${'（隔行）\n'.repeat(6)}\n所以你能主张第八十七条的二倍赔偿金。`;
    expect(bareArticleCitations(t).some((a) => a.includes('第八十七条'))).toBe(false);
  });

  // 归属回溯的边界：标题行与引用块之间隔了空行就不再算题头（否则一个远处的标题
  // 会把后面任意一段引用都认领走）。钉住当前行为，方向是"宁可不认"。
  it('【边界】标题行与引用块之间隔空行 → 不再归属，回指仍判光秃', () => {
    const t = `《劳动合同法》第四十六条：\n\n> ${FULL}\n\n${'（隔行）\n'.repeat(8)}\n所以按第四十六条你可以主张补偿。`;
    expect(bareArticleCitations(t).some((a) => a.includes('第四十六条'))).toBe(true);
  });

  it('跨数字体系的回指也认（第46条 与 第四十六条 同键）', () => {
    const t = `《劳动合同法》第四十六条：\n> ${FULL}\n\n${'（隔行）\n'.repeat(8)}\n综上，第46条支持你的主张。`;
    expect(bareArticleCitations(t).some((a) => a.includes('46'))).toBe(false);
  });
});
