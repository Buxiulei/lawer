// app/src/lib/agent/__tests__/knowledge-adapter.test.ts
// lib/knowledge → agent 的适配层。跑的是**真实索引**（knowledge/ 全量卡），
// 因为这一层的全部价值就是「两边字段真的对得上」，用假数据测等于什么都没测。
import { describe, expect, it } from 'vitest';

import * as knowledge from '@/lib/knowledge';
import { DEFAULT_DOMAIN } from '@/lib/domains/registry';
import { articleKey } from '../citation-block';
import { createKnowledgeSearcher } from '../knowledge-adapter';

const searcher = createKnowledgeSearcher();

describe('字段对齐', () => {
  it('content 映射成 body，且是剥掉 frontmatter 的逐字正文', () => {
    const hits = knowledge.search('被迫解除 拖欠工资', { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);

    const packs = searcher.search('被迫解除 拖欠工资', { limit: 3 });
    expect(packs).toHaveLength(hits.length);
    expect(packs[0].body).toBe(hits[0].content);
    expect(packs[0].body).not.toContain('---\nid:');
    expect(packs[0].id).toBe(hits[0].id);
  });

  it('confidence 与 region 原样透传（charter §3 要求「待核实」如实带出）', () => {
    for (const p of searcher.search('北京 最低工资', { limit: 5 })) {
      expect(['原文核实', '二手转述', '待核实']).toContain(p.confidence);
      expect(p.region).toBeTruthy();
    }
  });

  it('type 过滤透传给检索器', () => {
    const packs = searcher.search('解除劳动合同', { limit: 5, type: '法条卡' });
    expect(packs.length).toBeGreaterThan(0);
    expect(packs.every((p) => p.type === '法条卡')).toBe(true);
  });

  it('limit 透传（不透传的话会退回检索器默认值 5，预检索就少拿卡）', () => {
    expect(searcher.search('调岗 降薪 异议', { limit: 2 })).toHaveLength(2);
  });
});

describe('失败语义：查不到 vs 装坏了', () => {
  it('空 query 回空数组而不是抛错——「没检索到」是 charter §3 的正常路径', () => {
    // lib/knowledge 对空 query 是抛错（它的 fail-loud 纪律），agent 侧不能被它炸掉整轮
    expect(() => knowledge.search('   ')).toThrow();
    expect(searcher.search('   ')).toEqual([]);
  });

  it('检索不到任何卡时回空数组，让保守路径接管', () => {
    expect(searcher.search('紫色大象量子力学披萨', { limit: 5 })).toEqual([]);
  });

  it('get 不存在的 id 回 undefined 而不是抛错', () => {
    expect(searcher.get!('statute-根本不存在的卡')).toBeUndefined();
  });

  it('get 命中时带回正文', () => {
    const one = knowledge.listPacks()[0];
    const got = searcher.get!(one.id);
    expect(got?.id).toBe(one.id);
    expect(got?.body.length).toBeGreaterThan(0);
  });
});

describe('检索质量：C04 剧本关心的那几类卡确实调得出来', () => {
  it.each([
    ['客观情况发生重大变化 解除', 'S02'],
    ['协商解除协议 签字 反悔', 'S03'],
    ['孕期 调岗 合理性', 'S04'],
    ['拖欠工资 被迫解除通知书', 'S07'],
    ['心理援助热线 危机', 'S08'],
    ['仲裁 立案 材料 朝阳', 'S10'],
    ['经济补偿 计算 基数 封顶', 'S14'],
  ])('「%s」有命中（%s 依赖它）', (query) => {
    expect(searcher.search(query, { limit: 6 }).length).toBeGreaterThan(0);
  });
});

describe('逐字条文注入也走领域闸（设计稿 §13：跨域召回默认关闭）', () => {
  // findByArticleKeys 是 search 之外的**第二条召回通路**：条号对上就把整张卡拉进上下文。
  // 只闸住 search 的形态是——检索面干干净净，而模型引一条通用法时注入回来的是别的领域的卡。
  /** 条号从真实索引里现取，不在判据里抄一份法名——抄的那份会在卡片改法名的那天变成空跑 */
  function firstQuoteKey(inDefaultDomain: boolean): string {
    const meta = knowledge
      .listPacks()
      .find(
        (m) =>
          (knowledge.packDomain(m) === DEFAULT_DOMAIN) === inDefaultDomain &&
          (m.facts?.statute_quotes?.length ?? 0) > 0,
      );
    const q = meta!.facts!.statute_quotes![0];
    return articleKey(q.law, q.article);
  }
  const OTHER_DOMAIN_KEY = firstQuoteKey(false);
  const OWN_DOMAIN_KEY = firstQuoteKey(true);

  it('判据自身不空跑：这条通用法确实被别的领域的卡逐字收录着', () => {
    const holders = knowledge
      .listPacks()
      .filter((m) =>
        (m.facts?.statute_quotes ?? []).some((q) => articleKey(q.law, q.article) === OTHER_DOMAIN_KEY),
      );
    expect(holders.length, '没有任何卡收录这一条 ⇒ 下面那条判据在空跑').toBeGreaterThan(0);
    expect(holders.every((m) => knowledge.packDomain(m) !== DEFAULT_DOMAIN)).toBe(true);
  });

  // 【标题改过，记在这】原标题写的是「变异：拿掉 articleIndex 里的领域过滤 → 红」，
  // 复审实测**不红**：findByArticleKeys 是经 `this.get` 取卡的，而 get 面自己有领域闸，
  // articleIndex 里那道过滤被它**完全遮蔽**（是第二层，不是这条判据的牙）。
  // 把牙记错位置的代价：后人读标题以为 articleIndex 那层独立守着，于是删掉 get 面的闸。
  it('别的领域收录的条文不会被注入进来（变异：拿掉 get 面的领域闸 → 红；单删 articleIndex 那道过滤不红，它被 get 面遮蔽）', () => {
    expect(searcher.findByArticleKeys!([OTHER_DOMAIN_KEY])).toEqual([]);
  });

  it('这条通路的域闸来自 get：findByArticleKeys 必须经 this.get 取卡（变异：改成绕过 get 直接造包 → 红）', () => {
    // 【为什么要钉这条结构】上一条判据的牙全在 get 面上。哪天有人为了省一次查找，
    // 把 findByArticleKeys 改成直接从索引元数据造 KnowledgePack，域闸就整条通路地没了，
    // 而上一条判据会因为 articleIndex 里那道遮蔽着的过滤**照样绿**。
    const withoutGet = { ...searcher, get: () => undefined };
    expect(withoutGet.findByArticleKeys!([OWN_DOMAIN_KEY])).toEqual([]);
    // 对照：同一个 key 经真正的 get 是取得到的，上一行不是因为 key 本身没人收录
    expect(searcher.findByArticleKeys!([OWN_DOMAIN_KEY]).length).toBeGreaterThan(0);
  });

  it('本域的条文照常取得到（闸不能关过头）', () => {
    const packs = searcher.findByArticleKeys!([OWN_DOMAIN_KEY]);
    expect(packs.length).toBeGreaterThan(0);
    // 域看 index 里那条元数据，不看回包——KnowledgePack 本来就不带 domain 字段，
    // 拿回包去判等于判了个恒真（undefined ?? 缺省域）。
    for (const p of packs) {
      const meta = knowledge.listPacks().find((m) => m.id === p.id)!;
      expect(knowledge.packDomain(meta), p.id).toBe(DEFAULT_DOMAIN);
    }
  });
});

describe('按 id 取卡也走领域闸（get 面没有守卫的话，search 闸干净了也没用）', () => {
  /** 库里第一张（不）属于缺省域的卡的 id；现取，不在判据里抄一份 id */
  function firstId(inDefaultDomain: boolean): string {
    const meta = knowledge
      .listPacks()
      .find((m) => (knowledge.packDomain(m) === DEFAULT_DOMAIN) === inDefaultDomain);
    expect(meta, `库里找不到${inDefaultDomain ? '缺省域' : '非缺省域'}的卡 ⇒ 这条判据在空跑`).toBeTruthy();
    return meta!.id;
  }

  it('别的领域的卡按 id 取不到（变异：拿掉 get 里的领域闸 → 红）', () => {
    expect(searcher.get!(firstId(false))).toBeUndefined();
  });

  it('本域的卡按 id 照常取得到（闸不能关过头）', () => {
    const id = firstId(true);
    expect(searcher.get!(id)?.id).toBe(id);
  });
});
