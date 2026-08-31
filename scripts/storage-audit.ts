// scripts/storage-audit.ts
// 按用户聚合的存储用量审计（P2-7）。用法：
//   cd app && npm run audit:storage                      # 列出每个用户的用量 + 全库总账
//   cd app && DB_PATH=/x/y.db npm run audit:storage
// 恒只读（连写句柄都不拿）。退出码：0=总账恒等式成立；1=口径对不上，数字不可信。
//
// 本文件只负责「定位库 + 退出码」；聚合口径与自检在 app/src/lib/db/storageAudit.ts
// ——依赖（better-sqlite3）由 app 包提供，逻辑放进 app 才解析得到，也才进得了单测与 tsc。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storageAuditCli } from '../app/src/lib/db/storageAudit';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(HERE, '..', 'app', 'data', 'lawer.db');

process.exit(storageAuditCli(DB_PATH));
