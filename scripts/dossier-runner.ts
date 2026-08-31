// scripts/dossier-runner.ts
// 「公司档案采集」定时任务。用法：
//   cd app && npx tsx ../scripts/dossier-runner.ts                 # 只重算统计，不调模型
//   cd app && npx tsx ../scripts/dossier-runner.ts --patterns      # 顺带跑套路归纳（会调模型、会花钱）
//   cd app && DB_PATH=/data/lawer/data/lawer.db npx tsx ../scripts/dossier-runner.ts --patterns
// 退出码：0=整轮跑通（逐项失败几条见日志与 job_runs.items_failed）；1=整轮失败。
//
// 【为什么脚本在仓里】build.sh 的教训：部署要用的东西只放服务器上，下一个人 clone 下来就
// 静默缺了它，而系统照常启动。cron 挂法照 docs/OPS.md 现有三条的形态。
//
// 【为什么调模型要显式开】归纳是本管线唯一花钱的一步。默认不开，
// 于是「cron 挂上了」与「cron 开始烧钱了」是两个独立的决定。
//
// 【本任务不抓文书】采集器在外勤工作站、要真人过验证码。这里只做入库之后的事。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDossierJob } from '../app/src/lib/company/runner';
import type { PatternLlm } from '../app/src/lib/company/patterns';
import { openCliDb } from '../app/src/lib/db/cli-open';
import { getProvider } from '../app/src/lib/llm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(HERE, '..', 'app', 'data', 'lawer.db');

/**
 * 归纳按 bulk 档路由。**三套餐的 bulk 格子都是同一个便宜档**（routing.config.ts），
 * 所以这里传哪个 plan 都一样，取 entry 只是为了显式而不是留白。
 * 档位要升，改的是那张路由表，不是这一行。
 */
function makeLlm(): PatternLlm {
  const { client } = getProvider('bulk', 'entry');
  if (!client.chatJSON) {
    throw new Error(
      `归纳跑不了：路由到的 ${client.name}/${client.model} 没有实现 chatJSON（小型 JSON 调用）。` +
        'Anthropic 侧刻意没实现它——bulk 档本就不该走 Claude。' +
        '请检查 routing.config.ts 的 bulk 格子，或先补齐 DeepSeek/Qwen 的 API key。',
    );
  }
  const chatJSON = client.chatJSON.bind(client);
  return { chatJSON: (messages) => chatJSON(messages), billingModel: client.billingModel };
}

async function main(): Promise<number> {
  const withPatterns = process.argv.includes('--patterns');
  const db = openCliDb(DB_PATH);
  db.pragma('foreign_keys = ON');
  try {
    const report = await runDossierJob(db, { llm: withPatterns ? makeLlm() : null });
    console.log(`[档案] 库：${DB_PATH}`);
    console.log(`[档案] ${report.note}`);
    for (const f of report.failures) {
      console.error(`[逐项失败] 档案 ${f.dossierId}：${f.error}`);
    }
    return 0;
  } catch (e) {
    console.error(`[档案] 整轮失败：${(e as Error).message}`);
    return 1;
  } finally {
    db.close();
  }
}

void main().then((code) => process.exit(code));
