// app/src/lib/agent/__tests__/statute-guard.test.ts
// ⑥ 条号闸的变异矩阵：**每个要件一条隔离负样本 + 正对照**。
//
// 【为什么要"隔离"】一条测试同时踩三个要件，删掉其中任一个它都红——
// 红了却不知道是哪一个坏了，等于只知道"有东西坏了"。矩阵的价值在于**报出坐标**。
// 所以下面每条都只让一个要件失效，测试名里写明"删掉哪一行会让这条红"。
import { describe, expect, it } from 'vitest';

import {
  StatuteGuard,
  SUPERSEDED_STATUTE,
  UNVERIFIED_STATUTE,
  splitCitation,
  statuteCorrectionDirective,
  statuteNoticeMessage,
} from '../statute-guard';
import type { KnowledgePack } from '../retrieval';

type Quote = { law: string; article: string; text: string; source_status?: string };

function pack(quotes: Quote[]): Pick<KnowledgePack, 'facts'> {
  return { facts: { statute_quotes: quotes } };
}

/** 放行集里有两条：某某某某法 §46（现行）与 §47（现行） */
function guardWithTwo(): StatuteGuard {
  const g = new StatuteGuard();
  g.allowFrom([
    pack([
      { law: '某某某某法', article: '第四十六条', text: '有下列情形之一的，应当支付……' },
      { law: '某某某某法', article: '第四十七条', text: '按劳动者在本单位工作的年限……' },
    ]),
  ]);
  return g;
}

/** 一次喂完（非流式路径的等价物）：push 整段 + flush */
function run(g: StatuteGuard, text: string): string {
  return g.push(text) + g.flush();
}

describe('要件 A · 放行集：本轮取到原文的条才放行', () => {
  it('正对照：放行集内的条号原样通过，一个字都不动（删掉 allowFrom 的 keyed.set → 红）', () => {
    const g = guardWithTwo();
    const out = run(g, '这一步的依据是《某某某某法》第四十六条。');
    expect(out).toBe('这一步的依据是《某某某某法》第四十六条。');
    expect(g.found).toHaveLength(0);
    expect(g.seen).toBe(1);
  });

  it('负样本：放行集外的条号被缀上标记，且**条号本身不删**（删掉 sanitize 里的 out += 标记 → 红）', () => {
    const g = guardWithTwo();
    const out = run(g, '还可以看《某某某某法》第四十八条。');
    expect(out).toBe(`还可以看《某某某某法》第四十八条${UNVERIFIED_STATUTE}。`);
    expect(g.found.map((v) => v.verdict)).toEqual(['unverified']);
  });

  it('负样本：只有条号没有原文的卡目不进放行集（删掉 `!q?.text?.trim()` 那半个条件 → 红）', () => {
    const g = new StatuteGuard();
    g.allowFrom([pack([{ law: '某某某某法', article: '第四十六条', text: '   ' }])]);
    expect(run(g, '见《某某某某法》第四十六条。')).toContain(UNVERIFIED_STATUTE);
  });

  // 【这条只管闸自己的行为，不管接线】"runOnce 里那次 allowFrom 有没有掉"是**编排层**的事，
  // 本文件是纯函数测试，看不见它。真正钉住接线的那条在 gate-chain.test.ts 五、
  //「工具轮里检索回来的卡也进放行集」——起初这里的测试名写着"删掉 runOnce 里的 allowFrom → 红"，
  // 那是一句**它兑现不了的承诺**：删掉那一行，本文件一条都不会红。
  it('放行集可中途扩充：先引会被标，allowFrom 之后再引就放行', () => {
    const g = new StatuteGuard();
    expect(run(g, '见《某某某某法》第四十六条。')).toContain(UNVERIFIED_STATUTE);
    g.allowFrom([pack([{ law: '某某某某法', article: '第四十六条', text: '有下列情形之一的……' }])]);
    expect(run(g, '再说一次《某某某某法》第四十六条。')).not.toContain(UNVERIFIED_STATUTE);
  });
});

