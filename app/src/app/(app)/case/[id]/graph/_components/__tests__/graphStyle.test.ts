import { describe, expect, it } from 'vitest';
import { mockCompanyGraph } from '@/app/_mock/company-graph';
import { edgeKind, hasArrow } from '../graphStyle';

describe('edgeKind', () => {
  it('括号里否认股权的关系不算股权边', () => {
    // 这两条原本按关键词扫全串，被括号里的「非直接股权」「无股权链一手证据」
    // 带成了实线+箭头，看上去像真有持股关系
    expect(edgeKind('同一实控体系(非直接股权，平行主体)')).toBe('control');
    expect(edgeKind('同属同一品牌矩阵(无股权链一手证据，不作连带责任现成证据)')).toBe(
      'brand',
    );
  });

  it('股权类走实线并带箭头', () => {
    for (const relation of ['持股100%', '持股100%(法人独资)', '持股93.33%(2014旧报道，或已过时)']) {
      expect(edgeKind(relation), relation).toBe('equity');
      expect(hasArrow(relation), relation).toBe(true);
    }
  });

  it('同法代/实控类走虚线且不带箭头', () => {
    for (const relation of ['担任法定代表人', '实控', '同一实控体系(非直接股权，平行主体)']) {
      expect(edgeKind(relation), relation).toBe('control');
      expect(hasArrow(relation), relation).toBe(false);
    }
  });

  it('演示数据里三档都有边，没有落空的档', () => {
    const kinds = new Set(mockCompanyGraph.edges.map((e) => edgeKind(e.relation)));
    expect([...kinds].sort()).toEqual(['brand', 'control', 'equity']);
  });
});
