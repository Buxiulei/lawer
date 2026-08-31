// app/src/lib/dossier/__tests__/venue.test.ts
// 仲裁地风格卡：覆盖判定 + 「编出来的 id 变不成一张卡」。
import { describe, expect, it } from 'vitest';

import { isCoveredVenue, venueSection } from '../venue';

describe('首发只做北京朝阳', () => {
  it('北京朝阳覆盖，其它辖区一律不覆盖且不出任何卡', () => {
    expect(isCoveredVenue('北京朝阳')).toBe(true);
    for (const v of ['上海浦东', '北京海淀', '广州天河', '']) {
      expect(isCoveredVenue(v)).toBe(false);
      const section = venueSection(v);
      expect(section.covered).toBe(false);
      expect(section.cards).toHaveLength(0);
    }
  });

  it('北京朝阳这一节引的是真存在的存档卡，且带可信度与更新日', () => {
    const section = venueSection('北京朝阳');
    expect(section.covered).toBe(true);
    expect(section.cards.length).toBeGreaterThan(0);
    for (const card of section.cards) {
      expect(card.body.length).toBeGreaterThan(0);
      expect(card.confidence).toBeTruthy();
      expect(card.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // 朝阳立案 SOP 与北京仲裁案量这两张必须在（设计 §1.4 点名的卡）
    const ids = section.cards.map((c) => c.id);
    expect(ids).toContain('sop-chaoyang-lian-sop');
    expect(ids).toContain('data-beijing-zhongcai-anliang');
  });

  /**
   * 出处不是可选的。
   *
   * 【它此前是怎么静默坏掉的】frontmatter 里 sources 一直是必填，但索引生成器
   * 的 INDEX_FIELDS 没导出它 ⇒ loader 的 PackMeta 没这个字段 ⇒ venue.cardOf 只能填 `[]`
   * ⇒ 界面那一块「sources 非空才渲染」，于是**整块从来没渲染过**。
   * 全链路没有一处报错：卡里有出处、页面上没有出处，两边各自看着都对。
   *
   * 变异臂：把 gen-knowledge-index.py 的 INDEX_FIELDS 里的 "sources" 去掉重跑生成器，
   * 这条会红（loader 的入口守卫先炸，退一步说也是 sources 为空）。
   */
  it('每张卡都带得出出处，且朝阳立案 SOP 带的是官方源', () => {
    const section = venueSection('北京朝阳');
    for (const card of section.cards) {
      expect(`${card.id}:${card.sources.length > 0}`).toBe(`${card.id}:true`);
    }
    const lian = section.cards.find((c) => c.id === 'sop-chaoyang-lian-sop')!;
    // 朝阳区人社局办事指南页 + 官方附件包（模板 zip），逐字取自卡的 frontmatter
    expect(lian.sources).toContain(
      'http://www.bjchy.gov.cn/affair/ldwq/tjzc/8a24fe9767393e2d01673f3dbdc70a21.html',
    );
    expect(lian.sources.some((s) => s.includes('bjchy.gov.cn') && s.endsWith('.zip'))).toBe(true);
  });

  /**
   * 变异臂：把 cardOf 的 try/catch 去掉换成直接 knowledge.get，这条会红（抛错而不是丢弃）；
   * 把 catch 里改成返回一张占位卡，这条也会红（长度不对）。
   *
   * 这一条守的是将来接上 LLM 选卡的那一天：模型编一个 id 出来，
   * 它必须落地成"少一张卡"，而不是落地成一张卡或一个 500。
   */
  it('索引里没有的 id 一律丢弃，不抛错也不造占位卡', () => {
    const section = venueSection('北京朝阳', [
      'sop-chaoyang-lian-sop',
      'sop-完全编出来的一张卡',
      'data-beijing-zhongcai-anliang',
    ]);
    expect(section.cards.map((c) => c.id)).toEqual([
      'sop-chaoyang-lian-sop',
      'data-beijing-zhongcai-anliang',
    ]);
  });

  it('全是编出来的 id ⇒ 一张卡都没有，covered 仍为 true（不拿话术顶替）', () => {
    const section = venueSection('北京朝阳', ['a', 'b']);
    expect(section.covered).toBe(true);
    expect(section.cards).toHaveLength(0);
  });
});
