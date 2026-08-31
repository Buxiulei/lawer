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
