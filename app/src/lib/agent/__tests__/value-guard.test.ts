// app/src/lib/agent/__tests__/value-guard.test.ts
// ⑨ 数值闸的变异矩阵：每个要件一条隔离负样本 + 正对照。
//
// 【这道闸最容易犯的错是误伤，不是漏拦】所以正对照的密度和负样本一样高：
// 一处误伤 = 在一个算对了的金额旁边写上【数值无来源】，用户会因此不敢用那个数。
import { describe, expect, it } from 'vitest';

import { calcOvertimePay } from '../calc';
import {
  applyValueGuard,
  VALUE_MISMATCH,
  VALUE_UNSOURCED,
  valueNoticeMessage,
  valueNoticeSuggest,
  type ValueSources,
} from '../value-guard';

/** 卡里有一个数：47103.25 元/年 */
const CARD = {
  facts: { values: [{ key: 'cap-base', value: 47103.25, unit: '元', effective_from: '2023-01-01', confidence: '原文核实' }] },
};

/**
 * 一次成功的 claim_calc 出参（形状同 persistCalc 的 payload）。
 * `kind` 取真出参的取值域（`N` / `N+1` / `2N` / 年假…），倍数记号那一路的放行集读它。
 */
const CALC = {
  kind: 'N',
  amount_fen: 3500000,
  amount_yuan: '35000.00',
  formula: 'N = 3.5 × 10000',
  steps: ['工作年限 3.5', '月工资 10000'],
  inputs: { months: 42, avg_monthly_wage_fen: 1000000 },
};

function sources(over: Partial<ValueSources> = {}): ValueSources {
  return { calcPayloads: [], retrieved: [], deadlines: [], ...over };
}

const mark = (text: string, over: Partial<ValueSources> = {}) => applyValueGuard(text, sources(over));

describe('要件 A · 金额：不在 calc 出参与 facts.values 里的一律标记', () => {
  it('负样本「封顶 60 万」（设计稿点名）→ 标记（删掉金额那一段正则 → 红）', () => {
    const r = mark('这一项一般封顶 60 万。');
    expect(r.text).toBe(`这一项一般封顶 60 万${VALUE_UNSOURCED}。`);
    expect(r.violations[0]).toMatchObject({ kind: '金额', mark: 'unsourced' });
  });

  it('正对照：calc 出参里的金额（元）放行（删掉 numbersIn 的分→元换算 → 红）', () => {
    const r = mark('算下来是 35000 元。', { calcPayloads: [CALC] });
    expect(r.text).toBe('算下来是 35000 元。');
    expect(r.violations).toHaveLength(0);
    expect(r.seen).toBe(1);
  });

  it('正对照：calc 出参里的金额带千分位写法也放行（删掉 normNumber → 红）', () => {
    expect(mark('算下来是 35,000 元。', { calcPayloads: [CALC] }).violations).toHaveLength(0);
  });

  it('正对照：卡里的数逐字给出即放行（删掉 facts.values 那一段收集 → 红）', () => {
    expect(mark('上限基数是 47103.25 元。', { retrieved: [CARD] }).violations).toHaveLength(0);
  });

  it('正对照：卡里的数换算成万元写法也放行（删掉 value/10000 那一行 → 红）', () => {
    expect(mark('大约 4.710325 万元。', { retrieved: [CARD] }).violations).toHaveLength(0);
  });

  it('负样本：本轮没算过钱 → 正文里的金额一律无来源（把空 calcPayloads 当放行 → 红）', () => {
    expect(mark('大概能拿到 35000 元。').violations).toHaveLength(1);
  });
});

describe('要件 B · 容差：差一点点与凭空冒出来是两件事', () => {
  it('±0.5% 内但不相等 → 【数值与来源卡不一致】（删掉容差分支 → 红，会变成"无来源"）', () => {
    const r = mark('上限基数是 47100 元。', { retrieved: [CARD] });
    expect(r.text).toContain(VALUE_MISMATCH);
    expect(r.text).not.toContain(VALUE_UNSOURCED);
    expect(r.violations[0]).toMatchObject({ mark: 'mismatch', nearest: '47103.25' });
  });

  it('容差之外 → 回到【数值无来源】（把容差放宽到 5% → 红）', () => {
    const r = mark('上限基数是 52000 元。', { retrieved: [CARD] });
    expect(r.text).toContain(VALUE_UNSOURCED);
    expect(r.text).not.toContain(VALUE_MISMATCH);
  });
});

