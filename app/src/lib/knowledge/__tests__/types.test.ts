// 知识卡类型枚举的守卫：枚举 ⇄ 真实库存**双向**对齐。
//
// 【为什么判据必须读 index.json，而不是拿枚举和另一份手写清单比】这条判据要防的
// 恰恰是「有一类卡在工具面上不存在」——审查规则（7 张）与方法卡（2 张）此前就是
// 这个状态：库里有卡、检索器认这个 type，但三份手抄的枚举里都没有它，
// 于是 MCP 那侧根本传不进这个值，而检索照常返回 200 + 空数组。
// 拿两份手写清单互比，两份一起漏的时候是绿的。
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { KNOWLEDGE_TYPES, TYPE_TIEBREAK, typeRank } from '../types';

interface IndexEntry {
  id: string;
  type: string;
}

const KNOWLEDGE_DIR = process.env.LAWER_KNOWLEDGE_DIR ?? path.resolve(process.cwd(), '..', 'knowledge');
const INDEX: IndexEntry[] = JSON.parse(
  fs.readFileSync(path.join(KNOWLEDGE_DIR, 'index.json'), 'utf-8'),
);

describe('KNOWLEDGE_TYPES 与真实库存双向对齐', () => {
  it('判据自身不是空跑：index.json 读到了卡', () => {
    expect(INDEX.length).toBeGreaterThan(100);
  });

  it('库里出现过的每一个 type 都在枚举里（变异：从 KNOWLEDGE_TYPES 里删掉「方法卡」→ 红）', () => {
    const inLibrary = [...new Set(INDEX.map((e) => e.type))].sort();
    const missing = inLibrary.filter((t) => !(KNOWLEDGE_TYPES as readonly string[]).includes(t));
    expect(
      missing,
      `这些类型库里有卡、枚举里没有 ⇒ 工具面上传不进这个值，检索会静默回空：${missing.join('、')}`,
    ).toEqual([]);
  });

  it('枚举里的每一类在库里都至少有一张卡（枚举里写了库里没有的类型 = 给对方一个永远查不到东西的选项）', () => {
    const inLibrary = new Set(INDEX.map((e) => e.type));
    const empty = KNOWLEDGE_TYPES.filter((t) => !inLibrary.has(t));
    expect(empty, `这些类型枚举里有、库里一张卡都没有：${empty.join('、')}`).toEqual([]);
  });

  it('正好十类，且无重复', () => {
    expect(KNOWLEDGE_TYPES).toHaveLength(10);
    expect(new Set(KNOWLEDGE_TYPES).size).toBe(10);
  });
});

describe('TYPE_TIEBREAK 排位', () => {
  it('与 KNOWLEDGE_TYPES 是同一组类型，一个不多一个不少（变异：TYPE_TIEBREAK 里漏掉「审查规则」→ 红）', () => {
    expect([...TYPE_TIEBREAK].sort()).toEqual([...KNOWLEDGE_TYPES].sort());
  });

  it('审查规则排在依据档（法条/计算规则/数据卡之后、流程SOP之前），方法卡排最后', () => {
    expect(typeRank('审查规则')).toBeGreaterThan(typeRank('数据卡'));
    expect(typeRank('审查规则')).toBeLessThan(typeRank('流程SOP'));
    // 方法卡是「这套库自己怎么用」的元知识，同分时挤掉一张真依据是纯损失
    expect(typeRank('方法卡')).toBe(TYPE_TIEBREAK.length - 1);
    for (const t of KNOWLEDGE_TYPES) {
      if (t !== '方法卡') expect(typeRank(t), t).toBeLessThan(typeRank('方法卡'));
    }
  });

  it('不认识的类型排在所有已知类型之后（而不是排到最前）', () => {
    expect(typeRank('还没有这一类')).toBe(TYPE_TIEBREAK.length);
    for (const t of KNOWLEDGE_TYPES) expect(typeRank(t)).toBeLessThan(typeRank('还没有这一类'));
  });
});