describe('要件 B · 法名绑定：把 §46 讲成 §47 之外，还要拦「张冠李戴」', () => {
  it('负样本：条号在库里、法名不在这一对上 → 标记（删掉 verdict 里的 law 分支 → 红）', () => {
    const g = guardWithTwo();
    // 「第四十六条」这个条号在放行集里（属某某某某法），但这里挂在另一部法上
    const out = run(g, '依《另外某某条例》第四十六条。');
    expect(out).toContain(UNVERIFIED_STATUTE);
  });

  it('正对照：没写法名的裸条号按条号比（删掉 byArticle 那张表 → 红）', () => {
    const g = guardWithTwo();
    expect(run(g, '前面说过的第四十七条同样适用。')).not.toContain(UNVERIFIED_STATUTE);
  });

  it('跨数字体系互认：卡里存汉字、正文写阿拉伯（改坏 normalizeArticle 的调用 → 红）', () => {
    const g = guardWithTwo();
    expect(run(g, '见《某某某某法》第46条第2项。')).not.toContain(UNVERIFIED_STATUTE);
  });

  it('全称↔简称互认：卡里存简称、正文写全称（删掉 normLaw 的「中华人民共和国」剥除 → 红）', () => {
    const g = guardWithTwo();
    expect(run(g, '见《中华人民共和国某某某某法》第四十六条。')).not.toContain(UNVERIFIED_STATUTE);
  });
});

describe('要件 C · 文号形态是固定负样本：一个都不许被当成条号', () => {
  // 【为什么这组必须存在】文号结构上像案号也像条号（`〔年份〕+数字+号`），
  // 而它恰恰是被引用最多的一类依据。误伤它 = 把最该引的依据毁掉。
  const DOC_NUMBERS = [
    '京高法发〔2024〕534 号',
    '法释〔2020〕26 号',
    '人社部发〔2021〕12 号',
    '京人社劳发〔2022〕3 号',
    '国办发〔2019〕45 号',
    '〔2023〕第 7 号公告',
  ];
  it.each(DOC_NUMBERS)('文号「%s」原样通过，且不计入 seen（把 ARTICLE_PATTERN 放宽到不要求「条」→ 红）', (doc) => {
    const g = guardWithTwo();
    const text = `依据${doc}的口径。`;
    expect(run(g, text)).toBe(text);
    expect(g.seen).toBe(0);
  });

  it('文号与真条号同句：只判条号那一处（把两者合成一条正则 → 红）', () => {
    const g = guardWithTwo();
    const out = run(g, '京高法发〔2024〕534 号与《某某某某法》第四十八条都提到这一点。');
    expect(out).toContain('京高法发〔2024〕534 号');
    expect(out).toContain(`第四十八条${UNVERIFIED_STATUTE}`);
    expect(g.seen).toBe(1);
  });
});

describe('要件 D · 司法解释/地方规章的条款项形态负样本集（≥10 条，上线前建）', () => {
  // 这一组回答的是「闸认不认得出这些形态」——它们都不在放行集里，**必须全部被标**。
  // 漏掉任何一种形态，那一类引用就会永久免检，而没有任何一处会报错。
  const SHAPES = [
    '《最高人民法院关于审理某类案件适用法律若干问题的解释（一）》第二十七条',
    '《最高人民法院关于审理某类案件适用法律若干问题的解释（二）》第六条第一款',
    '《某某某某办案规则》第四十四条第（三）项',
    '《北京市某某某某支付规定》第十三条',
    '《某某保险条例》第十四条第六项',
    '《某某某某法实施条例》第二十五条',
    '《某某保险法》第五十八条第二款',
    '《民事诉讼法》第六十一条',
    '《某某某某调解某某法》第二十七条第一款',
    '《企业职工带薪年休假实施办法》第十条',
    '《北京市实施〈某某某某法〉若干规定》第八条',
    '《某某某某争议案件审理指南》第三条之一',
  ];
  it.each(SHAPES)('「%s」被捕获并标记（改坏 ARTICLE_PATTERN 的款/项分支 → 红）', (cite) => {
    const g = guardWithTwo();
    const out = run(g, `依${cite}的规定处理。`);
    expect(out).toContain(UNVERIFIED_STATUTE);
    expect(g.seen).toBe(1);
  });

  it('这一组一共 ≥10 条（有人删到只剩两条时这里红——负样本集会缩水是真实发生过的事）', () => {
    expect(SHAPES.length).toBeGreaterThanOrEqual(10);
  });
});

