// 整卡口径两处边界的**实测底数**。
//
// 【语料从统一入口取，且**把范围一起打出来**】(2026-08-26)
// 语料清单一律走 `scripts/eval/corpus-list.sh --scenarios`（按剧本实例内容哈希去重）。
// 本脚本**把它的扫描根原样转印到自己的输出里**——因为今天实测过：
// 同一个脚本从两个检出跑，模型段 165 vs 153、碰撞 38 vs 11（3.5 倍），
// **两个输出都完全合理，没有任何一个会触发"这个数不该是这样"。**
//
//   ⇒ **一个不带范围的语料统计，等于一个没有单位的数。**
//   （今天已立的规矩：任何"零命中／N 轮"的结论必须在同一句话里写明搜索范围。）
//
// 【为什么按剧本实例而不是文件去重】两种重复机制：
//   ① 归档把同一份转录留在两处（同名，文件哈希能去）；
//   ② 同一份剧本结果装在两个信封里（`runId`/`startedAt` 不同 ⇒ 文件哈希不同，
//      而 `scenarios[i]` 逐字节相同）——**按信封去重永远看不见它**，实测 6 组、全部不同名。
//
// 用法：cd app && node ../scripts/eval/forensics/card-boundary-baseline.mjs [--include-local]
//   不加 --include-local 只扫归档（共享、非一次性）；加了才扫本检出的 results/（随检出而变）。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const { cardOccurrences, stripDuplicateHotlineList, splitCrisisOpener, hotlineStripDeclined } =
  await import('../../../app/src/lib/agent/crisis.ts');
const PH = ['12356', '800-810-1117', '010-82951332'];

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, '..', 'corpus-list.sh');
const args = ['--scenarios', ...process.argv.slice(2).filter((a) => a === '--include-local')];

// stderr 里那几行扫描根**转印进本脚本的输出**：数字和它的范围必须一起走
let roots = '';
const list = execFileSync('sh', [ENTRY, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).toString();
try {
  roots = execFileSync('sh', ['-c', `sh ${JSON.stringify(ENTRY)} ${args.join(' ')} 2>&1 >/dev/null`], { encoding: 'utf8' });
} catch { roots = '(取扫描根失败)'; }
console.log(roots.trimEnd());

let bodies = 0, dup = 0, declined = 0, collision = 0, realSpam = 0, instances = 0;
const spamCases = [];
for (const line of list.split('\n').filter(Boolean)) {
  const [f, idx] = line.split('\t');
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  const sc = d.scenarios?.[Number(idx)];
  if (!sc) continue;
  instances++;
  (sc.turns ?? []).forEach((t, i) => {
    const { opener, body } = splitCrisisOpener(t.text);
    if (!body) return;
    bodies++;
    const inBody = cardOccurrences(body, PH).length;
    const inOpener = opener ? cardOccurrences(opener, PH).length : 0;
    if (inBody >= 2) {
      dup++;
      if (hotlineStripDeclined(body, PH)) declined++;
      realSpam++;
      if (spamCases.length < 5) spamCases.push(`${path.basename(f)} ${sc.id} 轮${i + 1}: 首段=${inOpener} 模型段=${inBody}`);
    } else if (inOpener >= 1 && inBody === 1) {
      collision++;
    }
  });
}
console.log(`剧本实例 ${instances} / 模型段 ${bodies} 段`);
console.log(`  body 内 ≥2 张整卡（**真刷屏**）：${realSpam} 段；其中产线明示放弃（同行）：${declined} 段`);
console.log(`  首段 1 张 + 模型段恰好 1 张（L1×L2 碰撞）：${collision} 段`);
spamCases.forEach((c) => console.log('     ' + c));
