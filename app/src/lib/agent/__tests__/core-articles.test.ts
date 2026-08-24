// app/src/lib/agent/__tests__/core-articles.test.ts
// 核心依据条标注（解 S03#2 真挂）。
//
// 【为什么不是"每条必须带原文"】那条粗规则会盖掉核心/辅助分层与 pending 三分支。
// S03#2 的真实形态是：模型对结论句同句的那条只给了条号——它不是不会引，
// 是**不知道哪条值得引全**。所以修法是**把"哪条是核心"从模型的判断变成注入的事实**：
// 降低正确行为的成本，而不是提高错误行为的代价。
import { describe, expect, it } from 'vitest';

import { coreArticleKeys, packCitationGuide } from '../citation-block';
import type { KnowledgePack } from '../retrieval';

const pack = (quotes: { law: string; article: string; text: string }[]): KnowledgePack =>
  ({
    id: 'statute-x', title: '法条卡', type: '法条卡', region: '北京',
    confidence: '原文核实', updated: '2026-08-19', body: '正文',
    facts: { statute_quotes: quotes },
  }) as KnowledgePack;

describe('核心条判定：只认结构化事实，不让模型自己勾', () => {
  it('从 claims.basis 取（这是钱的依据，用户会拿它去主张）', () => {
    const keys = coreArticleKeys({ claims: [{ basis: '《劳动合同法实施条例》第二十七条；《劳动合同法》第四十七条' }] });
    expect(keys.has('劳动合同法实施条例|第27条')).toBe(true);
    expect(keys.has('劳动合同法|第47条')).toBe(true);
  });

  it('从行动卡 detail 取（行动卡是"现在做什么"，其依据必然核心）', () => {
    const keys = coreArticleKeys({ openActions: [{ detail: '为什么：依据《劳动争议调解仲裁法》第二十七条，时效一年' }] });
    expect(keys.has('劳动争议调解仲裁法|第27条')).toBe(true);
  });

  it('从期限推算依据取', () => {
    expect(coreArticleKeys({ deadlines: [{ derived_from: '《民事诉讼法》第八十五条' }] }).has('民事诉讼法|第85条')).toBe(true);
  });

  it('全称简称互认（卡写全称、档案写简称也要认出来）', () => {
    const keys = coreArticleKeys({ claims: [{ basis: '《中华人民共和国劳动合同法》第四十七条' }] });
    expect(keys.has('劳动合同法|第47条')).toBe(true);
  });

  it('档案为空时不产出核心条——**不猜**', () => {
    expect(coreArticleKeys({}).size).toBe(0);
  });
});

describe('引用块里的核心条标注', () => {
  const p = pack([
    { law: '劳动合同法实施条例', article: '第二十七条', text: '经济补偿的月工资按照劳动者应得工资计算……' },
    { law: '劳动争议调解仲裁法', article: '第二十七条', text: '劳动争议申请仲裁的时效期间为一年……' },
  ]);

  // S03#2 的正解：档案里的诉求金额依赖实施条例§27，于是它被标为核心、要求带原文
  it('核心条被显式标出并要求带逐字原文', () => {
    const guide = packCitationGuide(p, coreArticleKeys({ claims: [{ basis: '《劳动合同法实施条例》第二十七条' }] }));
    expect(guide).toContain('本轮核心依据条');
    expect(guide).toContain('《劳动合同法实施条例》第二十七条');
    expect(guide).toContain('必须带逐字原文');
    // 非核心条不被点名（其余可只给条号）
    expect(guide.split('本轮核心依据条')[1].split('\n')[0]).not.toContain('调解仲裁法');
  });

  it('没有核心条时不加这一段——**不制造噪音**', () => {
    const guide = packCitationGuide(p, new Set());
    expect(guide).not.toContain('本轮核心依据条');
  });

  it('同号不同法不得互相冒充（与 G4 复合键同一判据）', () => {
    const guide = packCitationGuide(p, coreArticleKeys({ claims: [{ basis: '《劳动争议调解仲裁法》第二十七条' }] }));
    const named = guide.split('本轮核心依据条')[1].split('\n')[0];
    expect(named).toContain('调解仲裁法');
    expect(named).not.toContain('实施条例');
  });
});