describe('要件 C · 倍数记号：带系数的判，裸 N 不判（明说的缺口）', () => {
  it('负样本「按 3N 谈」（设计稿点名）→ 标记（删掉 N_FORM → 红）', () => {
    expect(mark('这种情况一般按 3N 谈。').text).toContain(VALUE_UNSOURCED);
  });

  it('负样本 2N / N+1 同样被捕（把 N_FORM 收成只认 3N → 红）', () => {
    expect(mark('可以主张 2N。').violations).toHaveLength(1);
    expect(mark('也可能是 N+1。').violations).toHaveLength(1);
  });

  it('正对照：本轮算的就是这个记号 → 放行（把 kind 那一路删掉 → 红）', () => {
    expect(mark('这一笔就是 N。也就是 1N。', { calcPayloads: [CALC] }).violations).toHaveLength(0);
    expect(mark('这一笔就是 2N。', { calcPayloads: [{ ...CALC, kind: '2N' }] }).violations).toHaveLength(0);
    expect(mark('这一笔是 N+1。', { calcPayloads: [{ ...CALC, kind: 'N+1' }] }).violations).toHaveLength(0);
  });

  /**
   * 【放行集是**值的集合**，不是"这一轮算过钱"这个事件（2026-09-08 复审 minor）】
   * 按事件放行的形态是：本轮算的是 N，模型顺口写「你可以按 3N 谈，或者 2N+1」，
   * 两个都没人算过，却因为"算过钱"整体放行——而 `3N` 正是设计稿点名的那条负样本，
   * 它只在**一分钱都没算过**的轮里被拦，也就是最不需要拦的那一轮。
   */
  it('负样本：算的是 N，正文写「按 3N 谈」「2N+1」照标（把判据写回"算过钱"这个布尔 → 红）', () => {
    const r = mark('你可以按 3N 谈，或者 2N+1。', { calcPayloads: [CALC] });
    expect(r.violations.map((v) => v.token)).toEqual(['3N', '2N+1']);
    expect(r.violations.every((v) => v.mark === 'unsourced')).toBe(true);
  });

  it('记号的归一两侧同源：正文写小写 n、全角＋、带空格，与出参的 kind 一样对得上', () => {
    expect(mark('这一笔是 n ＋ 1。', { calcPayloads: [{ ...CALC, kind: 'N+1' }] }).violations).toHaveLength(0);
  });

  it('**声明的缺口**：裸 N 不捕。它是这个行当对某项补偿的通称，不是数值断言', () => {
    const r = mark('我们先把 N 算清楚，再谈别的。');
    expect(r.violations).toHaveLength(0);
    expect(r.seen).toBe(0);
  });
});

describe('要件 D · 百分比与倍数', () => {
  it('负样本：百分比无来源 → 标记（删掉 PERCENT → 红）', () => {
    expect(mark('加班这一段按 300% 算。').text).toContain(VALUE_UNSOURCED);
  });

  it('负样本：汉字写法「百分之三十」同样标记（只认阿拉伯数字 → 红）', () => {
    const r = mark('大概能追回百分之三十。');
    expect(r.text).toContain(VALUE_UNSOURCED);
    expect(r.violations[0].kind).toBe('百分比');
  });

  it('负样本：倍数无来源 → 标记（删掉 TIMES → 红）', () => {
    expect(mark('封顶是社平的 3 倍。').text).toContain(VALUE_UNSOURCED);
  });

  it('不误伤：不带单位的数字一个都不捕（把 MONEY 的单位后缀去掉 → 红）', () => {
    const r = mark('你一共提交了 12 份材料，编号 3、5、7 那几份最关键。');
    expect(r.violations).toHaveLength(0);
    expect(r.seen).toBe(0);
  });

  it('不误伤：日期、月数、年数不带钱的单位，不进捕获面', () => {
    expect(mark('你 2024 年 3 月入职，到现在 18 个月。').violations).toHaveLength(0);
  });
});