describe('要件 E · 流上缓冲：切片边界不许让引用整个溜过去', () => {
  // 【这条起初是**没有牙的**——变异矩阵实测出来的，记在这里】
  // 首版用的是「不在放行集里的条号」做样本：切成两片之后，后一片剩下一个**裸条号**，
  // 而那个条号同样不在放行集里，于是照样被标——**删掉缓冲支，测试仍然绿**。
  // 隔离的做法是让两种走法给出**相反**的结论：条号本身在放行集里（裸引用会放行），
  // 只有把法名接回去才知道这一对是张冠李戴。缓冲一旦失效，法名就丢了，闸随即放行。
  it('法名与条号被切成两片：法名必须跟着条号一起判（删掉 PARTIAL_TAIL 的「法名刚闭合」那一支 → 红）', () => {
    const g = guardWithTwo();
    const out = ['依《另外某某条例》', '第四十六条的规定。'].map((c) => g.push(c)).join('') + g.flush();
    expect(out).toBe(`依《另外某某条例》第四十六条${UNVERIFIED_STATUTE}的规定。`);
    // 自证隔离：同一个条号裸着引用是放行的，所以上面那个标记只可能来自"法名接上了"
    expect(run(guardWithTwo(), '第四十六条。')).not.toContain(UNVERIFIED_STATUTE);
  });

  it('书名号中途被切（删掉 PARTIAL_TAIL 的「书名号未闭合」那一支 → 红）', () => {
    const g = guardWithTwo();
    const out = ['依《某某某', '某法》第四十八条。'].map((c) => g.push(c)).join('') + g.flush();
    expect(out).toContain(UNVERIFIED_STATUTE);
  });

  it('条号数字中途被切（删掉 PARTIAL_TAIL 的「条号成形中」那一支 → 红）', () => {
    const g = guardWithTwo();
    const out = ['依《某某某某法》第四十', '八条。'].map((c) => g.push(c)).join('') + g.flush();
    expect(out).toContain(UNVERIFIED_STATUTE);
  });

  it('逐字符喂：与一次喂完的结果**逐字相同**（缓冲写错时这条最先红）', () => {
    const text = '依《某某某某法》第四十八条第二项，另见《某某某某法》第四十六条。';
    const a = run(guardWithTwo(), text);
    const g = guardWithTwo();
    const b = [...text].map((c) => g.push(c)).join('') + g.flush();
    expect(b).toBe(a);
  });

  it('流末没闭合的半截照样交出去，不许吞字（删掉 flush 里的 sanitize(pending) → 红）', () => {
    const g = guardWithTwo();
    const out = g.push('话说到一半《某某某') + g.flush();
    expect(out).toBe('话说到一半《某某某');
  });
});

