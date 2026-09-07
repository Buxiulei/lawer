// app/src/lib/db/filesGc.ts
// files 孤儿回收：files 是内容寻址的裸资源、不挂 case_id/user_id，归属全靠引用它的表决定，
// 于是引用侧的行被删（删案级联删 evidence、company_docs）后，files 行与密文盘文件会长期滞留。
// 本模块找出无人引用的 files 行并回收；CLI 入口在仓库根 scripts/gc-files.ts
// （那里只做「定位库 + dry-run/真删 + 退出码」，逻辑全在这里，可单测）。
//
// 引用者清单（2026-09-07 逐条核对 migrate.ts 全部 `REFERENCES files`，共 5 处）：
//   ① evidence.file_id                   NOT NULL REFERENCES files(id)
//   ② attestations.cert_pdf_file_id               REFERENCES files(id)   —— 可空
//   ③ company_docs.file_id               NOT NULL REFERENCES files(id)
//   ④ evidence_upload_tokens.file_id              REFERENCES files(id)   —— 可空，字节落库后回填
//   ⑤ file_download_tokens.file_id       NOT NULL REFERENCES files(id)
// 漏一个引用者 = 误删用户证据的密文文件，且 files.sha256 唯一、盘上文件删了不可复原。
// **而在开着 foreign_keys 的进程里（lib/db/client 就是），漏一个的实际表现更坏**：
// DELETE 撞外键 → 整个事务回滚 → 本轮已经 unlink 掉的那几份低 id 孤儿的库行原地复活，
// 正是本文件抬头要避免的「有记录无密文」。④⑤ 就是这样漏掉的（2026-09-07 复审）。
//
// 【这份清单不靠人记】__tests__/filesGc.test.ts 的「结构守卫」直接从 migrate.ts 的建表语句里
// 抽出全部 `REFERENCES files(id)`，与下面这份逐条比对，漏一张会当场点名是哪张表哪一列。
import Database from 'better-sqlite3';

import { openCliDb, rethrowIfSchemaStale } from './cli-open';

/**
 * 引用者：(表名, 指向 files.id 的列名)。顺序不影响结果，仅决定 SQL 里 NOT EXISTS 的书写顺序。
 *
 * 导出供 storageAudit 派生「有无引用」的判据——那边不另抄一份表名清单，
 * 免得日后新增 files 外键时要在两处各记一遍（漏一处即误删证据或漏算用量）。
 */
export const REFERENCERS: readonly [table: string, column: string][] = [
  ['evidence', 'file_id'],
  ['attestations', 'cert_pdf_file_id'],
  ['company_docs', 'file_id'],
  ['evidence_upload_tokens', 'file_id'],
  ['file_download_tokens', 'file_id'],
];

/** 「无任何引用者引用 f.id」的条件式，供查孤儿与删前重验共用一套口径。 */
const NO_REFERENCE = REFERENCERS.map(
  ([t, c]) => `NOT EXISTS (SELECT 1 FROM ${t} x WHERE x.${c} = f.id)`,
).join('\n     AND ');

const SQL_ORPHANS = `
  SELECT f.id, f.sha256, f.size, f.enc_path, f.created_at
    FROM files f
   WHERE ${NO_REFERENCE}
   ORDER BY f.id
`;

const SQL_STILL_ORPHAN = `
  SELECT 1 FROM files f WHERE f.id = ? AND ${NO_REFERENCE}
`;

export interface OrphanFile {
  id: number;
  sha256: string;
  size: number;
  enc_path: string;
  created_at: string;
}

export interface GcResult {
  /** 实际删掉的 files 行数。 */
  removed: number;
  /** 删掉的行的 size 合计（字节）。 */
  freedBytes: number;
}

/** 列出无人引用的 files 行（只读，不写任何行）。 */
export function findOrphanFiles(db: Database.Database): OrphanFile[] {
  return db.prepare(SQL_ORPHANS).all() as OrphanFile[];
}

/**
 * 回收孤儿文件：事务内删行，**行删成功才**回调删盘——顺序反过来就会出现
 * 「盘上文件已没、库里行还在」的不可读证据行；反之（行删了盘上还在）只是占空间，可再跑一次收掉。
 * deleteFromDisk 由调用方注入（脚本侧传真 unlink，单测传探针），本模块不碰文件系统。
 * @param opts.deleteFromDisk 删密文文件；抛错即整个事务回滚（该行的 files 记录不会丢）。
 */
export function gcOrphanFiles(
  db: Database.Database,
  opts: { deleteFromDisk: (encPath: string) => void },
): GcResult {
  const stillOrphan = db.prepare(SQL_STILL_ORPHAN);
  const del = db.prepare('DELETE FROM files WHERE id = ?');

  const run = db.transaction((rows: OrphanFile[]): GcResult => {
    let removed = 0;
    let freedBytes = 0;
    for (const row of rows) {
      // 删前逐行重验仍无引用：同事务内其实已与并发写隔离，但重验一次近乎零成本，
      // 而这里判错的代价是永久删掉用户的证据文件——宁可白查。
      if (!stillOrphan.get(row.id)) continue;
      if (del.run(row.id).changes !== 1) continue;
      opts.deleteFromDisk(row.enc_path);
      removed += 1;
      freedBytes += row.size;
    }
    return { removed, freedBytes };
  });

  return run(findOrphanFiles(db));
}

/**
 * CLI 本体：定位库、按 dryRun 闸门列出或回收孤儿、打印明细。
 * 默认 dry-run（只读打开，连写句柄都不拿），真删必须显式 dryRun=false。
 * @param opts.deleteFromDisk 由脚本侧注入的删盘动作（真删时才会被调用）。
 * @returns 进程退出码（恒 0：回收不到孤儿不是错）。
 */
export function gcFilesCli(
  dbPath: string,
  opts: { dryRun: boolean; deleteFromDisk: (encPath: string) => void },
): number {
  console.log(`[GC] 库：${dbPath}`);
  const db = openCliDb(dbPath, { readonly: opts.dryRun, fileMustExist: true });
  try {
    if (opts.dryRun) {
      const orphans = findOrphanFiles(db);
      const bytes = orphans.reduce((s, r) => s + r.size, 0);
      for (const r of orphans) {
        console.log(
          `  file_id=${r.id} size=${r.size} sha256=${r.sha256.slice(0, 12)}… ` +
            `enc_path=${r.enc_path} created_at=${r.created_at}`,
        );
      }
      console.log(`[GC] dry-run：${orphans.length} 个孤儿文件，合计 ${bytes} 字节。加 --delete 才真删。`);
    } else {
      const { removed, freedBytes } = gcOrphanFiles(db, { deleteFromDisk: opts.deleteFromDisk });
      console.log(`[GC] 已删 ${removed} 个孤儿文件，释放 ${freedBytes} 字节。`);
    }
  } catch (e) {
    if (opts.dryRun) rethrowIfSchemaStale(e, dbPath); // dry-run 是只读句柄，跑不了迁移
    throw e;
  } finally {
    db.close();
  }
  return 0;
}
