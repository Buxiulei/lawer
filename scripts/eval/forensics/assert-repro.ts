// 复现评测侧断言 emotionalLeverageAssertions 的实际判定，并与产线闸的判定并排。
// 断言原文（scripts/eval/assertions.ts:441）：const hit = detectEmotionalLeverage(t.text);
//   —— ① 不传 userSaid（来源判别整层失效）；② 判的是 t.text（含确定性首段），产线闸只判模型段。
import { readFileSync } from 'node:fs';
import * as C from './_gates/gateC';

const OPENER_HEAD = '我在。你刚才说的话我听见了，不会当作没听见，也不会因为你说「就是想想」就翻过去。';
const OPENER_TAIL = '电话那头是受过训练的人，你只说一句「我很难受」他们就懂。';
function body(text: string): string {
  if (!text.startsWith(OPENER_HEAD)) return text;
  const i = text.indexOf(OPENER_TAIL);
  const end = i < 0 ? OPENER_HEAD.length : i + OPENER_TAIL.length;
  return text.slice(end).replace(/^\n+/, '');
}

for (const file of process.argv.slice(2)) {
  const ev = JSON.parse(readFileSync(file, 'utf8'));
  for (const sc of ev.scenarios) {
    const said: string[] = [];
    for (const [i, t] of (sc.turns as { input: string; text: string }[]).entries()) {
      said.push(t.input);
      const userSaid = said.join('\n');
      const b = body(t.text);
      const isCrisis = b !== t.text;
      if (!isCrisis) continue;
      const asProd = C.detectEmotionalLeverage(b, userSaid);           // 产线：模型段 + userSaid
      const asEval = C.detectEmotionalLeverage(t.text);                 // 评测：全文 + 无 userSaid
      const evalOnBody = C.detectEmotionalLeverage(b);                  // 拆因子：只去掉 userSaid
      const prodOnFull = C.detectEmotionalLeverage(t.text, userSaid);   // 拆因子：只换判定面
      console.log(`\n${file.split('/').pop()} ${sc.id} 轮${i + 1}`);
      console.log(`  产线闸（模型段 + userSaid）      → ${asProd ?? 'clean'}`);
      console.log(`  评测断言（全文，无 userSaid）    → ${asEval ?? 'clean'}   ← 成绩单上的那条 L1`);
      console.log(`  只去掉 userSaid（仍判模型段）    → ${evalOnBody ?? 'clean'}`);
      console.log(`  只换判定面（仍传 userSaid）      → ${prodOnFull ?? 'clean'}`);
    }
  }
}
