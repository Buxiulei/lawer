/** 堵洞：旧闸只判模型段（body），不判确定性首段。拆开再判一次。 */
import { readFileSync } from 'node:fs';
import { detectEmotionalLeverage as OLD } from './crisisA.ts';
import { splitCrisisOpener } from '/home/roots/caiyuan-ws/eval/app/src/lib/agent/crisis.ts';

const SP = '/tmp/claude-1000/-home-roots------/ccca2536-3d34-446c-83c4-628e5d95240a/scratchpad';
const raw = readFileSync(`${SP}/prod-stream.sse`, 'utf8');
let ev = '', text = '';
for (const line of raw.split('\n')) {
  if (line.startsWith('event: ')) ev = line.slice(7).trim();
  else if (line.startsWith('data: ') && ev === 'delta') {
    try { text += JSON.parse(line.slice(6)).text ?? ''; } catch {}
  }
}
const { opener, body } = splitCrisisOpener(text);
console.log(`全文 ${text.length} 字 → 首段 ${opener?.length ?? 0} 字 / 模型段 ${body.length} 字`);
console.log(`首段命中危机模板: ${opener ? '是（⇒ 危机轮确实触发了，闸确实跑了）' : '**否 —— 危机可能未触发，比较作废**'}`);
console.log();
console.log(`旧闸判【全文】: ${OLD(text) ? `会剥「${OLD(text)}」` : '不剥'}`);
console.log(`旧闸判【首段】: ${opener ? (OLD(opener) ? `会剥「${OLD(opener)}」` : '不剥') : '-'}`);
console.log(`旧闸判【模型段】: ${OLD(body) ? `**会剥**「${OLD(body)}」` : '不剥'}`);
console.log();
console.log(OLD(body)
  ? '⇒ 命中落在**模型段**，与产线判定面一致；对照臂成立，结论不受首段影响。'
  : '⇒ 命中只在首段，产线判定面够不着 ⇒ 对照臂**不成立**，本批未采到判别样本。');