describe('要件 F · 免检态：立法者写的交叉引用不算 agent 的引用', () => {
  it('引号内的条号免检，且**不计入 seen**（删掉 inQuote 那三行 → 红）', () => {
    const g = guardWithTwo();
    const out = run(g, '原文写的是「……应当依照本法第九十九条规定执行」。');
    expect(out).not.toContain(UNVERIFIED_STATUTE);
    expect(g.seen).toBe(0);
  });

  it('markdown 引用块整行免检（删掉 lineExempt 的 `>` 分支 → 红）', () => {
    const g = guardWithTwo();
    const out = run(g, '> 第四十六条　……依照本法第九十九条的规定。\n');
    expect(out).not.toContain(UNVERIFIED_STATUTE);
  });

  it('自家注入块格式（`第N条　正文…`）的正文免检，但**打头那条本身要判**（删掉 SELF_LABELED_LINE 分支 → 红）', () => {
    const g = guardWithTwo();
    const out = run(g, '第九十八条　用工方依照本法第九十九条应当承担的责任。\n');
    // 打头的 §98 不在放行集 → 标；正文里的 §99 是立法者写的 → 免检
    expect(out).toContain(`第九十八条${UNVERIFIED_STATUTE}`);
    expect(out).not.toContain(`第九十九条${UNVERIFIED_STATUTE}`);
  });

  it('**对称**引号（"）的免检不跨行：它开闭同形，跨行配对必然配错（删掉换行处的 inQuote=false → 红）', () => {
    const g = guardWithTwo();
    const out = run(g, '他说"这句没闭合\n《某某某某法》第四十八条也适用。');
    expect(out).toContain(UNVERIFIED_STATUTE);
  });

  /**
   * 【非对称引号的免检**必须跨行**（2026-09-08 复审 blocker）】⑧ 是把卡内原文以
   * `「…」` **内联**插进正文的，而真库 318 条 statute_quotes 里 164 条是多行的。
   * 按行清空免检态的形态是：原文第 1 行豁免、第 2 行起不豁免 →
   * 闸对着**自己刚补进来的原文**里立法者的交叉引用开火，且漏网自检把它记成漏网。
   * 非对称引号开闭是不同字符，跨多少行都配得准，所以豁免只给它们。
   */
  it('**非对称**引号（「」）的免检跨行：多行原文第 2 行起的交叉引用同样免检', () => {
    const g = guardWithTwo();
    const out = run(g, '原文是「有下列情形之一的：\n（一）依照本法第九十九条解除的；\n（二）其他情形。」');
    expect(out).not.toContain(UNVERIFIED_STATUTE);
    expect(g.seen).toBe(0);
  });

  it('未闭合的非对称引号只罩一段就收回免检态（不设上限 → 漏一个「就把整轮的闸关掉）', () => {
    const g = guardWithTwo();
    const out = run(g, `他说「这句没闭合${'啊'.repeat(3200)}《某某某某法》第四十八条也适用。`);
    expect(out, '免检态一直开着 → 后面所有条号全部放行，而 gate_report 会诚实地报「候选 0 处」').toContain(
      UNVERIFIED_STATUTE,
    );
  });

  /**
   * 【内层的异类闭引号不许关掉外层的免检（2026-09-08 复审 minor）】
   * 流上原先只留一个"在不在引号里"的布尔，任何一种闭引号都能把它关掉；
   * 而整段扫描那边（`asymQuoteSpans`）是按**同一对**配对、跨过内层的。
   * 两边就此分叉的下场是：模型以「」逐字转引一段自带弯引号的原文（真库 318 条里有 4 条），
   * 引文**后半截**里立法者的交叉引用被标【条号待核验】、计进 seen 与替换率，
   * 而漏网自检说一处没漏——**闸在引文内部误伤，自检还给它背书**。
   */
  it('嵌套异类引号：内层的 ” 关不掉外层的「」（把 asymClose 改回布尔 → 红）', () => {
    const g = guardWithTwo();
    const out = run(g, '原文是「用人单位依照本法第“四十”条规定解除的，应当依照本法第九十九条规定…」');
    expect(out, '内层弯引号把免检关掉了 → 引文内部被标记').not.toContain(UNVERIFIED_STATUTE);
    expect(g.seen, '引文内部的交叉引用不该计进分母').toBe(0);
  });

  it('负对照：**配对的**那个闭引号照常收回免检态（否则一个「就把整轮的闸关掉）', () => {
    const g = guardWithTwo();
    const out = run(g, '原文是「……依照本法第九十九条」，另外《某某某某法》第四十八条也适用。');
    expect(out).toContain(`第四十八条${UNVERIFIED_STATUTE}`);
    expect(out).not.toContain(`第九十九条${UNVERIFIED_STATUTE}`);
  });

  it('免检态跨 chunk 保持：引号开在上一片、条号落在下一片（把三个状态字段改成方法内局部变量 → 红）', () => {
    const g = guardWithTwo();
    const out = ['原文是「……应当依照本法', '第九十九条规定执行」。'].map((c) => g.push(c)).join('') + g.flush();
    expect(out).not.toContain(UNVERIFIED_STATUTE);
  });
});

