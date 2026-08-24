// app/src/lib/agent/__tests__/core-articles.test.ts
// 核心依据条标注（解 S03#2 真挂）。
//
// 【为什么不是"每条必须带原文"】那条粗规则会盖掉核心/辅助分层与 pending 三分支。
// S03#2 的真实形态是：模型对结论句同句的那条只给了条号——它不是不会引，
// 是**不知道哪条值得引全**。所以修法是**把"哪条是核心"从模型的判断变成注入的事实**：
// 降低正确行为的成本，而不是提高错误行为的代价。
import { describe, expect, it } from 'vitest';

import {
  articleKey,
  coreArticleKeys,
  CORE_ARTICLE_MAP_PACK_ID,
  packCitationGuide,
  sceneCoreArticles,
} from '../citation-block';
import { createKnowledgeSearcher } from '../knowledge-adapter';
import { listPacks } from '@/lib/knowledge';
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


// ───────── B 件：S3 场景映射表（manager 2026-08-25 批准，语义 = 优先权而非追加配额）─────────
describe('S3 场景映射：优先占上限，不是追加配额', () => {
  const statutePack = (arts: string[]) => ({
    facts: { statute_quotes: arts.map((a) => ({ law: '劳动合同法', article: a, text: `${a}的逐字原文……` })) },
  });
  const MAP = {
    facts: {
      core_article_map: [
        { scene: '约谈中', articles: ['劳动合同法|第46条', '劳动合同法|第47条', '劳动合同法|第87条'] },
        { scene: '风声', articles: ['劳动合同法|第46条'] },
        { scene: '风声', claim_kind: '欠薪', articles: ['劳动合同法|第38条'] },
      ],
    },
  };

  describe('sceneCoreArticles：键取自现有结构化字段，不新增模型判断', () => {
    it('二元组精确命中优先于 scene 单键', () => {
      expect(sceneCoreArticles(MAP, '风声', ['欠薪'])).toEqual(['劳动合同法|第38条']);
    });

    it('claims 为空（首诊轮）→ 退 scene 单键，这正是本档要覆盖的那一轮', () => {
      expect(sceneCoreArticles(MAP, '风声', [])).toEqual(['劳动合同法|第46条']);
    });

    it('claim_kind 对不上时也退单键，不硬套别的行', () => {
      expect(sceneCoreArticles(MAP, '风声', ['年假'])).toEqual(['劳动合同法|第46条']);
    });

    it('未列入的阶段不做兜底 → 空，落回 S2 现状', () => {
      expect(sceneCoreArticles(MAP, '二审', [])).toEqual([]);
      expect(sceneCoreArticles(MAP, null, [])).toEqual([]);
      expect(sceneCoreArticles(undefined, '约谈中', [])).toEqual([]);
    });
  });

  // 得分序是 39/40/41/46/47/87；映射点名 46/47/87——它们排在得分序第 4-6 位
  const retrieved = [statutePack(['第三十九条', '第四十条', '第四十一条', '第四十六条', '第四十七条', '第八十七条'])];
  const scene = sceneCoreArticles(MAP, '约谈中', []);

  it('★映射命中的条优先占满上限，得分序靠前但非核心的被挤出', () => {
    const core = coreArticleKeys({ retrieved, sceneArticles: scene });
    expect([...core]).toEqual(['劳动合同法|第46条', '劳动合同法|第47条', '劳动合同法|第87条']);
    expect(core.has('劳动合同法|第39条')).toBe(false);
  });

  it('★总数恒 ≤ 3：映射 3 条 + 得分序一堆，仍然只出 3 条', () => {
    expect(coreArticleKeys({ retrieved, sceneArticles: scene }).size).toBe(3);
  });

  it('★映射只命中 1 条时，S2 按得分序补足到 3（补位，不是替换）', () => {
    const core = coreArticleKeys({ retrieved, sceneArticles: ['劳动合同法|第87条'] });
    expect([...core]).toEqual(['劳动合同法|第87条', '劳动合同法|第39条', '劳动合同法|第40条']);
  });

  it('★映射点名但取料面里没有的条 → 不入⭐（与用户点名同一条纪律）', () => {
    const core = coreArticleKeys({ retrieved: [statutePack(['第四十七条'])], sceneArticles: ['劳动合同法|第46条', '劳动合同法|第47条'] });
    expect(core.has('劳动合同法|第46条')).toBe(false);
    expect([...core]).toEqual(['劳动合同法|第47条']);
  });

  it('★S1 恒优先：档案非空时映射一条都渗不进来', () => {
    const s1 = { claims: [{ basis: '《劳动合同法实施条例》第二十七条' }] };
    expect([...coreArticleKeys({ ...s1, retrieved, sceneArticles: scene })]).toEqual([...coreArticleKeys(s1)]);
  });

  it('★S4 仍不占上限：映射占满 3 条后，用户点名的第 4 条照样进', () => {
    const core = coreArticleKeys({ retrieved, sceneArticles: scene, userMessage: '那第39条呢' });
    expect(core.size).toBe(4);
    expect(core.has('劳动合同法|第39条')).toBe(true);
  });
});

