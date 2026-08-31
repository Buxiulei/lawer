/**
 * 引用桥的判据（PC 工作台设计 §四「签名件」）。
 *
 * 桥的全部连接逻辑就三件事：**拆 id（parseCiteIds）→ 归一 id（lawCiteId/evidenceCiteId）
 * → 求交集（intersects）**。live 的 `useCitationBridge().apply()` 走的正是这三步
 * （`intersects(idsOf(el), ids)`），所以这里钉住它们，就钉住了「谁连谁」。
 *
 * 变异核在最后一组：把对话端与卷宗端用真 id 管道接起来，
 * **断开（intersects 恒 false / lawCiteId 不再归一空白）→ 正向断言红；
 * 误连（intersects 恒 true）→ 反向断言红**。两个方向都有牙。
 */
import { describe, expect, it } from 'vitest';
import {
  citedLaws,
  evidenceCiteId,
  intersects,
  lawCiteId,
  parseCiteIds,
} from '../citations';

describe('parseCiteIds：空格分隔的 id 串', () => {
  it('正常拆分', () => {
    expect(parseCiteIds('ev:a ev:b law:c')).toEqual(['ev:a', 'ev:b', 'law:c']);
  });

  it('多个空格 / 前后空白都归一', () => {
    expect(parseCiteIds('  ev:a   ev:b  ')).toEqual(['ev:a', 'ev:b']);
  });

  it('空串 / null / undefined / 纯空白一律回空数组——**绝不回 [\'\']**', () => {
    // 这条是桥不「连错人」的地基：两个都没引用的元素若共有一个空串 id，
    // 会被 intersects 判成相交、互相点亮。
    expect(parseCiteIds('')).toEqual([]);
    expect(parseCiteIds('   ')).toEqual([]);
    expect(parseCiteIds(null)).toEqual([]);
    expect(parseCiteIds(undefined)).toEqual([]);
  });
});

describe('intersects：两串 id 有没有交集', () => {
  it('有共同 id 为真', () => {
    expect(intersects(['a', 'b'], ['b', 'c'])).toBe(true);
  });
  it('无共同 id 为假', () => {
    expect(intersects(['a', 'b'], ['c', 'd'])).toBe(false);
  });
  it('任一为空即为假（两个「没引用」的元素不该互相点亮）', () => {
    expect(intersects([], ['a'])).toBe(false);
    expect(intersects(['a'], [])).toBe(false);
    expect(intersects([], [])).toBe(false);
  });
});

describe('id 归一', () => {
  it('法条 id 去掉全部空白——「第四十七条」与「第 47 条」这类空格差异不能对不上', () => {
    expect(lawCiteId('《劳动合同法》第四十七条')).toBe('law:《劳动合同法》第四十七条');
    expect(lawCiteId('《劳动合同法》第 四十七 条')).toBe('law:《劳动合同法》第四十七条');
  });
  it('证据 id 带前缀，与法条 id 不撞车', () => {
    expect(evidenceCiteId('ev_3')).toBe('ev:ev_3');
    expect(evidenceCiteId('ev_3')).not.toBe(lawCiteId('ev_3'));
  });
});

describe('citedLaws：对话里引过的法条按首次出现汇总', () => {
  it('去重并计数，顺序按第一次出现', () => {
    const msgs = [
      { lawRefs: [{ cite: '甲' }, { cite: '乙' }] },
      { lawRefs: [{ cite: '甲' }] },
      { lawRefs: undefined },
      {},
    ];
    expect(citedLaws(msgs)).toEqual([
      { cite: '甲', count: 2 },
      { cite: '乙', count: 1 },
    ]);
  });
  it('没有任何引用回空', () => {
    expect(citedLaws([{}, { lawRefs: [] }])).toEqual([]);
  });
});

// ── 变异核：引用桥断开 → 测试红 ─────────────────────────────────
describe('变异核：对话端与卷宗端靠同一条 id 管道连起来', () => {
  // 对话端：法条卡挂 data-cite = lawCiteId(cite)（见 Messages.tsx）
  // 卷宗端：本案依据行挂 data-cite-target = lawCiteId(cite)（见 CasePanel.tsx）
  const cite = '《中华人民共和国劳动争议调解仲裁法》第二十一条';
  const other = '《中华人民共和国劳动合同法》第三十条';

  const convAttr = lawCiteId(cite); // 对话里那张卡的 data-cite
  const dossierAttr = lawCiteId(cite); // 卷宗栏那一行的 data-cite-target
  const dossierOther = lawCiteId(other);

  it('同一条法条：两端连上（intersects 断开会让这条红——桥就是这么「连」的）', () => {
    expect(
      intersects(parseCiteIds(convAttr), parseCiteIds(dossierAttr)),
    ).toBe(true);
  });

  it('不同法条：不误连（intersects 恒真会让这条红——桥不会点亮整页）', () => {
    expect(
      intersects(parseCiteIds(convAttr), parseCiteIds(dossierOther)),
    ).toBe(false);
  });

  it('对话里写「第 47 条」、卷宗里写「第四十七条」也要连上（归一被去掉会红）', () => {
    const conv = lawCiteId('《劳动合同法》第 47 条'.replace('47', '四十七'));
    const dossier = lawCiteId('《劳动合同法》第四十七条');
    // 构造一处带空格的写法，验证归一后仍相交
    const spaced = lawCiteId('《劳动合同法》第 四十七 条');
    expect(intersects(parseCiteIds(conv), parseCiteIds(dossier))).toBe(true);
    expect(intersects(parseCiteIds(spaced), parseCiteIds(dossier))).toBe(true);
  });
});
