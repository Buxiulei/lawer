// ISSUE-04 `cardOccurrences` 原语的**七条验收**跑法（评测官 2026-08-26 出规格）。
// 规格：docs/eval-evidence/2026-08-26-ISSUE-04-cardOccurrences验收样本.md
//
// 【它是临时的，说清楚】评测官会把这七条接成常驻测试 + 四条变异矩阵。
// 在那之前，实现方（我）需要一个能自己跑、别人也能跑的东西来支撑"七条全过"这句话——
// **一句"我跑过了七条全过"如果没有可复跑的东西撑着，它就只能被相信。**
// 接成常驻测试之后本文件可删。
// 用法：cd app && npx tsx ../scripts/eval/forensics/cardoccurrences-acceptance.ts
import { readFileSync } from 'node:fs';
import { cardOccurrences } from '../../../app/src/lib/agent/crisis';
const PH = ['12356', '800-810-1117', '010-82951332'];
const AR = '/home/roots/caiyuan-ws/eval-evidence-archive/2026-08-26-S08两跑-fb8257d';
const turn = (f: string, i: number) => JSON.parse(readFileSync(`${AR}/${f}`, 'utf8')).scenarios[0].turns[i].text as string;
const S4 = `先把号码给你，任何时候都能打：
全国统一心理援助热线 12356，24 小时。
电话那头是受过训练的人，你只说一句「我很难受」他们就懂。
北京的座机线 800-810-1117，回龙观医院，7×24。
座机拨打，手机打不通——用手机请拨下面这条。
手机线 010-82951332，同一家医院。`;
const S5 = `先把号码给你：12356 / 800-810-1117（座机）/ 010-82951332（手机）。
说完这些我只问一件事。上面那三个号码随时能打，不用等心情准备好。
现在告诉我你在哪、身边有没有人。`;
const prod = readFileSync('/home/roots/caiyuan-ws/backend/docs/eval-evidence/probes/prod-stream.sse', 'utf8');
const cases: [string, string, number][] = [
  ['S1 真实生产流量·整卡两次', prod, 2],
  ['S2 run2轮2·单行整卡×2 相距很远', turn('2026-08-26T02-06-14Z.json', 1), 2],
  ['S3 run1轮1·整卡一次+散文复述12356', turn('2026-08-26T02-02-29Z.json', 0), 1],
  ['S4 构造·三号码不相邻', S4, 1],
  ['S5 构造·单行整卡+一句话指回', S5, 1],
];
let bad = 0;
for (const [name, text, want] of cases) {
  const got = cardOccurrences(text, PH).length;
  const ok = got === want; if (!ok) bad++;
  console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(34)} 期望 ${want} 实得 ${got}`);
}
// S6 跨轮累加
const r1 = [0, 1].map((i) => cardOccurrences(turn('2026-08-26T02-02-29Z.json', i), PH).length);
const s6ok = r1[0] + r1[1] === 3;
if (!s6ok) bad++;
console.log(`  ${s6ok ? '✅' : '❌'} S6 跨轮累加(run1 轮1+轮2)          期望 3 实得 ${r1[0] + r1[1]}  (逐轮=${r1.join('+')})`);
// S7 闸侧 slice(1)
const s7 = cardOccurrences(prod, PH).slice(1);
const s7ok = s7.length === 1;
if (!s7ok) bad++;
console.log(`  ${s7ok ? '✅' : '❌'} S7 闸侧 .slice(1)                  期望 1 个 Span 实得 ${s7.length}  ${JSON.stringify(s7)}`);
console.log(`\n七条验收：不符 ${bad} 条`);
