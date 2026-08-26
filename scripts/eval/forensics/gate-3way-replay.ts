// 三版杠杆闸离线重打分（A=线上/main 1c05f28 · B=只有第一层 2f32321 · C=第二层 fb8257d）
// 三份 crisis.ts 由 `git show <SHA>:app/src/lib/agent/crisis.ts` 原样导出，**零转写**。
// 复刻 orchestrator 的处置链：detect → strip → 再 detect（或剥空）→ fallback。
import { readFileSync } from 'node:fs';
import * as A from './_gates/gateA';
import * as B from './_gates/gateB';
import * as C from './_gates/gateC';

const OPENER_HEAD = '我在。你刚才说的话我听见了，不会当作没听见，也不会因为你说「就是想想」就翻过去。';
const OPENER_TAIL = '电话那头是受过训练的人，你只说一句「我很难受」他们就懂。';

/** 把确定性首段与模型段分开：闸只作用于模型段，把首段一起判会凭空造出命中/漏判 */
function splitOpener(text: string): { opener: string; body: string } {
  if (!text.startsWith(OPENER_HEAD)) return { opener: '', body: text };
  const i = text.indexOf(OPENER_TAIL);
  const end = i < 0 ? OPENER_HEAD.length : i + OPENER_TAIL.length;
  return { opener: text.slice(0, end), body: text.slice(end).replace(/^\n+/, '') };
}

type Gate = {
  detectEmotionalLeverage: (t: string, u?: string) => string | null;
  stripLeverageSentences: (t: string, u?: string) => string;
  CRISIS_SAFE_FALLBACK: string;
};
type Outcome = 'clean' | 'stripped' | 'fallback';

function runGate(g: Gate, body: string, userSaid: string) {
  const detect = (t: string) => (g.detectEmotionalLeverage as (a: string, b?: string) => string | null)(t, userSaid);
  const strip = (t: string) => (g.stripLeverageSentences as (a: string, b?: string) => string)(t, userSaid);
  let outcome: Outcome = 'clean';
  let out = body;
  const removed: { sentence: string; hit: string }[] = [];
  if (detect(out)) {
    for (const s of out.split(/(?<=[。！？\n])/)) {
      const h = detect(s);
      if (h && s.trim()) removed.push({ sentence: s.trim(), hit: h });
    }
    out = strip(out);
    outcome = 'stripped';
    if (detect(out) || !out.trim()) {
      out = g.CRISIS_SAFE_FALLBACK;
      outcome = 'fallback';
    }
  }
  return { outcome, out, removed };
}

const file = process.argv[2];
const ev = JSON.parse(readFileSync(file, 'utf8'));
const label = process.argv[3] ?? file;

for (const sc of ev.scenarios) {
  const userSoFar: string[] = [];
  for (const [i, t] of (sc.turns as { input: string; text: string }[]).entries()) {
    userSoFar.push(t.input);
    const userSaid = userSoFar.join('\n');
    const { opener, body } = splitOpener(t.text);
    const crisisTurn = opener.length > 0;
    console.log(`\n═══ ${label} · ${sc.id} 轮${i + 1} ═══`);
    console.log(`  危机轮(首段在场)=${crisisTurn}；首段 ${opener.length} 字，模型段 ${body.length} 字`);
    if (!crisisTurn) { console.log('  → 非危机轮，产线上闸根本没跑，跳过'); continue; }
    console.log(`  ── 确定性首段（不过闸，仅供核对切分点）──\n${opener.replace(/^/gm, '  │ ')}`);
    const r = { A: runGate(A as unknown as Gate, body, userSaid), B: runGate(B as unknown as Gate, body, userSaid), C: runGate(C as unknown as Gate, body, userSaid) };
    for (const k of ['A', 'B', 'C'] as const) {
      const x = r[k];
      console.log(`  ${k}: ${x.outcome}${x.removed.length ? `（被剥 ${x.removed.length} 句）` : ''}`);
      for (const rm of x.removed) console.log(`      · 命中「${rm.hit}」← 原句：${rm.sentence}`);
    }
    const differ = new Set([r.A.outcome, r.B.outcome, r.C.outcome]).size > 1 ||
      new Set([r.A.out, r.B.out, r.C.out]).size > 1;
    console.log(`  三版是否有差异：${differ ? '★ 有' : '无'}`);
    if (r.A.out !== r.B.out) console.log('    · A≠B ⇒ 第一层（来源判别）在这一轮有独立效果');
    if (r.B.out !== r.C.out) console.log('    · B≠C ⇒ 第二层（裸短语须与离开前提同现）在这一轮有独立效果');
    if (r.B.out === r.C.out) console.log('    · B==C ⇒ **第二层这一轮没开过火**，本轮不构成第二层的价值证据');
  }
}
