// scripts/reconcile.ts
// 公道值对账 CLI（spec §6）。用法：
//   cd app && npm run reconcile                    # 默认库 app/data/lawer.db
//   cd app && DB_PATH=/x/y.db npm run reconcile    # 指定库
// 退出码：0=账目一致；1=存在不一致（明细已逐条打印）。CI / cron 直接看退出码。
//
// 本文件只负责「定位库 + 退出码」；对账逻辑在 app/src/lib/db/reconcile.ts——
// 依赖（better-sqlite3）由 app 包提供，逻辑放进 app 才解析得到，也才进得了单测与 tsc。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileCli } from '../app/src/lib/db/reconcile';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(HERE, '..', 'app', 'data', 'lawer.db');

process.exit(reconcileCli(DB_PATH));
