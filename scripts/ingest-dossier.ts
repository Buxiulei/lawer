// scripts/ingest-dossier.ts
// 外勤取证产物（JSONL）→ app 库的导入 CLI。用法：
//   cd app && npx tsx ../scripts/ingest-dossier.ts --file <a.jsonl> --dossier 1 --profile 7 --fetched-at 2026-08-28
//   cd app && npx tsx ../scripts/ingest-dossier.ts --file <a.jsonl> --dossier 1 --profile 7 --fetched-at 2026-08-28 --apply
//   cd app && DB_PATH=/data/lawer/data/lawer.db npx tsx ../scripts/ingest-dossier.ts ... --apply
//
// 【默认干跑】同 reconcile / 期限提醒 / 护照审核：写库是不可撤销的动作，
// 必须是**显式**要求的那一次。干跑会把「将要新增几行、拒收几行、跳过几行」全算出来再回滚。
//
// 【字段契约】见 docs/contracts/dossier-ingest.md。JSONL 的中文键照外勤现有格式收，
// 映射写在 app/src/lib/company/ingest.ts，不改外勤的输出格式。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openCliDb } from '../app/src/lib/db/cli-open';
import { ingestDocs, parseJsonl } from '../app/src/lib/company/ingest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(HERE, '..', 'app', 'data', 'lawer.db');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usage(missing: string): never {
  console.error(
    `[导入] 缺少必填参数 --${missing}。\n` +
      '本命令把外勤 JSONL 导进某一份公司档案，四个参数缺一不可：\n' +
      '  --file <路径>        外勤产出的 JSONL\n' +
      '  --dossier <id>       company_dossiers.id（统计按它聚合）\n' +
      '  --profile <id>       company_profiles.id（company_litigation 的既有 NOT NULL 外键）\n' +
      '  --fetched-at <日期>  本批的**采集**时点，不是导入时点——统计卡的 as_of 用它\n' +
      '加 --apply 才真写库，不加是干跑。',
  );
  process.exit(2);
}

function main(): number {
  const file = arg('file') ?? usage('file');
  const dossierId = Number(arg('dossier') ?? usage('dossier'));
  const profileId = Number(arg('profile') ?? usage('profile'));
  const fetchedAt = arg('fetched-at') ?? usage('fetched-at');
  const apply = process.argv.includes('--apply');

  if (!Number.isInteger(dossierId) || !Number.isInteger(profileId)) {
    console.error('[导入] --dossier / --profile 必须是整数 id。');
    return 2;
  }

  const { rows, bad } = parseJsonl(fs.readFileSync(file, 'utf8'));
  for (const b of bad) console.error(`[坏行] ${b.reason}`);

  const db = openCliDb(DB_PATH);
  db.pragma('foreign_keys = ON');
  let report;
  db.exec('BEGIN');
  try {
    report = ingestDocs(db, { dossierId, companyProfileId: profileId, rows, fetchedAt });
    if (apply) db.exec('COMMIT');
    else db.exec('ROLLBACK');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.close();
  }

  console.log(`[导入] 库：${DB_PATH}　档案：${dossierId}　主体：${profileId}　采集时点：${fetchedAt}`);
  console.log(
    `[导入] 读入 ${report.total} 行：新增 ${report.inserted}、已存在 ${report.duplicated}、` +
      `主体未命中跳过 ${report.skippedNotSubject}、拒收 ${report.rejected.length}`,
  );
  for (const r of report.rejected) console.error(`[拒收] 第 ${r.line} 行：${r.reason}`);
  for (const w of report.warnings) console.log(`[警告] ${w}`);
  console.log(apply ? '[导入] 已写入。' : '[导入] 干跑，未写库；确认无误后加 --apply 重跑。');
  return bad.length + report.rejected.length > 0 ? 1 : 0;
}

process.exit(main());
