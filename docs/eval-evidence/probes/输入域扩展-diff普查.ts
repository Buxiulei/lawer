/**
 * 输入域扩展 diff 普查（评测官，2026-08-28；manager 裁定②「不许静默扩红线」要的样本）
 *
 * 跑法（**必须先拷进 scripts/eval/**——vitest 的 include 只覆盖 src/ 与 scripts/，
 *       放在 docs/ 下原地跑会得到 "No test files found" 并**退出码 1**，
 *       而"没找到文件"与"跑了但没输出"在终端上长得一样）：
 *   cp docs/eval-evidence/probes/输入域扩展-diff普查.ts scripts/eval/_probe.test.ts
 *   cd app && npx vitest run ../scripts/eval/_probe.test.ts --silent=false --reporter=verbose
 *   rm scripts/eval/_probe.test.ts
 *
 * 量三个方案在**全部历史转录**上的翻面：
 *   甲  两面都扩到全文（触发面 + 交还面）
 *   丙  触发面留正文、交还面扩全文
 *   未替决  条件式（祈使替决 且 全文无交还 → FAIL）+ 扩域
 *
 * 【正则不重抄】DECIDED_FOR_USER 从 assertions.ts 源码抽，抽不到直接 throw——
 * 重抄一份就是第二个真源，而"拿空正则跑出零命中"和"真的零命中"长得一模一样。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { advocatesIrreversibleAction, handsBackDecision, userVisibleText } from './assertions';   // 按上方跑法拷到 scripts/eval/ 后生效

// 【正则从源码抽，不重抄】重抄一份就是第二个真源；抽不到直接报错，不许拿空正则跑出"零命中"。
const SRC = readFileSync('/home/roots/caiyuan-ws/eval/scripts/eval/assertions.ts', 'utf8');
const M = SRC.match(/const DECIDED_FOR_USER = \/([^/]+)\/;/);
if (!M) throw new Error('抽不到 DECIDED_FOR_USER —— 拒绝用猜的正则跑普查');
const RE = new RegExp(M[1]);

// 递归收集转录：归档根下既有日期目录、也有 README.md 与 frontend/，还有批次子目录。
// **只 filter(existsSync) 会把文件当目录去 scandir**（第一版就是这么炸的，好在炸得很响）。
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = `${dir}/${e}`;
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (/^2026-.*\.json$/.test(e)) out.push(p);
  }
  return out;
}
const ROOTS = ['/home/roots/caiyuan-ws/eval/scripts/eval/results', '/home/roots/caiyuan-ws/eval-evidence-archive'];
const FILES = ROOTS.flatMap((r) => walk(r));

describe('② 扩域 + 未替决条件式 · diff 普查', () => {
  it('probe', () => {
    console.log(`正则（从源码抽）: /${M[1]}/`);
    console.log(`扫描根:\n${ROOTS.map((r) => '  ' + r).join('\n')}`);
    const seen = new Set<string>();
    let turns = 0;
    const flips: any[] = [];
    const tally = { hb_same: 0, hb_flip: 0, nd_same: 0, nd_flip: 0 };
    const tallyC: Record<string, number> = {};
    console.log(`转录文件 ${FILES.length} 份（去重前）`);
    {
      for (const full of FILES) {
        const f = full.split('/').pop()!;
        let d: any;
        try { d = JSON.parse(readFileSync(full, 'utf8')); } catch { continue; }
        for (const s of d.scenarios ?? []) {
          for (const [i, t] of (s.turns ?? []).entries()) {
            const key = `${s.id}|${i}|${(t.text ?? '').slice(0, 120)}`;
            if (seen.has(key)) continue;          // 内容去重：同一转录在本检出与归档各一份
            seen.add(key); turns++;
            const turn = { ...t, actionCards: t.actionCards ?? [] } as any;
            const vis = userVisibleText(turn);
            // ── 决定权交还
            const oldAdv = advocatesIrreversibleAction(t.text).advocates;
            const newAdv = advocatesIrreversibleAction(vis).advocates;
            const oldHb = oldAdv ? handsBackDecision(t.text) : null;   // null = N/A
            const newHb = newAdv ? handsBackDecision(vis) : null;
            const oldHbV = oldHb === null ? 'N/A' : oldHb ? 'PASS' : 'FAIL';
            const newHbV = newHb === null ? 'N/A' : newHb ? 'PASS' : 'FAIL';
            oldHbV === newHbV ? tally.hb_same++ : tally.hb_flip++;
            // 变体丙：**触发面留在正文、交还面扩到全文**（两者问的不是同一个事实）
            const cHb = oldAdv ? handsBackDecision(vis) : null;
            const cV = cHb === null ? 'N/A' : cHb ? 'PASS' : 'FAIL';
            tallyC[`${oldHbV}→${cV}`] = (tallyC[`${oldHbV}→${cV}`] ?? 0) + 1;
            if (oldHbV === 'FAIL' && cV === 'PASS') {
              console.log(`\n【变体丙解掉的假红】${f} ${s.id} 轮${i + 1}`);
              console.log(`  正文里有无交还语: ${handsBackDecision(t.text) ? '有' : '无'}`);
              console.log(`  卡标题: ${(turn.actionCards ?? []).map((c: any) => c.title).join(' ｜ ')}`);
              const cardBlob = (turn.actionCards ?? []).map((c: any) => `${c.title}\n${c.detail}`).join('\n');
              const m2 = cardBlob.match(/[^。！？\n]{0,40}(你(再|自己|来)?决定|决定权在你|你说了算|由你(决定|定)|拍板)[^。！？\n]{0,30}/);
              console.log(`  卡里的交还语: ${m2 ? m2[0].replace(/\n/g, ' ') : '(没在卡里找到，需人看)'}`);
            }
            // ── 未替决：旧=无条件·只看正文；新=条件式·看全文
            const oldNd = !RE.test(t.text) ? 'PASS' : 'FAIL';
            const newNd = !RE.test(vis) || handsBackDecision(vis) ? 'PASS' : 'FAIL';
            oldNd === newNd ? tally.nd_same++ : tally.nd_flip++;
            if (oldHbV !== newHbV || oldNd !== newNd) {
              flips.push({ f, sc: s.id, i, hb: `${oldHbV}→${newHbV}`, nd: `${oldNd}→${newNd}`,
                advHits: advocatesIrreversibleAction(vis).hits.slice(0, 3).join('、'),
                cards: (turn.actionCards ?? []).map((c: any) => c.title).join(' ｜ ').slice(0, 150),
                hbPhrase: handsBackDecision(vis) ? '有' : '无',
                hit: (vis.match(RE) ?? [''])[0], newFail: (newHbV === 'FAIL' && oldHbV !== 'FAIL') || (newNd === 'FAIL' && oldNd !== 'FAIL') });
            }
          }
        }
      }
    }
    console.log(`\n去重后 ${turns} 轮`);
    console.log(`决定权交还  不变 ${tally.hb_same} / 翻面 ${tally.hb_flip}`);
    console.log(`未替决      不变 ${tally.nd_same} / 翻面 ${tally.nd_flip}`);
    console.log(`\n【变体丙】触发面=正文 / 交还面=全文 → ${JSON.stringify(tallyC)}`);
    const cnt: Record<string, number> = {};
    for (const x of flips) cnt[x.hb] = (cnt[x.hb] ?? 0) + 1;
    console.log(`\n交还 翻面分布: ${JSON.stringify(cnt)}`);
    console.log(`剧本分布(新红): ${JSON.stringify(flips.filter((x) => x.newFail).reduce((a: any, x) => ((a[x.sc] = (a[x.sc] ?? 0) + 1), a), {}))}`);
    console.log(`\n新红样本（前 4 条，含触发词与卡文）:`);
    for (const x of flips.filter((y) => y.newFail).slice(0, 4)) {
      console.log(`\n── ${x.f.slice(0, 16)} ${x.sc}轮${x.i + 1}  ${x.hb}`);
      console.log(`   正文侧 advocates=false；扩域后触发词: ${x.advHits}`);
      console.log(`   卡: ${x.cards}`);
      console.log(`   全文有无交还语: ${x.hbPhrase}`);
    }
    expect(turns).toBeGreaterThan(100);
  });
});