describe('S3 映射卡与真库的一致性（漂了就红）', () => {
  const searcher = createKnowledgeSearcher();
  const mapPack = searcher.get?.(CORE_ARTICLE_MAP_PACK_ID);

  /** 全库 statute_quotes 的真实键集合 */
  const libraryKeys = new Set<string>();
  for (const meta of listPacks()) {
    for (const q of searcher.get?.(meta.id)?.facts?.statute_quotes ?? []) libraryKeys.add(articleKey(q.law, q.article));
  }

  it('映射卡装得进来', () => {
    expect(mapPack?.facts?.core_article_map?.length).toBeGreaterThan(0);
  });

  // 【为什么这条守卫必须有】映射里写一个库内不存在的键，它永远命中不了取料面——
  // 不报错、不告警，就是**一行装饰**。而⭐会静默退回纯 S2，正是本次要修的那个 bug 的形态。
  it('★映射里的每个法条键都在库内 statute_quotes 里真实存在', () => {
    const bad: string[] = [];
    for (const row of mapPack?.facts?.core_article_map ?? []) {
      for (const key of row.articles) if (!libraryKeys.has(key)) bad.push(`${row.scene}${row.claim_kind ? `/${row.claim_kind}` : ''} → ${key}`);
    }
    expect(bad).toEqual([]);
  });

  it('★映射键的写法与 articleKey 归一口径一致（否则匹配时静默错过）', () => {
    for (const row of mapPack?.facts?.core_article_map ?? []) {
      for (const key of row.articles) {
        const [law, article] = key.split('|');
        expect(articleKey(law, article)).toBe(key);
      }
    }
  });

  // 【S03 真实回归】8101783 批三跑里得分序把《司法解释（二）》§3/§6/§7 排在 §46 前面，
  // 把真正决定补偿的那条挤出了封顶。映射表落地后必须反过来。
  it('★S03 形态回归：约谈中场景下 §46/§47/§87 占满 3 条，司法解释（二）被挤出', () => {
    const s = createKnowledgeSearcher();
    // 用 8101783 批 S03 转录里真实的 retrievedIds 顺序（司法解释二排在补偿核心卡之前）
    const retrieved = ['statute-fashi-2025-12-jieshi-2', 'statute-jgf-2024-534-jieda-1', 'statute-lhtf-38-beipo-jiechu', 'statute-lhtf-jiechu-buchang-core']
      .map((id) => s.get?.(id))
      .filter(Boolean) as { facts?: { statute_quotes?: { law: string; article: string; text: string }[] } }[];
    const core = coreArticleKeys({
      retrieved,
      sceneArticles: sceneCoreArticles(mapPack, '约谈中', []),
      userMessage: 'HR 给我协议让我今天下班前签，说今天不签明天名额就没了，最多只能给N',
    });
    expect([...core]).toEqual(['劳动合同法|第46条', '劳动合同法|第47条', '劳动合同法|第87条']);
    expect([...core].some((k) => k.includes('司法解释') || k.includes('解释（二）'))).toBe(false);
  });
});