describe('跨数字体系：档案写阿拉伯、卡里存汉字，必须匹配得上', () => {
  // 【本次 bug 的行为侧一半】档案 basis 写「第46条第2项」、卡里存「第四十六条」，
  // 旧实现两边各存各的 → ⭐ 核心条块匹配不上 → 模型收不到"这条要引全"的指令。
  it('claims.basis 写「第46条第2项」时，⭐ 块能匹配到卡里的「第四十六条」', () => {
    const core = coreArticleKeys({ claims: [{ basis: '《劳动合同法》第46条第2项' }] });
    const guide = packCitationGuide(
      pack([{ law: '中华人民共和国劳动合同法', article: '第四十六条', text: '有下列情形之一的，用人单位应当向劳动者支付经济补偿……' }]),
      core,
    );
    expect(guide).toContain('本轮核心依据条');
    expect(guide).toContain('第四十六条');
  });

  it('反向也成立：档案写汉字、卡里存阿拉伯', () => {
    const core = coreArticleKeys({ claims: [{ basis: '《劳动合同法》第四十条' }] });
    const guide = packCitationGuide(pack([{ law: '劳动合同法', article: '第40条', text: '有下列情形之一的……' }]), core);
    expect(guide).toContain('本轮核心依据条');
  });

  it('**不同条不得互相冒充**：第4条 ≠ 第40条', () => {
    const core = coreArticleKeys({ claims: [{ basis: '《劳动合同法》第4条' }] });
    const guide = packCitationGuide(pack([{ law: '劳动合同法', article: '第四十条', text: '……' }]), core);
    expect(guide).not.toContain('本轮核心依据条');
  });

});