describe('要件 I · 来源不止两份：法条原文、档案事实、用户自述（2026-09-08 复审 major）', () => {
  /**
   * 【为什么设计稿字面的两份不够】照字面只认 calc 出参 ∪ facts.values 跑出来的形态是：
   * 用户说「我月薪 2 万、公司裁了 3 万人里的 1%」，模型**复述**这几个数，三处全被标
   *【数值无来源】——而这正是本文件在日期那一段明说要避免的事：
   * **系统去质疑用户对自己的事的陈述。** 法定倍数同理：「2 倍工资」的来源是条文本身，
   * 而给出的出路「用 claim_calc 算」根本算不出一个法定倍数。
   * 它们是每轮几乎必现的数字类别，漏掉就会把 2% 的替换率预算顶穿，
   * 而超预算的处置是"按闸误伤查闸"——闸每天给自己制造一次复查。
   */
  const STATUTE_CARD = {
    facts: {
      statute_quotes: [
        { law: '某某某某法', article: '第八十二条', text: '用工方应当向劳动者每月支付二倍的工资。' },
        { law: '某某税法', article: '第三条', text: '适用百分之三至百分之四十五的超额累进税率。' },
      ],
    },
  };

  it('法条原文里的法定倍数：模型写阿拉伯「2 倍」放行（删掉 statute_quotes 那段收集 → 红）', () => {
    expect(mark('未签合同可以主张 2 倍工资。', { retrieved: [STATUTE_CARD] }).violations).toHaveLength(0);
  });

  it('跨数字体系：条文写「百分之四十五」，模型写「45%」放行（删掉 cnNumeral 那一支 → 红）', () => {
    expect(mark('最高一档是 45%。', { retrieved: [STATUTE_CARD] }).violations).toHaveLength(0);
  });

  it('负样本：条文里没有的倍数照标（否则"有卡就全放行"，闸等于关掉）', () => {
    expect(mark('可以主张 5 倍工资。', { retrieved: [STATUTE_CARD] }).text).toContain(VALUE_UNSOURCED);
  });

  it('档案事实：月工资来自档案 → 复述它放行（删掉 caseFacts 那段 → 红）', () => {
    expect(mark('你月薪 20000 元。', { caseFacts: [20000] }).violations).toHaveLength(0);
    expect(mark('你月薪 2 万。', { caseFacts: [20000] }).violations).toHaveLength(0);
  });

  it('用户自述：他自己说过的数，模型复述不算编造（删掉 userTurns 那段 → 红）', () => {
    const said = ['我们全公司三万人，这次裁了 1%，我月薪 2 万。'];
    const r = mark('你说全公司 3 万人、裁了 1%、月薪 2 万——先把这三件事记下来。', { userTurns: said });
    expect(r.text, `被标的：${r.violations.map((v) => v.token).join('、')}`).not.toContain(VALUE_UNSOURCED);
  });

  it('负样本：用户没说过的数照标（把 userTurns 当"有就全放行" → 红）', () => {
    const r = mark('你大概能拿到 60 万。', { userTurns: ['我月薪 2 万。'] });
    expect(r.text).toContain(VALUE_UNSOURCED);
  });

  it('类别不许串：卡里有「2 倍」，正文写「2 元」仍要判（只比数字不比类别 → 红）', () => {
    expect(mark('赔你 2 元。', { retrieved: [STATUTE_CARD] }).text).toContain(VALUE_UNSOURCED);
  });
});

/**
 * 【结构化来源那一份也必须分类别（2026-09-08 复审 major）】上面那条「类别不许串」
 * 管住的只是**语料型**来源（法条原文、用户自述），它们天然带类别（`倍数:2`）。
 * 而 calc 出参与 `facts.values` 这两份**结构化**来源当时是一个不分类别的大集合：
 * 本轮算一次 N，出参里同时带着月数 12、封顶倍数 3、年限 7.5、以分为单位的工资 2000000，
 * 模型顺口写「按 12 倍谈」「税率 3%」「工龄折 7.5 倍」「20000 倍」——**四处全部放行**，
 * 因为这四个数确实都在出参里。闸退化成一张只看数字、不看它断言什么的白名单。
 */
