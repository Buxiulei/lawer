// 「能上线的最小集合」(main + d10a00c + c009c1c) 那棵树的 crisis.ts，喂两份真实转录看处置。
import { readFileSync } from 'node:fs';
import * as A from './_gates/gateA';
import * as S from './_gates/gateSHIP';
import * as C from './_gates/gateC';
const HEAD = '我在。你刚才说的话我听见了，不会当作没听见，也不会因为你说「就是想想」就翻过去。';
const TAIL = '电话那头是受过训练的人，你只说一句「我很难受」他们就懂。';
type G = { detectEmotionalLeverage: (t: string, u?: string) => string | null; stripLeverageSentences: (t: string, u?: string) => string; CRISIS_SAFE_FALLBACK: string };
function run(g: G, body: string, said: string) {
  const d = (t: string) => (g.detectEmotionalLeverage as (a: string, b?: string) => string | null)(t, said);
  if (!d(body)) return 'clean';
  const out = (g.stripLeverageSentences as (a: string, b?: string) => string)(body, said);
  return d(out) || !out.trim() ? 'fallback' : 'stripped';
}
for (const f of process.argv.slice(2)) {
  const ev = JSON.parse(readFileSync(f, 'utf8'));
  for (const sc of ev.scenarios) {
    const said: string[] = [];
    for (const [i, t] of (sc.turns as { input: string; text: string }[]).entries()) {
      said.push(t.input);
      if (!t.text.startsWith(HEAD)) continue;
      const j = t.text.indexOf(TAIL);
      const body = t.text.slice(j < 0 ? HEAD.length : j + TAIL.length).replace(/^\n+/, '');
      const u = said.join('\n');
      console.log(`${f.split('/').pop()} ${sc.id} 轮${i + 1}: A(线上)=${run(A as unknown as G, body, u)}  SHIP(最小集合)=${run(S as unknown as G, body, u)}  C(ws/backend)=${run(C as unknown as G, body, u)}`);
    }
  }
}