// ───────────── 首诊⭐核心条来源（S2 检索候选 / S4 用户点名，manager 2026-08-24 专议裁定）─────────────
//
// 【修的是什么】首诊轮档案三来源天然全空 → ⭐段整段不输出 → 模型收不到"哪条是核心"的信号，
// 而首诊恰恰是它最需要这个信号的一轮。补 S2/S4 两档候选，S1 仍恒优先。
describe('首诊⭐核心条来源', () => {
  const statutePack = (quotes: { law: string; article: string; text: string }[]) => ({ facts: { statute_quotes: quotes } });
  const q = (article: string, law = '劳动合同法') => ({ law, article, text: `${article}的逐字原文……` });

  describe('S2 主来源：S1 空时取本轮检索命中的 statute 卡，按得分序，封顶 3', () => {
    it('首轮空档案 + 检索含 statute 卡 → ⭐段非空，条目来自 S2', () => {
      const core = coreArticleKeys({ retrieved: [statutePack([q('第四十七条')])] });
      expect(core.has('劳动合同法|第47条')).toBe(true);
      const guide = packCitationGuide(pack([{ law: '劳动合同法', article: '第四十七条', text: '经济补偿按劳动者……' }]), core);
      expect(guide).toContain('本轮核心依据条');
      expect(guide).toContain('第四十七条');
    });

    it('★封顶不是配额：只命中 2 条就只给 2 条，不许凑数', () => {
      const core = coreArticleKeys({ retrieved: [statutePack([q('第四十六条'), q('第四十七条')])] });
      expect(core.size).toBe(2);
    });

    it('★封顶 3 条：命中 5 条只取检索得分序的前 3 条', () => {
      const core = coreArticleKeys({
        retrieved: [
          statutePack([q('第三十九条'), q('第四十条')]),
          statutePack([q('第四十一条'), q('第四十六条'), q('第四十七条')]),
        ],
      });
      expect(core.size).toBe(3);
      // 顺序即检索得分序：前一张卡的两条先进，后一张卡只进第一条
      expect([...core]).toEqual(['劳动合同法|第39条', '劳动合同法|第40条', '劳动合同法|第41条']);
    });

    it('检索命中的卡没有 statute_quotes → 不进候选池（⭐是"要引全"的指令，手上没原文时毫无意义）', () => {
      expect(coreArticleKeys({ retrieved: [{ facts: { case_facts: { gist: '案情' } } }] }).size).toBe(0);
    });
  });

  describe('S1 恒优先：三来源非空时行为与修前完全一致', () => {
    // 【回归的验证形式】不是"看起来差不多"，而是**同一份 S1 输入下，加不加 S2/S4 原料，
    // 产出的键集合必须逐字相同**——S2/S4 一条都不许渗进来。
    const s1 = { claims: [{ basis: '《劳动合同法实施条例》第二十七条' }] };
    const noise = {
      retrieved: [statutePack([q('第四十六条'), q('第四十七条'), q('第三十九条'), q('第四十条')])],
      userMessage: '我想问《劳动合同法》第40条怎么算',
    };

    it('★S1 非空时，S2/S4 原料一条都不渗入（键集合与只传 S1 时逐字相同）', () => {
      expect([...coreArticleKeys({ ...s1, ...noise })]).toEqual([...coreArticleKeys(s1)]);
    });

    it('★行动卡/期限单独非空时同样恒优先', () => {
      const byAction = { openActions: [{ detail: '依据《劳动争议调解仲裁法》第二十七条，时效一年' }] };
      expect([...coreArticleKeys({ ...byAction, ...noise })]).toEqual([...coreArticleKeys(byAction)]);
      const byDeadline = { deadlines: [{ derived_from: '《民事诉讼法》第八十五条' }] };
      expect([...coreArticleKeys({ ...byDeadline, ...noise })]).toEqual([...coreArticleKeys(byDeadline)]);
    });
  });

  describe('S4 追加：用户点名的条命中库内必入，且不占 3 条上限', () => {
    // 得分序前 3 条是 39/40/41，用户点名的 46 排在第 4——它必须**额外**进来，把上限撑到 4。
    const retrieved = [statutePack([q('第三十九条'), q('第四十条'), q('第四十一条'), q('第四十六条')])];

    it('★阿拉伯数字点名「第46条」→ 必入⭐且不占上限', () => {
      const core = coreArticleKeys({ retrieved, userMessage: '公司说按第46条给我补偿，对吗' });
      expect(core.has('劳动合同法|第46条')).toBe(true);
      expect(core.size).toBe(4); // S2 的 3 条 + S4 的 1 条
    });

    it('★汉字点名「第四十六条」→ 同一条，跨数字体系互认', () => {
      const core = coreArticleKeys({ retrieved, userMessage: '公司说按第四十六条给我补偿，对吗' });
      expect(core.has('劳动合同法|第46条')).toBe(true);
      expect(core.size).toBe(4);
    });

    it('带法名点名《劳动合同法》第46条也认（用户没写法名时按条号认）', () => {
      const core = coreArticleKeys({ retrieved, userMessage: '《劳动合同法》第46条是怎么规定的' });
      expect(core.has('劳动合同法|第46条')).toBe(true);
    });

    it('★库内无该条 → 不入⭐（回答层由第五闸走「待核实」口径，不在本函数）', () => {
      const core = coreArticleKeys({ retrieved: [statutePack([q('第四十七条')])], userMessage: '那第99条呢' });
      expect(core.has('劳动合同法|第99条')).toBe(false);
      expect([...core]).toEqual(['劳动合同法|第47条']);
    });

    it('点名的条正好在 S2 前 3 里 → 不重复计数', () => {
      const core = coreArticleKeys({ retrieved, userMessage: '第39条说的是什么' });
      expect(core.size).toBe(3);
    });
  });

  describe('候选池全空（S1 ∧ S2 ∧ S4 皆空）→ ⭐段照旧不出现', () => {
    it('★三档全空时产出空集，⭐段不出现', () => {
      const core = coreArticleKeys({ retrieved: [], userMessage: '公司要裁我，怎么办' });
      expect(core.size).toBe(0);
      expect(packCitationGuide(pack([{ law: '劳动合同法', article: '第四十七条', text: '……' }]), core)).not.toContain('本轮核心依据条');
    });

    it('用户点了名但一张 statute 卡都没检索到 → 仍然空（点名不能凭空造核心条）', () => {
      expect(coreArticleKeys({ retrieved: [], userMessage: '第46条怎么说' }).size).toBe(0);
    });
  });
});