describe('要件 L · 放行集按类别分格：出参里的月数不许去放行「倍」与「%」', () => {
  /** 一次 N 的出参：金额 142500 元（分位 14250000），另有月数 12、封顶倍数 3、年限 7.5、月薪 20000 元 */
  const N_CALC = {
    kind: 'N',
    amount_fen: 14_250_000,
    amount_yuan: '142500.00',
    inputs: { months: 12, cap_multiplier: 3, years: 7.5, avg_monthly_wage_fen: 2_000_000 },
  };

  it.each([
    ['这一段按 12 倍算。', '12 倍', '出参里的 12 是**补偿月数**'],
    ['税率大概 3%。', '3%', '出参里的 3 是**封顶倍数**'],
    ['工龄折 7.5 倍。', '7.5 倍', '出参里的 7.5 是**年限**'],
    ['封顶是社平的 20000 倍。', '20000 倍', '出参里的 20000 是**月工资（元）**'],
  ])('负样本：「%s」照标（把三格合并回一个集合 → 红）', (text, token) => {
    const r = mark(text, { calcPayloads: [N_CALC] });
    expect(r.violations.map((v) => v.token), `放行了 ${token} —— 放行集没分类别`).toEqual([token]);
    expect(r.violations[0].mark).toBe('unsourced');
  });

  it('正对照：同一份出参里的**金额**照旧放行，逐字与约写两种写法都放（分格分过头 → 红）', () => {
    expect(mark('算下来是 142500 元。', { calcPayloads: [N_CALC] }).violations).toHaveLength(0);
    expect(mark('算下来大概 14.3 万元。', { calcPayloads: [N_CALC] }).violations).toHaveLength(0);
  });

  it('卡里的数按**单位**归类：unit 是年的 3 不放行「3 倍」，unit 是倍的 3 才放行', () => {
    const yearCard = {
      facts: { values: [{ key: 'shixiao-years', value: 3, unit: '年', effective_from: '2021-01-01', confidence: '原文核实' }] },
    };
    const timesCard = {
      facts: { values: [{ key: 'sanbei', value: 3, unit: '倍', effective_from: '2021-01-01', confidence: '原文核实' }] },
    };
    expect(mark('封顶是社平的 3 倍。', { retrieved: [yearCard] }).text).toContain(VALUE_UNSOURCED);
    expect(mark('封顶是社平的 3 倍。', { retrieved: [timesCard] }).violations).toHaveLength(0);
    // 反向也不许串：unit 是倍的 3 不放行「3 元」
    expect(mark('赔你 3 元。', { retrieved: [timesCard] }).text).toContain(VALUE_UNSOURCED);
  });

  it('百分比只认**标为比率**的出参字段：rate 0.3 放行「30%」，未标为比率的 3 不放行「3%」', () => {
    const rated = { kind: '竞业补偿', amount_fen: 100_000, inputs: { rate: 0.3, months: 3 } };
    expect(mark('按 30% 计。', { calcPayloads: [rated] }).violations).toHaveLength(0);
    // 同一份出参里的 months=3 不是比率 → 「3%」照标（把 ratiosIn 换成整份出参 → 红）
    expect(mark('按 3% 计。', { calcPayloads: [rated] }).text).toContain(VALUE_UNSOURCED);
  });
});

describe('要件 J · 约写：按自己写的位数四舍五入后相等 → 放行，不是「不一致」', () => {
  /**
   * 封顶数在真语料里几乎总以万元约写出现（卡里 47103.25，正文写「约 4.71 万元」）。
   * 按容差判它落在 ±0.5% 内却不相等 → 【数值与来源卡不一致】，
   * 而那句标记对读者说的是"你抄错了"——他抄对了，只是四舍五入。
   */
  it('「4.71 万元」「4.7 万」是 47103.25 的约写 → 放行（删掉 isRoundedForm → 红，会变成"不一致"）', () => {
    const r = mark('封顶是 47103.25 元，约 4.71 万元，也就是 4.7 万。', { retrieved: [CARD] });
    expect(r.text, `被标的：${r.violations.map((v) => v.token).join('、')}`).toBe(
      '封顶是 47103.25 元，约 4.71 万元，也就是 4.7 万。',
    );
  });

  it('负对照：写到个位却不等（47100 元）仍是【不一致】——它声称的精度就是个位', () => {
    expect(mark('上限基数是 47100 元。', { retrieved: [CARD] }).text).toContain(VALUE_MISMATCH);
  });

  it('负对照：位数对了但数不对（4.72 万元）照样【不一致】（把判据写成"只要带万就放行" → 红）', () => {
    expect(mark('大约 4.72 万元。', { retrieved: [CARD] }).text).toContain(VALUE_MISMATCH);
  });
});

