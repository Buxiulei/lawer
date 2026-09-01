// scripts/gen-redeem-codes.ts
// 兑换码签发 CLI（管理页的兜底：页面挂了、或运维手上只有 ssh 时照样能发码）。用法：
//   cd app && npm run gen:codes -- <张数> <单张面值> [批次备注]
//   cd app && DB_PATH=/data/lawer.db npm run gen:codes -- 50 300 '2026-09 老用户回馈'
// 输出：一行一条码（其余说明走 stderr），可直接 `> codes.txt` 或管道给别的工具。
//
// 【为什么是 .ts 不是 .mjs】签发逻辑必须与管理页**同一个函数**（issueRedeemCodes）——
// 码的字母表、长度、拒绝采样、UNIQUE 重试、事务边界，任何一处两边不一致都会在事后
// 表现成「某一批码兑不了」而当时全绿。.mjs 引不了 TypeScript，照抄一份就是两份实现。
// 与仓里其它脚本（reconcile / gc-files / storage-audit）同构，都由 tsx 跑。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { issueRedeemCodes } from '../app/src/lib/billing/redeem';
import { openCliDb } from '../app/src/lib/db/cli-open';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(HERE, '..', 'app', 'data', 'lawer.db');

const [countArg, valueArg, ...noteParts] = process.argv.slice(2);

// 缺参数时给的是三段式：缺什么、为什么要它、怎么办。裸报个 usage 让人自己猜面值单位是元还是公道值。
if (!countArg || !valueArg) {
  console.error(
    '缺少参数：需要 <张数> 与 <单张面值>。\n' +
      '面值的单位是**公道值**（不是元）——码一兑就是这么多公道值直接入账。\n' +
      '用法：cd app && npm run gen:codes -- 50 300 \'2026-09 老用户回馈\'',
  );
  process.exit(2);
}

const count = Number(countArg);
const value = Number(valueArg);
if (!Number.isInteger(count) || count < 1 || !Number.isInteger(value) || value < 1) {
  console.error(`张数与面值都必须是正整数，收到：张数=${countArg} 面值=${valueArg}`);
  process.exit(2);
}

// 走 openCliDb（可写路径会顺手跑迁移）：滚更后应用还没被碰过时，
// 惰性迁移没跑过，直接 new Database 会崩在 `no such column: note` 上。见 lib/db/cli-open.ts。
const db = openCliDb(DB_PATH);

// created_by 给 null：CLI 没有登录态，编一个 uid 上去等于伪造签发人。
// 谁跑的这条命令由 shell 历史与备注承担，不由一个编出来的数字承担。
const codes = issueRedeemCodes(db, { count, gongdaoValue: value, note: noteParts.join(' ') || null });

console.error(`已签发 ${codes.length} 张，单张 ${value} 公道值，库：${DB_PATH}`);
for (const code of codes) console.log(code);
