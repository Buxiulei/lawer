/**
 * 评测集自身的地板守卫。**尺子先于修法，而尺子自己得先站得住。**
 * 这一格的失败方式很安静：标注引用一个不存在的卡 id ⇒ 它永远"未命中" ⇒
 * **基线偏低、改造后的提升被虚增**，而报告上什么异常都没有。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { RETRIEVAL_CASES } from './retrieval-cases';

const INDEX: { id: string }[] = JSON.parse(
  readFileSync(new URL('../../knowledge/index.json', import.meta.url), 'utf8'),
);
const IDS = new Set(INDEX.map((m) => m.id));

describe('检索评测集 · 地板', () => {
  it('🔒 规模与卡库都不为空（切错文件会让下面每条断言空过）', () => {
    expect(RETRIEVAL_CASES.length).toBeGreaterThanOrEqual(40);
    // 【这个地板 2026-09-07 从 200 降到 100】核实闭卷把 61 张追不到一手源的判例卡
    // 移进了 knowledge/quarantine/（220 → 159）。地板的用途是"切错文件/读到空文件"的
    // 自证，不是"卡库有多大"的指标——把它钉在当时的卡数上，只会在每次正当的增删时
    // 变成噪音，而它挡的那件事（IDS 是空的）用 100 一样挡得住。
    expect(IDS.size).toBeGreaterThanOrEqual(100);
  });

  it('**每个 expect 的卡 id 都必须真实存在**——标错一个，尺子安静地量低', () => {
    const bad = RETRIEVAL_CASES.flatMap((c) => c.expect.filter((e) => !IDS.has(e)).map((e) => `${c.id}→${e}`));
    expect(bad, `这些卡 id 不在 index.json 里：${bad.join('、')}`).toEqual([]);
  });

  it('id 唯一、query 非空、标注依据必须写出来（写出来才能被反驳）', () => {
    const ids = RETRIEVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of RETRIEVAL_CASES) {
      expect(c.q.trim().length, `${c.id} 的 query 为空`).toBeGreaterThan(0);
      expect(c.why.length, `${c.id} 没写标注依据`).toBeGreaterThanOrEqual(8);
    }
  });

  it('**哨兵行的 expect 必须是空**——它的全部意义是"这里不该有东西"', () => {
    for (const c of RETRIEVAL_CASES.filter((x) => x.kind === 'sentinel' || x.kind === 'dust')) {
      expect(c.expect, `${c.id} 是 ${c.kind}，不该有 expect`).toEqual([]);
    }
    expect(RETRIEVAL_CASES.filter((c) => c.kind === 'sentinel').length).toBeGreaterThanOrEqual(2);
  });

  it('孪生配对闭合：无悬空引用，也无没人引用的孪生臂', () => {
    const twins = new Set(RETRIEVAL_CASES.filter((c) => c.kind === 'twin-answer').map((c) => c.id));
    const refs = new Set(RETRIEVAL_CASES.map((c) => c.twin).filter(Boolean) as string[]);
    expect([...refs].filter((r) => !twins.has(r)), '悬空引用').toEqual([]);
    // 没人引用的孪生臂 = 量了也没有对手方，判读矩阵用不上它
    expect([...twins].filter((t) => !refs.has(t)), '没有对手方的孪生臂').toEqual([]);
  });
});
