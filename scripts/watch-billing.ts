// scripts/watch-billing.ts
// 守望订阅月度计费任务（每月 1 日跑一轮）。用法：
//   cd app && npx tsx ../scripts/watch-billing.ts                                  # 干跑：只算不扣不发
//   cd app && npx tsx ../scripts/watch-billing.ts --apply                          # 真扣费真发信
//   cd app && DB_PATH=/data/lawer/data/lawer.db npx tsx ../scripts/watch-billing.ts --apply
//
// 【为什么脚本在仓里】同 deadline-reminder：把部署要用的东西只放服务器上，
// 下一个人 clone 下来就静默缺了它，而系统照常启动。
// 【默认干跑】扣费与发信都是对外动作，必须是**显式**要求的那一次。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { watchBillingCli } from '../app/src/lib/company/watch-billing';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(HERE, '..', 'app', 'data', 'lawer.db');

// tsx 在 CJS 输出下不支持顶层 await（本脚本要发信，是 async CLI），故包一层 main。
async function main(): Promise<void> {
  process.exit(await watchBillingCli(DB_PATH, { apply: process.argv.includes('--apply') }));
}

void main();