describe('要件 G · 登记簿 status（设计稿 §7.3）', () => {
  it('status=已修正 → 换另一种标记，不是【条号待核验】（删掉 superseded 分支 → 红）', () => {
    const g = new StatuteGuard();
    g.allowFrom([pack([{ law: '某某某某法', article: '第四十六条', text: '旧版原文……', source_status: '已修正' }])]);
    const out = run(g, '见《某某某某法》第四十六条。');
    expect(out).toContain(SUPERSEDED_STATUTE);
    expect(out).not.toContain(UNVERIFIED_STATUTE);
    expect(g.found.map((v) => v.verdict)).toEqual(['superseded']);
  });

  it('status=已废止 同样按已修正处置（把判定写成只认「已修正」→ 红）', () => {
    const g = new StatuteGuard();
    g.allowFrom([pack([{ law: '某某某某法', article: '第四十六条', text: '旧版……', source_status: '已废止' }])]);
    expect(run(g, '见《某某某某法》第四十六条。')).toContain(SUPERSEDED_STATUTE);
  });

  it('status 缺失 → **按现行处理**，并单列计数（把缺失 `?? 现行` 掉 → sourceStatusUnknown 归零 → 红）', () => {
    const g = guardWithTwo();
    expect(run(g, '见《某某某某法》第四十六条。')).not.toContain(SUPERSEDED_STATUTE);
    // 「我们不知道」必须看得见：接上登记簿的那天这个数会变，报表跟着变
    expect(g.sourceStatusUnknown).toBe(2);
  });

  it('同一条被两张卡收录、一张现行一张已修正 → 现行那张说了算（删掉 allowFrom 里的 `!== 现行` 守卫 → 红）', () => {
    const g = new StatuteGuard();
    g.allowFrom([
      pack([{ law: '某某某某法', article: '第四十六条', text: '旧版……', source_status: '已修正' }]),
      pack([{ law: '某某某某法', article: '第四十六条', text: '新版……', source_status: '现行' }]),
    ]);
    expect(run(g, '见《某某某某法》第四十六条。')).not.toContain(SUPERSEDED_STATUTE);
    expect(g.sourceStatusUnknown).toBe(0);
  });
});

describe('要件 K · 序数量词不是条号（「三条建议」不许被写成【条号待核验】）', () => {
  /**
   * 【这个歧义此前无害，⑥ 把它变成了用户面的错字】`ARTICLE` 只服务两个**只留痕**的
   * 消费者时，把「第一条，先别签字」当条号至多多一条 notice。⑥ 改成 rewrite 之后，
   * 同一处歧义直接写进用户面，还计进替换率——读报表的人会以为模型在编条号。
   */
  it.each([
    ['我给你三条建议。第一条，先别签字。', '序数用法'],
    ['第三条路是走仲裁。', '量词 + 名词'],
    ['第二条，把通知拍照。', '列举'],
  ])('不判：「%s」（%s）', (text) => {
    const g = guardWithTwo();
    const out = run(g, text);
    expect(out, '把序数用法标成条号 = 在一段正确的话里插错字').toBe(text);
    expect(g.seen, '它也不该进替换率的分母').toBe(0);
  });

  it('缺口有计数：放过去几处必须报得出来（把计数删掉 → 洞变成隐形 → 红）', () => {
    const g = guardWithTwo();
    run(g, '第一条，先别签字。第二条，把通知拍照。');
    expect(g.ambiguous).toBe(2);
    // 【分项判据 ①（2026-09-08 第三轮复审 minor）】序数量词只进 ordinal 那一格：
    // 两个洞合成一个数，报表只报得出"洞变大了"，报不出该去动 ORDINAL_MAX 还是载体词表
    expect(g.ambiguousOrdinal).toBe(2);
    expect(g.ambiguousCarrier, '序数用法不是载体排除（两格串了 → 红）').toBe(0);
  });

  it.each([
    ['《某某某某法》第三条', '带法名 → 谁都不会读成量词'],
    ['第三条第二项', '带款/项 → 序数用法不会这么说'],
    ['第四十八条', '条号 > 10 → 中文里没人说「第四十八条建议」'],
  ])('正对照：「%s」照判不误（%s）', (cited) => {
    const g = guardWithTwo();
    expect(run(g, `见${cited}。`)).toContain(UNVERIFIED_STATUTE);
  });

  it('漏网自检用同一条形态口径（自检自己另写一套 → 序数用法被记成漏网 → 红）', () => {
    const g = guardWithTwo();
    expect(g.leakedIn('我给你三条建议。第一条，先别签字。')).toEqual([]);
  });
});