describe('要件 K · 算出来的数与卡里的数一视同仁（2026-09-08 复审 major）', () => {
  /**
   * 【它挡的是 charter 的主路，不是边角】charter §3 是"一切金额走 claim_calc"。
   * 只认逐字相等的形态是：模型刚算完 47103.25，正文写「算下来约 4.7 万元，
   * 精确一点是 4.71 万」——**两处都被标【数值无来源】**，而出路还叫他
   *「回我一句帮我算一下」。每一轮把结果写成整数或万元的输出都会开火并计进替换率，
   * 2% 的预算在最该干净的那一轮被顶穿，成绩单点名"闸误伤"，而闸误伤的正是它自己的主路。
   */
  const CAP_CALC = { kind: 'N', amount_fen: 4_710_325, amount_yuan: '47103.25' };

  it('约写：刚算出来的 47103.25 写成「约 4.7 万元」「4.71 万」放行（只喂 exact 集 → 红）', () => {
    const r = mark('算下来约 4.7 万元，精确一点是 4.71 万。', { calcPayloads: [CAP_CALC] });
    expect(r.text, `被标的：${r.violations.map((v) => v.token).join('、')}`).toBe('算下来约 4.7 万元，精确一点是 4.71 万。');
  });

  it('抹掉分位：写「47103 元」是四舍五入到个位，照样放行（约写只喂 cardValues → 红）', () => {
    expect(mark('算下来是 47103 元。', { calcPayloads: [CAP_CALC] }).violations).toHaveLength(0);
  });

  it('抄错一位（47100 元）→ 与**算出来的数**不一致，且出路指向算式而不是来源卡', () => {
    const r = mark('算下来是 47100 元。', { calcPayloads: [CAP_CALC] });
    expect(r.text).toContain(VALUE_MISMATCH);
    expect(r.text).not.toContain(VALUE_UNSOURCED);
    expect(r.violations[0]).toMatchObject({ mark: 'mismatch', nearest: '47103.25', nearestFrom: 'calc' });
  });

  it('卡与算出来的数同时在场时，卡优先认领（两份混成一份 → 出路会指错地方）', () => {
    const r = mark('上限基数是 47100 元。', { retrieved: [CARD], calcPayloads: [CAP_CALC] });
    expect(r.violations[0]).toMatchObject({ mark: 'mismatch', nearestFrom: 'card' });
  });

  it('负对照：容差之外的数照标无来源（否则"算过钱就全放行"，闸等于关掉）', () => {
    expect(mark('算下来是 60 万。', { calcPayloads: [CAP_CALC] }).text).toContain(VALUE_UNSOURCED);
  });

  it('出路按来源分：算出来的那个数走算式，不叫用户去翻来源卡（合成一句 → 红）', () => {
    const msg = valueNoticeMessage([
      { token: '47103 元', kind: '金额', mark: 'mismatch', nearest: '47103.25', nearestFrom: 'calc' },
    ]);
    expect(msg).toContain('claim_calc');
    expect(msg).toContain('算式');
    expect(msg).not.toContain('生效期间');
  });
});

describe('要件 K3 · 出参散文里写着的法定倍率（2026-09-08 第三轮复审 major）', () => {
  /**
   * 【它误伤的是算钱器自己写下的数】加班费的 `formula` / `steps` 里逐字写着
   *「×150%」「×200%」「×300%」——三档法定倍率由 calcOvertimePay 产出，模型照抄进正文
   *（「工作日延时按 150% 算」）。而出参里的数字走 `numbersIn` 落进**金额**那一格，
   * 百分比那一格只收 `ratiosIn` 认得出的比率字段，出参里没有 `rate: 1.5` 这种字段。
   * 于是三处全被标【数值无来源】，出路还叫他"回我一句帮我算一下"——他复述的正是这一轮
   * 算出来的东西。加班费是高频诉求，每算一次开三次火，替换率预算被顶在最该干净的那一轮。
   *
   * **来源必须是真出参**：手写一个 `{ formula: '…150%…' }` 的假 payload，
   * 只证明这条代码路径通，证明不了产线那三个百分号确实写在出参里
   *（算钱器哪天把 `×150%` 改写成 `×1.5`，假 payload 的测试照样绿）。
   */
  const OT = calcOvertimePay({ monthlyBaseFen: 1_087_500, weekdayOvertimeHours: 10, restDayDays: 1, holidayDays: 1 });
  /** 形状同 claims.persistCalc 的 payload（只取 ⑨ 读得到的那几个字段） */
  const OT_PAYLOAD = {
    kind: OT.kind,
    amount_fen: OT.amountFen,
    amount_yuan: (OT.amountFen / 100).toFixed(2),
    formula: OT.formula,
    steps: OT.steps,
    inputs: OT.inputs,
  };

  it('前置：真出参的 formula 里确实逐字写着三档倍率（算钱器改写法 → 这条先红）', () => {
    expect(OT.formula).toContain('150%');
    expect(OT.formula).toContain('200%');
    expect(OT.formula).toContain('300%');
  });

  it('正对照：150% / 200% / 300% 三处放行（删掉 percentLiteralsIn 那一行收集 → 红）', () => {
    const text = '工作日延时按 150% 算，休息日未补休按 200%，法定节假日按 300%。';
    const r = mark(text, { calcPayloads: [OT_PAYLOAD] });
    expect(r.text, `被标的：${r.violations.map((v) => v.token).join('、')}`).toBe(text);
    expect(r.seen).toBe(3);
  });

  it('对照臂：出参里没有的「350%」照标（否则等于"算过加班费就百分比全放行"）', () => {
    const r = mark('还有 350% 那一档。', { calcPayloads: [OT_PAYLOAD] });
    expect(r.text).toContain(VALUE_UNSOURCED);
    expect(r.violations[0]).toMatchObject({ token: '350%', kind: '百分比', mark: 'unsourced' });
  });

  it('不串类别：`%` 是类别标记，收进来的 150 不放行「150 倍」（把它并进金额格 → 红）', () => {
    expect(mark('按 150 倍赔。', { calcPayloads: [OT_PAYLOAD] }).text).toContain(VALUE_UNSOURCED);
  });
});

