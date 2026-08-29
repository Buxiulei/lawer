// app/src/lib/knowledge/__tests__/aliases.test.ts
// 别名层（检索 P0 ③）的机制守卫。
//
// 【为什么守的是"进表规矩"而不是"召回涨了多少"】召回归评测官的尺子判。
// 这里守的是这张表**不会变成第二个无差别放宽的倾倒场**——那正是 ② 被撤的原因：
// 无差别放宽的收益与噪声同源，而别名的价值全在"定点"两个字上。
// 定点靠两条硬约束维持：每条要有出处、规范词必须真实存在。
// 两条都做成**拒绝启动**而非跳过——静默跳过的表，长着长着就不定点了。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { __resetForTest, search, isSubstantiveHit } from '../index';

const REAL_DIR = path.resolve(__dirname, '../../../../../knowledge');
let tmp: string | null = null;

function withAliases(entries: unknown[]): void {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-alias-'));
  for (const f of fs.readdirSync(REAL_DIR)) {
    const src = path.join(REAL_DIR, f);
    if (f === 'aliases.json') continue;
    fs.cpSync(src, path.join(tmp, f), { recursive: true });
  }
  fs.writeFileSync(path.join(tmp, 'aliases.json'), JSON.stringify({ entries }));
  process.env.LAWER_KNOWLEDGE_DIR = tmp;
  __resetForTest();
}

afterEach(() => {
  delete process.env.LAWER_KNOWLEDGE_DIR;
  __resetForTest();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('进表规矩：两条都拒绝启动，不静默跳过', () => {
  test('🔴 缺 source 的别名 → 抛错并指名是哪一条', () => {
    withAliases([{ alias: '被裁', canonical: '裁员' }]);
    expect(() => search('我被裁了')).toThrow(/被裁→裁员.*source/s);
  });

  test('🔴 source 是空白也不算有出处', () => {
    withAliases([{ alias: '被裁', canonical: '裁员', source: '   ' }]);
    expect(() => search('我被裁了')).toThrow(/source/);
  });

  test('🔴 规范词不在任何卡的词表里 → 抛错', () => {
    // 【为什么这条必须响】指向不存在的规范词**不报错、只是静默不生效**，
    // 而表上看起来这条别名在起作用——比没有这条别名更坏。
    withAliases([{ alias: '被裁', canonical: '这个词根本不存在', source: '测试' }]);
    expect(() => search('我被裁了')).toThrow(/不在任何卡的词表里/);
  });

  test('✅ 两条都满足则正常放行（闸不能把合法表也拦了）', () => {
    withAliases([{ alias: '被裁', canonical: '裁员', source: '孪生对 rw-caiyuan-1' }]);
    expect(() => search('我被裁了')).not.toThrow();
  });
});

describe('机制：扩 query，不改匹配语义', () => {
  test('别名让原本捞不到的那张卡捞得到', () => {
    // 【断言的是"要的那张来了"，不是"来得更多"】第一版写的是 length 变大——
    // 两边都撞上 limit=8 的天花板，8 > 8 恒假。**同一个天花板陷阱，我在刚认领它之后又踩了一次。**
    // 而且"更多"本来就不是好判据：多捞几张不相干的也会让 length 变大。
    const q = '我被裁了怎么办';
    const target = 'sop-jingjixing-caiyuan-chengxu';
    withAliases([{ alias: '被裁', canonical: '裁员', source: '孪生对 rw-caiyuan-1' }]);
    // 【判据是"实质命中"，不是"在结果里"】没有别名时这张卡**也在结果里**——
    // 靠标题二元组捞上来，排在 96 名开外。那正是 index.ts 注释里记了很久的"尘埃"：
    // 检索永不空手，所以"在不在结果里"分不出有料与没料。评测集用的也是 isSubstantiveHit。
    const sub = (id: string) =>
      search(q, { limit: 218 }).some((h: { id: string }) => h.id === id && isSubstantiveHit(h, q));
    const withAlias = sub(target);
    withAliases([]);
    const without = sub(target);
    expect(without).toBe(false);
    expect(withAlias).toBe(true);
  });

  test('query 里已含规范词时不重复追加（不虚增分数）', () => {
    withAliases([{ alias: '被裁', canonical: '裁员', source: 't' }]);
    const a = search('我被裁了，公司说这是裁员', { limit: 8 });
    withAliases([]);
    const b = search('我被裁了，公司说这是裁员', { limit: 8 });
    expect(a.map((x: any) => x.id)).toEqual(b.map((x: any) => x.id));
  });

  test('无关 query 不因别名表变宽（定点，不是放宽）', () => {
    withAliases([{ alias: '被裁', canonical: '裁员', source: 't' }]);
    const a = search('仲裁时效是多久').length;
    withAliases([]);
    const b = search('仲裁时效是多久').length;
    expect(a).toBe(b);
  });

  test('isSubstantiveHit 与 search 同源——判据与产线不许各判各的', () => {
    withAliases([{ alias: '被裁', canonical: '裁员', source: 't' }]);
    const q = '我被裁了怎么办';
    const hits = search(q, { limit: 8 });
    // 走 search 出来的卡，至少有一张在 isSubstantiveHit 眼里也算实质命中
    expect(hits.some((h: any) => isSubstantiveHit(h, q))).toBe(true);
  });
});