/**
 * 【条数上百的**不是法条**：合同、手册、规章制度（2026-09-08 复审 major）】
 * `ORDINAL_MAX` 那条缺口声明只挡住「第三条建议」这种序数量词，靠的是"没人说第四十七条建议"。
 * 但合同、员工手册、规章制度、和解协议、裁决书同样一条一条编号，而且条数动辄几十上百
 * ——「你劳动合同第十二条写的是……」「员工手册第三十五条把这个定成了严重违纪」
 * 恰恰是 HR 施压期几乎每轮都在谈的两份文件。⑥ 会把它们判成"本轮没取到原文的法条"，
 * 就地写出「劳动合同第十二条【条号待核验】」——**系统在质疑用户手上那份合同的存在**，
 * 而且计进替换率的分子，读报表的人以为模型在编条号。
 */
describe('要件 K2 · 载体是合同/手册/制度时，裸条号不是法条', () => {
  it.each([
    ['你劳动合同第十二条写的是竞业限制。', '劳动合同'],
    ['员工手册第三十五条把这个定成了严重违纪。', '员工手册'],
    ['公司规章制度第二十条说迟到三次算旷工。', '规章制度'],
  ])('不判：「%s」（载体：%s）', (text) => {
    const g = guardWithTwo();
    const out = run(g, text);
    expect(out, '在用户自己那份文件的条号旁边写"待核验"').toBe(text);
    expect(g.seen, '它也不该进替换率的分母').toBe(0);
  });

  it('缺口有计数：按载体放过去的同样进 ambiguous（只是不判、不是没看见 → 删掉计数即隐形）', () => {
    const g = guardWithTwo();
    run(g, '劳动合同第十二条与员工手册第三十五条都要留一份。');
    expect(g.ambiguous).toBe(2);
    // 【分项判据 ②】载体排除只进 carrier 那一格（两格串了 → 红）
    expect(g.ambiguousCarrier).toBe(2);
    expect(g.ambiguousOrdinal, '第十二条/第三十五条都 > ORDINAL_MAX，不是序数用法').toBe(0);
  });

  /**
   * 【不带《》的法名不是载体（2026-09-08 第三轮复审 minor）】真语料里法名常常裸写：
   *「劳动合同法第四十七条」「北京市工资支付规定第十四条」。两处窗口里分别有「合同」「规定」，
   * 载体排除一命中就整处静默放过——不判、不标、不计分母，只在 ambiguousCarrier 里加一。
   * 于是**本行当引用频次最高的那两条**在不带书名号时一处都进不了闸，而报表上只看到
   *「载体排除若干处」。判据是"末尾是法规后缀 + 前面连读成名"，与合同/手册/制度分得开。
   */
  it.each([
    ['劳动合同法第四十七条按工作年限算补偿。', '劳动合同法'],
    ['北京市工资支付规定第十四条写了加班费倍数。', '北京市工资支付规定'],
  ])('负对照：不带《》的法名「%s」仍按法条判（删掉法名后缀那条例外 → 红）', (text) => {
    // 放行集里只有某某某某法 §10——下面两条的条号都不在其中，落进闸就该被标
    const g = new StatuteGuard();
    g.allowFrom([pack([{ law: '某某某某法', article: '第十条', text: '本法自公布之日起施行。' }])]);
    const out = run(g, text);
    expect(out, '法名末字是「法」/「规定」，它前面连读成名——不是载体').toContain(UNVERIFIED_STATUTE);
    expect(g.seen, '它该进替换率的分母（被静默放过时这里是 0）').toBe(1);
    expect(g.ambiguousCarrier, '不许再记成载体排除').toBe(0);
  });

  it('正对照：带《》的法名不受影响——《劳动合同法》里的「合同」是法名的一部分', () => {
    const g = guardWithTwo();
    expect(run(g, '见《劳动合同法》第十二条。')).toContain(UNVERIFIED_STATUTE);
    // 放行集内的照旧放行（证明上一条不是"带法名就一律标"）
    expect(run(guardWithTwo(), '见《某某某某法》第四十六条。')).not.toContain(UNVERIFIED_STATUTE);
  });

  it('正对照：载体词不在紧邻窗口内时照判（把窗口放大到整句 → 红）', () => {
    const g = guardWithTwo();
    // 「规定」离条号 9 个字，不是它的载体——这一处仍然是法条引用
    expect(run(g, '按这条规定该怎么办呢，我看第四十八条。')).toContain(UNVERIFIED_STATUTE);
  });

  it('漏网自检与流上同口径：流上按载体放行的，自检不许记成漏网（自检不给上文 → 红）', () => {
    const g = guardWithTwo();
    expect(g.leakedIn('你劳动合同第十二条写的是竞业限制。')).toEqual([]);
    // 负对照：同一个条号换掉载体就是法条，自检必须报得出来
    expect(g.leakedIn('依据是第十二条。')).toEqual(['第十二条']);
  });

  it('文书通道同口径：合同条款不进 docSeen，也不被拒收（check 不给上文 → 红）', () => {
    const g = guardWithTwo();
    expect(g.check('你劳动合同第十二条约定了竞业限制。', '仲裁申请书')).toEqual([]);
    expect(g.docSeen).toBe(0);
    expect(g.ambiguous).toBe(1);
  });
});