describe('要件 E · 免检：引号内、引用块、闸自己的标记', () => {
  it('引号内的原文数字免检（删掉 exempt 的引号计数 → 红）', () => {
    const r = mark('原文写的是「……按 300% 支付，且不超过 24000 元」。');
    expect(r.violations).toHaveLength(0);
    expect(r.seen).toBe(0);
  });

  it('markdown 引用块整行免检（删掉 exempt 的 `>` 分支 → 红）', () => {
    expect(mark('> 第四十七条　……超过 3 倍的，按 3 倍计算。\n').violations).toHaveLength(0);
  });

  it('紧跟在 ⑥ 标记后面的数值照常判（⑥ 的标记里没有数字，⑨ 不为它开免检——见 value-guard 文件头）', () => {
    const r = mark('见《某法》第四十六条【条号待核验】，这一项大约 60 万。');
    expect(r.violations).toHaveLength(1);
    expect(r.text).toContain(`60 万${VALUE_UNSOURCED}`);
  });

  /**
   * 【⑨ 只认闭合成对的引号（2026-09-08 复审 minor）】流上的 ⑥ 对未闭合引号是宽容的
   *（它看不见后文，只能开着走一段再收回），⑨ 是 post 闸、拿到整段，没有这个处境。
   * 继承那份宽容的下场是**纯漏拦面**：真实转录里「HR 说：“你签了吧。」这种半个引号很常见，
   * 一个漏打的 `”` 就让其后整篇回复的金额、倍数全部免检，而 gate_report 报「候选 0 处」。
   */
  it('未闭合的引号不给免检：其后的金额照判（把 requireClosed 去掉 → 红）', () => {
    const r = mark('HR 说：“你签了吧。\n\n我算了一下，一般按 3N 谈，大概 60 万。');
    expect(r.violations.map((v) => v.token)).toEqual(['3N', '60 万']);
  });

  it('正对照：同一段把引号补齐，引号内的数就免检（证明上一条不是"根本不认引号"）', () => {
    const r = mark('HR 说：“你签了吧，一般按 3N 谈，大概 60 万。”');
    expect(r.violations).toHaveLength(0);
    expect(r.seen).toBe(0);
  });

  it('负样本：把免检整段删掉之后，同一段引号内文本会被标（证明上面几条不是恒真）', () => {
    // 同样的数字挪出引号即被判——这条保证"免检"确实在做事，而不是那些数字本来就不会被捕
    expect(mark('这一段按 300% 算。').violations).toHaveLength(1);
  });
});

