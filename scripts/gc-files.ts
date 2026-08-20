// scripts/gc-files.ts
// files 孤儿回收 CLI（PR #2 评审待办）。用法：
//   cd app && npm run gc:files                              # dry-run：只列孤儿明细，不动库不动盘
//   cd app && npm run gc:files -- --delete                  # 真删：删 files 行 + 密文盘文件
//   cd app && DB_PATH=/x/y.db FILES_DIR=/x/files npm run gc:files
// 退出码恒 0（回收不到孤儿不是错）；真删时单个文件 unlink 失败只警告不中断。
//
// 本文件只负责「定位库与密文目录 + dry-run 闸门 + 删盘动作」；找孤儿与删行的逻辑在
// app/src/lib/db/filesGc.ts——依赖（better-sqlite3）由 app 包提供，逻辑放进 app 才解析得到，
// 也才进得了单测与 tsc。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gcFilesCli } from '../app/src/lib/db/filesGc';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(HERE, '..', 'app', 'data', 'lawer.db');
// files.enc_path 是相对 FILES_DIR 的路径（见 app/src/lib/evidence/files.ts），
// 默认值须与那边的 filesDir() 保持一致，否则删盘会找不到文件（只警告，不会误删别的文件）。
const FILES_DIR = process.env.FILES_DIR ?? path.join(process.cwd(), 'data', 'files');
const DRY_RUN = !process.argv.includes('--delete');

if (!DRY_RUN) console.log(`[GC] 密文目录：${FILES_DIR}`);

process.exit(
  gcFilesCli(DB_PATH, {
    dryRun: DRY_RUN,
    deleteFromDisk: (encPath) => {
      const abs = path.join(FILES_DIR, encPath);
      // 盘上文件缺失/无权限只警告不抛：抛错会回滚整个事务，
      // 让本轮已删掉的盘文件对应的库行复活成「有记录无密文」的坏行。
      try {
        fs.unlinkSync(abs);
      } catch (e) {
        console.warn(`[警告] 删密文文件失败（库行已删）：${abs}：${(e as Error).message}`);
      }
    },
  }),
);