describe('要件 L · 多行原文：⑧ 内联补进来的那一段整段免检', () => {
  const MULTI = ['有下列情形之一的：', '（一）依照本法第九十九条解除的；', '（二）依照本法第一百零一条解除的。'].join('\n');

  it('漏网自检不把多行原文里第 2 行起的交叉引用记成漏网（按行算免检 → 红）', () => {
    const g = guardWithTwo();
    expect(g.leakedIn(`依据是第四十六条「${MULTI}」。`)).toEqual([]);
  });

  it('流上同样免检，且不计入 seen（流上按行清空免检态 → 红）', () => {
    const g = guardWithTwo();
    const out = run(g, `依据是《某某某某法》第四十六条「${MULTI}」。`);
    expect(out).not.toContain(UNVERIFIED_STATUTE);
    expect(g.seen, '第 2 行起的交叉引用被算进了分母 → 替换率的分母会随原文行数漂移').toBe(1);
  });

  it('负对照：同样两条交叉引用挪到引号外，一处不少地被标（证明上面的"零"不是没捕到）', () => {
    const g = guardWithTwo();
    const out = run(g, '另见第九十九条与第一百零一条。');
    expect(out).toContain(`第九十九条${UNVERIFIED_STATUTE}`);
    expect(out).toContain(`第一百零一条${UNVERIFIED_STATUTE}`);
  });
});