describe('要件 F · 日期只在期限语境里判（其余是用户自己讲的事实）', () => {
  const DEADLINES = [{ due_at: '2026-09-30T00:00:00.000Z' }];

  it('正对照：期限语境里的日期与档案里的期限一致 → 放行（删掉 dueDates 收集 → 红）', () => {
    expect(mark('这条时效到 2026-09-30 到期。', { deadlines: DEADLINES }).violations).toHaveLength(0);
  });

  it('负样本：期限语境里的日期与档案对不上 → 标记（把日期整段跳过 → 红）', () => {
    const r = mark('这条时效到 2026-12-31 到期。', { deadlines: DEADLINES });
    expect(r.text).toContain(VALUE_UNSOURCED);
    expect(r.violations[0].kind).toBe('日期');
  });

  it('不误伤：不在期限语境里的日期一个都不判（删掉 DEADLINE_CUE 判断 → 红）', () => {
    const r = mark('你 2024 年 3 月 1 日入职，2026 年 8 月 20 日收到通知。', { deadlines: DEADLINES });
    expect(r.violations).toHaveLength(0);
    expect(r.seen).toBe(0);
  });

  it('语境词在日期之后也算（只朝前找 → 红；教训 8「预设的不是词，是位置」）', () => {
    expect(mark('2026-12-31 是最后一天。', { deadlines: DEADLINES }).violations).toHaveLength(1);
  });
});

describe('要件 G · 标记是增不是删：原文一个字都不能少', () => {
  it('多处标记时偏移不许错位（把倒序插入改成正序 → 红）', () => {
    const r = mark('先给 60 万，再看 3 倍，最后是 30%。');
    expect(r.violations).toHaveLength(3);
    expect(r.text).toBe(
      `先给 60 万${VALUE_UNSOURCED}，再看 3 倍${VALUE_UNSOURCED}，最后是 30%${VALUE_UNSOURCED}。`,
    );
  });

  it('把标记全部抠掉后与原文逐字相同（证明它一个字都没删）', () => {
    const src = '先给 60 万，再看 3 倍，最后是 30%。';
    const stripped = mark(src).text.split(VALUE_UNSOURCED).join('');
    expect(stripped).toBe(src);
  });
});

describe('要件 H · 禁令必配出路（设计稿 §7.7）', () => {
  it('无来源的出路点名 claim_calc（删掉出路句 → 红）', () => {
    const msg = valueNoticeMessage([{ token: '60 万', kind: '金额', mark: 'unsourced' }]);
    expect(msg).toContain('claim_calc');
    expect(msg).toContain('算式');
  });

  it('不一致的出路是来源卡，不是 claim_calc（两种标记共用一句 → 红）', () => {
    const msg = valueNoticeMessage([{ token: '47100 元', kind: '金额', mark: 'mismatch', nearest: '47103.25' }]);
    expect(msg).toContain('来源卡');
    expect(msg).toContain('47103.25');
  });

  it('零违规时不产出文案', () => expect(valueNoticeMessage([])).toBe(''));

  /**
   * 【出路句里引的那句话，必须与 chip 逐字相同】提示行叫他说 A、chip 发出去的是 B 的形态是：
   * 用户点完之后，回复答的是另一件事，而他并不知道自己刚才发出去的是什么。
   */
  it.each([
    [{ token: '60 万', kind: '金额' as const, mark: 'unsourced' as const }],
    [{ token: '47100 元', kind: '金额' as const, mark: 'mismatch' as const, nearest: '47103.25', nearestFrom: 'calc' as const }],
    [{ token: '47100 元', kind: '金额' as const, mark: 'mismatch' as const, nearest: '47103.25', nearestFrom: 'card' as const }],
  ])('suggest 与出路句同一句话（%j）', (v) => {
    const suggest = valueNoticeSuggest([v])!;
    expect(suggest, '这一支没有 chip → 闸提示行整条不出现').toBeTruthy();
    expect(valueNoticeMessage([v])).toContain(`「${suggest}」`);
  });

  it('三种判定给三句不同的话（合成一句 → 把用户指去一张与这个数无关的卡）', () => {
    const one = valueNoticeSuggest([{ token: '60 万', kind: '金额' as const, mark: 'unsourced' as const }]);
    const two = valueNoticeSuggest([
      { token: '47100 元', kind: '金额' as const, mark: 'mismatch' as const, nearest: '47103.25', nearestFrom: 'calc' as const },
    ]);
    const three = valueNoticeSuggest([
      { token: '47100 元', kind: '金额' as const, mark: 'mismatch' as const, nearest: '47103.25', nearestFrom: 'card' as const },
    ]);
    expect(new Set([one, two, three]).size).toBe(3);
  });

  it('零违规时没有 chip（空 chip 会渲染成一枚点了什么都不发生的按钮）', () => {
    expect(valueNoticeSuggest([])).toBeUndefined();
  });
});
