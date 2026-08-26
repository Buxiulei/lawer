// (a) 守卫验收：manager 2026-08-26 定的验收标准——
// 「在 eval-evidence-archive/2026-08-26-整卡口径-a守卫样本/ 这 7 条上重跑，
//   不许有任何一条回到『产线判整卡会剥、评测报 0 次』的形态」。
// 那 7 条是 2026-08-26 从现存语料重建的，**不是 58557b3 提到的当年那 22 份**（22 不可复现）。
// 用法：cd app && npx tsx ../scripts/eval/forensics/a-guard-acceptance.mjs
import fs from 'node:fs';
const A = '/home/roots/caiyuan-ws/eval-evidence-archive/2026-08-26-整卡口径-a守卫样本/divergence-samples.json';
const PH = ['12356', '800-810-1117', '010-82951332'];
const { cardOccurrences } = await import('/home/roots/caiyuan-ws/backend/app/src/lib/agent/crisis.ts');
let bad = 0;
for (const s of JSON.parse(fs.readFileSync(A, 'utf8'))) {
  const prodWouldStrip = s.含号码行数 >= 2;              // 产线口径（未改）
  const evalSays = cardOccurrences(s.正文, PH).length;    // 新判据口径
  const revived = prodWouldStrip && evalSays === 0;       // 就是要禁的那个形态
  if (revived) bad++;
  console.log(`  ${revived ? '❌复活' : '✅'} ${s.来源} 轮${s.轮}  产线会剥=${prodWouldStrip} 新评测=${evalSays}（旧评测=${s.旧评测判整卡 ? 1 : 0}）`);
}
console.log(`\n(a) 守卫：复活 ${bad} 条（必须为 0）`);
process.exit(bad === 0 ? 0 : 1);
