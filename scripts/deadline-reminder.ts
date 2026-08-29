// scripts/deadline-reminder.ts
// 期限提醒任务。用法：
//   cd app && npx tsx ../scripts/deadline-reminder.ts                       # 干跑：只算不发
//   cd app && npx tsx ../scripts/deadline-reminder.ts --apply               # 真发
//   cd app && npx tsx ../scripts/deadline-reminder.ts --smoke-to a@b.com    # 冒烟：发一封样例，不碰库
//   cd app && DB_PATH=/data/lawer/data/lawer.db npx tsx ../scripts/deadline-reminder.ts --apply
//
// 【为什么脚本在仓里】build.sh 的教训：把一个部署要用的东西只放在服务器上，
// 下一个人 clone 下来就静默缺了它，而系统照常启动。
//
// 【默认干跑】同 backfill/护照审核：发信是对外动作，必须是**显式**要求的那一次。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reminderCli } from '../app/src/lib/notify/deadline-reminder';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(HERE, '..', 'app', 'data', 'lawer.db');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// 【为什么包一层 async main 而不是顶层 await】tsx 在 CJS 输出下不支持顶层 await
// （ERR_REQUIRE_ASYNC_MODULE）——与 reconcile/backfill 那几个同步 CLI 不同，本脚本要发信。
async function main(): Promise<void> {
  process.exit(
    await reminderCli(DB_PATH, {
      apply: process.argv.includes('--apply'),
      smokeTo: arg('smoke-to'),
    }),
  );
}

void main();
