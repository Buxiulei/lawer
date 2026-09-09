// app/src/lib/cases/__tests__/source-tier.test.ts
// 来源四档的判据。每条后面括号里写的是**让它变红的变异**——
// 判据的价值等于「改坏源码时它会不会响」，不是「它今天绿不绿」。
import { describe, expect, it } from 'vitest';

import { CALC_VERSION } from '@/lib/agent/calc';
import type { InputSource } from '@/lib/agent/calc';

import {
  ASSERTED_BY,
  CALC_INPUT_SOURCE_TIER,
  DEFAULT_ASSERTED_BY,
  DEFAULT_SOURCE_TIER,
  DOC_EXTRACT_ORIGIN,
  isDocumented,
  noDocumentedFact,
  normalizeAssertedBy,
  normalizeSourceTier,
  SOURCE_TIERS,
  tierMark,
  tierOfCalcInputSource,
  tierRank,
} from '../source-tier';

describe('四档的顺序与门槛', () => {
  it('由弱到强恰好四档，缺省是最弱那一档（变异：把 DEFAULT_SOURCE_TIER 改成「书证」 → 红）', () => {
    expect([...SOURCE_TIERS]).toEqual(['自述', '书证', '对方认可', '裁审认定']);
    expect(DEFAULT_SOURCE_TIER).toBe('自述');
    expect(tierRank('自述')).toBe(0);
    for (let i = 1; i < SOURCE_TIERS.length; i += 1) {
      expect(tierRank(SOURCE_TIERS[i]), `${SOURCE_TIERS[i]} 应当强于 ${SOURCE_TIERS[i - 1]}`).toBeGreaterThan(
        tierRank(SOURCE_TIERS[i - 1]),
      );
    }
  });

  it('「书证及以上」恰好是后三档（变异：把 isDocumented 的门槛改成 > 书证、或改成 ≥ 自述 → 红）', () => {
    expect(isDocumented('自述')).toBe(false);
    expect(isDocumented('书证')).toBe(true);
    expect(isDocumented('对方认可')).toBe(true);
    expect(isDocumented('裁审认定')).toBe(true);
  });

  it('断言人四档，缺省是 user（变异：把缺省改成 agent_inferred → 红）', () => {
    expect([...ASSERTED_BY]).toEqual(['user', 'agent_inferred', 'doc_extract', 'system']);
    expect(DEFAULT_ASSERTED_BY).toBe('user');
  });

  it('提取写入这一对是「书证 + doc_extract」，成对固定（变异：把 tier 改成自述 → 红）', () => {
    expect(DOC_EXTRACT_ORIGIN).toEqual({ tier: '书证', assertedBy: 'doc_extract' });
  });
});

describe('归一：认不出来的回 null，不悄悄折成缺省档', () => {
  it.each([
    ['自述', '自述'],
    ['裁审认定', '裁审认定'],
    ['书面证据', null],
    ['', null],
    [42, null],
    [null, null],
    [undefined, null],
  ])('normalizeSourceTier(%o) → %o（变异：认不出时 return DEFAULT_SOURCE_TIER → 红）', (input, want) => {
    expect(normalizeSourceTier(input)).toBe(want);
  });

  it('normalizeAssertedBy 同一条规矩（变异：把 fallback 改成 user → 红）', () => {
    expect(normalizeAssertedBy('doc_extract')).toBe('doc_extract');
    expect(normalizeAssertedBy('robot')).toBe(null);
  });
});

describe('tierMark：〔〕后缀由数据推出', () => {
  it('null 是〔未记录〕，不是〔自述〕（变异：把 null 分支改成缺省档 → 红）', () => {
    // 这两者的分别是整套东西的意义所在：〔未记录〕= 没有这条事实，
    //〔自述〕= 有这条事实、只有一个人的说法。合成一种就会让模型把前者读成"不存在"。
    expect(tierMark(null)).toBe('〔未记录〕');
    expect(tierMark(undefined)).toBe('〔未记录〕');
    expect(tierMark('自述')).toBe('〔自述〕');
  });

  it('书证带 # 锚点，其余档带 · 锚点（变异：两种分隔符写成同一个 → 红）', () => {
    expect(tierMark('书证', 12)).toBe('〔书证#12〕');
    expect(tierMark('对方认可', 'timeline#8')).toBe('〔对方认可·timeline#8〕');
    expect(tierMark('裁审认定', 'award#3')).toBe('〔裁审认定·award#3〕');
  });

  it('没有锚点就只渲档位，不编一个占位（变异：给空锚点补一个 #0 → 红）', () => {
    expect(tierMark('书证')).toBe('〔书证〕');
    expect(tierMark('书证', '')).toBe('〔书证〕');
    expect(tierMark('书证', null)).toBe('〔书证〕');
  });
});

describe('noDocumentedFact：取证闸的唯一判据', () => {
  const row = (t: string) => ({ source_tier: t });

  it('全是自述 ⇒ true（变异：把 some 写成 every → 红）', () => {
    expect(noDocumentedFact([[row('自述'), row('自述')], [row('自述')]])).toBe(true);
  });

  it('任一行到达书证及以上 ⇒ false（变异：把门槛改成只认「裁审认定」 → 红）', () => {
    expect(noDocumentedFact([[row('自述')], [row('书证')]])).toBe(false);
    expect(noDocumentedFact([[row('对方认可')]])).toBe(false);
  });

  it('一行都没有 ⇒ false，不催取证（变异：空组回 true → 红：新建的空案子一进阶段就被催）', () => {
    expect(noDocumentedFact([])).toBe(false);
    expect(noDocumentedFact([[], []])).toBe(false);
  });

  it('档位值写坏的行按"没到书证"算（变异：认不出时当作已有书证 → 红）', () => {
    // 方向是刻意的：脏数据宁可多提醒一次，不可少提醒一次。
    expect(noDocumentedFact([[row('书面证据')]])).toBe(true);
  });
});

describe('calc 的 InputSource 收成四档的子集', () => {
  it('三个字面量一个字没变（变异：把「用户自述」改成「自述」 → 红：历史 calc_json 与算式说明会对不上）', () => {
    expect([...Object.keys(CALC_INPUT_SOURCE_TIER)].sort()).toEqual(
      ['用户自述', '系统默认', '证据佐证'].sort(),
    );
    // 类型层同一份：这一行编译不过就说明 InputSource 与那张表脱钩了
    const sample: InputSource[] = ['用户自述', '证据佐证', '系统默认'];
    expect(sample).toHaveLength(3);
    // 顺带钉住算钱口径版本没被这一票动过（改档位不该改算钱结果）
    expect(CALC_VERSION).toBe('1.0.0');
  });

  it('用户自述↔自述、证据佐证↔书证、系统默认无档位（变异：把系统默认映成「自述」 → 红）', () => {
    expect(tierOfCalcInputSource('用户自述')).toBe('自述');
    expect(tierOfCalcInputSource('证据佐证')).toBe('书证');
    // 系统取的口径值（社平、最低工资）不是当事人这边的证明力，给它安一个档位就是伪装
    expect(tierOfCalcInputSource('系统默认')).toBe(null);
  });

  it('映射的值域是四档的子集（变异：往表里写一个不在 SOURCE_TIERS 里的档 → 红）', () => {
    for (const tier of Object.values(CALC_INPUT_SOURCE_TIER)) {
      if (tier === null) continue;
      expect(SOURCE_TIERS as readonly string[]).toContain(tier);
    }
  });
});
