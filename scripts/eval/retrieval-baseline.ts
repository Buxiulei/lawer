/**
 * 检索基线跑数器（评测官 2026-08-29，P0 ③）。
 * 跑法见 `docs/eval-evidence/2026-08-29-检索评测-预设读法.md` §五（拷进 scripts/eval/ 再跑）。
 * 纯本地函数、无 LLM、确定性——同一棵树上重复跑必须逐字一致。
 */
import { describe, it, expect } from 'vitest';
import { search, isSubstantiveHit, listPacks } from '../../app/src/lib/knowledge/index';
import { RETRIEVAL_CASES } from './retrieval-cases';

const LIMIT = 8;

describe('检索基线', () => {
  it('baseline', () => {
    expect(listPacks().length).toBeGreaterThanOrEqual(200);   // 地板
    console.log(`卡库 ${listPacks().length} 张｜用例 ${RETRIEVAL_CASES.length} 条｜limit=${LIMIT}\n`);
    const rows = RETRIEVAL_CASES.map((c) => {
      const hits = search(c.q, { limit: LIMIT });
      const sub = hits.filter((h) => isSubstantiveHit(h, c.q));
      const subIds = new Set(sub.map((h) => h.id));
      const got = c.expect.filter((e) => subIds.has(e));
      return { c, n: hits.length, sub: sub.length, got: got.length, want: c.expect.length, topIds: hits.slice(0, 3).map((h) => h.id) };
    });
    const by = (k: string) => rows.filter((r) => r.c.kind === k);
    console.log('══ 逐类汇总 ══');
    for (const k of ['user-real', 'user-rewrite', 'twin-answer', 'dust', 'sentinel']) {
      const g = by(k);
      if (!g.length) continue;
      const zero = g.filter((r) => r.sub === 0).length;
      const recall = g.reduce((a, r) => a + r.got, 0);
      const want = g.reduce((a, r) => a + r.want, 0);
      console.log(`  ${k.padEnd(13)} ${g.length} 条｜实质命中=0 的 ${zero} 条｜应召回 ${recall}/${want}`);
    }
    console.log('\n══ 孪生判读矩阵（主梁）══');
    const cell: Record<string, string[]> = { '两侧都中': [], '答案侧中·问题侧不中': [], '两侧都不中': [], '问题侧中·答案侧不中': [] };
    for (const r of rows.filter((x) => x.c.twin)) {
      const t = rows.find((x) => x.c.id === r.c.twin)!;
      const a = r.sub > 0, b = t.sub > 0;
      const k = a && b ? '两侧都中' : !a && b ? '答案侧中·问题侧不中' : !a && !b ? '两侧都不中' : '问题侧中·答案侧不中';
      cell[k].push(`${r.c.id}(${r.sub}) × ${t.c.id}(${t.sub})`);
    }
    for (const [k, v] of Object.entries(cell)) {
      console.log(`  ${k.padEnd(20)} ${v.length} 对`);
      for (const x of v) console.log(`      ${x}`);
    }
    console.log('\n══ 哨兵与尘埃（绊线）══');
    for (const r of rows.filter((x) => x.c.kind === 'sentinel' || x.c.kind === 'dust'))
      console.log(`  ${r.c.kind === 'sentinel' ? '哨兵' : '尘埃'} ${r.c.id}「${r.c.q}」返回 ${r.n} / **实质命中 ${r.sub}**`);
    console.log('\n══ 真实台词逐条 ══');
    for (const r of rows.filter((x) => x.c.kind === 'user-real'))
      console.log(`  ${r.c.id} 返回${r.n} 实质${r.sub} 应召回${r.got}/${r.want}  首位=${r.topIds[0] ?? '—'}`);
  });
});
