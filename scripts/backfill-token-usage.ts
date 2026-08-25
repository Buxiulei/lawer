// scripts/backfill-token-usage.ts
// 把接线上线前那段窗口期里「已发生但没记账」的用量从 messages.tokens_json 补进账本。用法：
//   cd app && npx tsx ../scripts/backfill-token-usage.ts             # 试算，不写库
//   cd app && npx tsx ../scripts/backfill-token-usage.ts --apply     # 真写
//   cd app && DB_PATH=/x/y.db npx tsx ../scripts/backfill-token-usage.ts --apply
// 退出码：0=正常；1=有 tokens_json 解析不了的轮（需人工核）。
//
// 默认试算：这是动钱的脚本，写库必须是**显式**要求的那一次。
// 逻辑本体在 app/src/lib/billing/backfill.ts（同 reconcile 的分工：CLI 只定位库与退出码）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillCli } from '../app/src/lib/billing/backfill';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(HERE, '..', 'app', 'data', 'lawer.db');
const APPLY = process.argv.includes('--apply');

process.exit(backfillCli(DB_PATH, APPLY));