describe('要件 H · 文书通道：标记 vs 拒收（两条出口的处置故意不同）', () => {
  it('check 不改写内容，只返回违规清单（让 check 去改写 → 红）', () => {
    const g = guardWithTwo();
    const bad = g.check('本案依《某某某某法》第四十八条主张。', '文书《某申请书》');
    expect(bad.map((v) => v.cited)).toEqual(['《某某某某法》第四十八条']);
    expect(bad[0].where).toBe('文书《某申请书》');
  });

  it('已修正的源在文书通道同样拒收（把 check 写成只挡 unverified → 红）', () => {
    const g = new StatuteGuard();
    g.allowFrom([pack([{ law: '某某某某法', article: '第四十六条', text: '旧版……', source_status: '已废止' }])]);
    expect(g.check('依《某某某某法》第四十六条。', '文书《某申请书》')).toHaveLength(1);
  });

  /**
   * 【文书通道与正文通道必须分账（2026-09-08 复审 minor）】合账的形态有两处，都会说假话：
   *   · 轮末那条 notice 对用户说「已标注【条号待核验】」——而文书是**拒收**，正文里
   *     一个标记都没有；模型下一轮改对了，用户还收到一条说他"已被标注"的通知。
   *   · 替换率把拒收算进分子分母：文书错 1 处 + 正文 1 处引用 → 报 50%，
   *     成绩单点名「闸误伤，去查闸的判据」——而闸这一轮做的恰恰是它该做的事。
   */
  it('文书通道的拒收不进 found / seen（合账 → 轮末 notice 说的标注根本不存在 → 红）', () => {
    const g = guardWithTwo();
    g.check('本案依《某某某某法》第四十八条主张。', '文书《某申请书》');
    expect(g.found, '文书拒收混进了正文违规').toHaveLength(0);
    expect(g.seen, '文书拒收混进了替换率的分母').toBe(0);
    expect(g.docFound).toHaveLength(1);
    expect(g.docSeen).toBe(1);
    // 正文那一处照常各记各的
    run(g, '另见《某某某某法》第四十八条。');
    expect(g.found).toHaveLength(1);
    expect(g.seen).toBe(1);
    expect(g.docFound, '正文的标记倒灌进了文书账').toHaveLength(1);
  });

  it('轮末 notice 只讲正文里真标了的那些（把 docFound 也喂进去 → 红）', () => {
    const g = guardWithTwo();
    g.check('本案依《某某某某法》第四十八条主张。', '文书《某申请书》');
    expect(statuteNoticeMessage(g.found), '文书被拒的条号出现在"已标注"那句话里').toBe('');
  });

  it('回喂指令说清「哪一条、为什么、怎么办」（删掉指令里的任一段 → 红）', () => {
    const g = guardWithTwo();
    const bad = g.check('依《某某某某法》第四十八条。', '文书《某申请书》');
    const directive = statuteCorrectionDirective(bad, '某申请书');
    expect(directive).toContain('《某某某某法》第四十八条');
    expect(directive).toContain('没有它们的逐字原文');
    expect(directive).toContain('knowledge_search');
  });
});

describe('要件 I · 禁令必配出路（设计稿 §7.7）', () => {
  it('待核验的 notice 给得出两条具体出路：来源卡 与 citation_check（删掉出路句 → 红）', () => {
    const msg = statuteNoticeMessage([{ cited: '《某某某某法》第四十八条', where: '正文', verdict: 'unverified' }]);
    expect(msg).toContain('来源卡');
    expect(msg).toContain('citation_check');
  });

  it('已修正的 notice 给的是另一条出路（两种标记共用一句话 → 红）', () => {
    const msg = statuteNoticeMessage([{ cited: '《某某某某法》第四十六条', where: '正文', verdict: 'superseded' }]);
    expect(msg).toContain('取新版');
    expect(msg).not.toContain('citation_check');
  });

  it('一条违规都没有时不产出文案（空字符串会被上游渲染成一个空提示行）', () => {
    expect(statuteNoticeMessage([])).toBe('');
  });
});

describe('要件 J · 漏网自检：闸对自己输出的复查', () => {
  it('闸跑完的正文里漏网恒 0（把 sanitize 的替换整段注释掉 → 红）', () => {
    const g = guardWithTwo();
    const out = run(g, '见《某某某某法》第四十八条，另见《某某某某法》第四十六条。');
    expect(g.leakedIn(out)).toEqual([]);
  });

  it('负样本：把标记从正文里手工抠掉，漏网自检必须报出来（否则这条自检等于没有）', () => {
    const g = guardWithTwo();
    const out = run(g, '见《某某某某法》第四十八条。').replace(UNVERIFIED_STATUTE, '');
    expect(g.leakedIn(out)).toEqual(['《某某某某法》第四十八条']);
  });

  it('引用块里的交叉引用不算漏网（漏网自检不共用 authoredCitationSpans → 红）', () => {
    const g = guardWithTwo();
    expect(g.leakedIn('> 第四十六条　……依照本法第九十九条的规定。\n')).toEqual([]);
  });
});

describe('splitCitation：拆法两侧同源', () => {
  it('带书名号', () => expect(splitCitation('《中华人民共和国某某某某法》第46条第2项')).toEqual({ law: '某某某某法', article: '第46条' }));
  it('不带书名号', () => expect(splitCitation('第四十六条')).toEqual({ law: '', article: '第46条' }));
});
