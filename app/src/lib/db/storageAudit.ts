// app/src/lib/db/storageAudit.ts
// 存储用量审计（P2-7）：按用户聚合「上传材料字节 + AI 对话字节 + 证据条数」。
// CLI 入口在仓库根 scripts/storage-audit.ts（那里只做「定位库 + 打印 + 退出码」，逻辑全在这里，可单测）；
// 用户自查端点在 app/src/app/api/v1/me/storage/route.ts（走 requireIdentity，只给本人那一行）。
//
// ───────────────── 为什么不建缓存表 ─────────────────
// 三项指标都能从现有表直接聚合出来，**不需要新表**：
//   ① 文件字节 = files.size，归属由引用侧决定（见下「归属路径」）
//   ② 对话字节 = messages.content，用户由 threads → cases.user_id 推出
//   ③ 证据条数 = evidence.user_id 直接分组
// 建缓存表要在每次上传 / 每条消息 / 每次删案时同步维护，漏一处就长期给出一个
// **看起来完全正常的错数**——而存储用量恰恰是没人会去核对的那类数。
// 纯查询没有失效问题：读出来的永远是当下的库。代价是每次查全量扫，
// 本项目量级（单人案件档案）下可接受；真扫不动了再谈物化，那时也该先有真实的慢查询证据。
//
// ───────────────── 归属路径与两个坑 ─────────────────
// files 是**内容寻址的裸资源**：无 case_id/user_id、sha256 唯一（同一份文件全库只存一行）。
// 所以「这些字节算谁的」只能由引用它的三张表回推（OWNER_PATHS）。由此有两个必须报出来、
// 不能悄悄抹平的口径问题：
//
//   【坑一 · 一文件多主】sha256 唯一 ⇒ 两个用户传同一份文件只占一份盘空间，
//   但两人各自的用量里都该算上它（对用户说「你占了 0 字节，因为别人也传了」是荒谬的）。
//   于是 **Σ 各用户字节 ≥ 物理字节**，差额即 double_counted_bytes，本报告显式给出。
//
//   【坑二 · 有引用无主】attestations.evidence_id 是 ON DELETE SET NULL：证据被删后
//   出证证书 PDF 仍在（存证只追加不修改），但**再也推不出属主**。这类字节既不属于任何用户，
//   也不是孤儿（filesGc 不会回收它，它确实被 attestations 引用着），
//   计为 unattributed_bytes——不并进任何人头上，也不从总数里消失。
//
// 两条判据，落成 CLI 退出码、并由测试机检（storageAudit.test.ts）：
//   ① 物理 = 有主(去重) + 无主 + 孤儿（报告内部的算术）
//   ② 主查询产出的每一个数，与一条**独立重算**的对照管线逐项相等（见 checkStorageIdentities）
//
// ───────────────── 一个假设（未做校验） ─────────────────
// 文件归属走 evidence.user_id（冗余列），未核对它与 cases.user_id 是否一致。
// 两者若漂移，本报告的归属会跟着 evidence.user_id 走。查这类漂移是对账（reconcile.ts）的活，
// 不在本模块口径内——写在这里是为了让读数的人知道这把尺子量的是哪一个。
import type Database from 'better-sqlite3';

import { openCliDb, rethrowIfSchemaStale } from './cli-open';
import { REFERENCERS } from './filesGc';

/**
 * 文件 → 属主的回推路径，每条给出 (引用表, 指向 files.id 的列, 取 (file_id, user_id) 的 SQL)。
 *
 * 【必须与 filesGc.REFERENCERS 逐条对齐】那份清单是「谁引用了 files」的唯一真源，
 * 本清单是「引用者背后的人是谁」。日后任何表新增 files 外键，两处都要加：
 * 只加 filesGc 会让新表的字节在本报告里变成「无主」，只加这里会让 GC 误删。
 * **这条对齐由 storageAudit.test.ts 机检**，漏一条会当场点名是哪张表。
 */
const OWNER_PATHS: readonly { table: string; column: string; sql: string }[] = [
  {
    table: 'evidence',
    column: 'file_id',
    // 证据自带 user_id（冗余列，供归属校验），无需绕 cases
    sql: `SELECT e.file_id AS file_id, e.user_id AS user_id FROM evidence e`,
  },
  {
    table: 'attestations',
    column: 'cert_pdf_file_id',
    // INNER JOIN 是有意的：evidence_id 为 NULL（证据已删）的出证证书推不出属主，
    // 在这里被丢掉，随后由 totals 的 unattributed 口径捡回来，不会凭空消失。
    sql: `SELECT a.cert_pdf_file_id AS file_id, e.user_id AS user_id
            FROM attestations a
            JOIN evidence e ON e.id = a.evidence_id
           WHERE a.cert_pdf_file_id IS NOT NULL`,
  },
  {
    table: 'company_docs',
    column: 'file_id',
    sql: `SELECT d.file_id AS file_id, c.user_id AS user_id
            FROM company_docs d
            JOIN cases c ON c.id = d.case_id`,
  },
];

/** 供测试核对两份清单一致性；不参与查询。 */
export const OWNER_PATH_KEYS: readonly string[] = OWNER_PATHS.map((p) => `${p.table}.${p.column}`);
export const REFERENCER_KEYS: readonly string[] = REFERENCERS.map(([t, c]) => `${t}.${c}`);

/** UNION（非 UNION ALL）去重 (file_id, user_id)：同一用户用两条证据引同一文件只算一次。 */
const FILE_OWNER = OWNER_PATHS.map((p) => p.sql).join('\n  UNION\n  ');

/** 「至少有一个引用者」的条件式，由 filesGc 的引用者清单派生——不另抄一份表名。 */
const IS_REFERENCED = REFERENCERS.map(
  ([t, c]) => `EXISTS (SELECT 1 FROM ${t} x WHERE x.${c} = fl.id)`,
).join('\n        OR ');

/**
 * content 的 UTF-8 **字节**数。
 *
 * 【为什么不是 LENGTH(content)】SQLite 的 LENGTH() 对 TEXT 返回**字符**数：
 * '解除通知书' → 5，而它在盘上占 15 字节。本站内容以中文为主，
 * 用字符数当字节数会把存储用量**低报到三分之一**。CAST 成 BLOB 后 LENGTH 才是字节数。
 */
const CONTENT_BYTES = `LENGTH(CAST(msg.content AS BLOB))`;

/**
 * 按用户聚合的主查询。`userFilter` 为空串=全量，或 `WHERE u.user_id = ?`（单人自查）。
 *
 * 【为什么单人查询也走这条 SQL】口径只有一处：单人页与管理侧全量表若各写一条 SQL，
 * 两边迟早给出不一样的数，而「我的用量」和「后台看到的我的用量」对不上是最难查的那种 bug。
 * 代价是单人查询也会先算全量再筛，本项目量级下换口径统一，值。
 */
function userRowsSql(userFilter: string): string {
  return `
  WITH file_owner AS (
    ${FILE_OWNER}
  ),
  f AS (
    SELECT o.user_id AS user_id, COUNT(*) AS n, COALESCE(SUM(fl.size), 0) AS b
      FROM file_owner o JOIN files fl ON fl.id = o.file_id
     GROUP BY o.user_id
  ),
  m AS (
    -- COUNT(*) 数行、SUM 跳过 NULL：assistant 行 content 为 NULL = 生成中/中断
    -- （见 messages 表注释），那一行确实存在但没占内容字节，两个数各自诚实。
    SELECT c.user_id AS user_id, COUNT(*) AS n, COALESCE(SUM(${CONTENT_BYTES}), 0) AS b
      FROM messages msg
      JOIN threads t ON t.id = msg.thread_id
      JOIN cases c ON c.id = t.case_id
     GROUP BY c.user_id
  ),
  e AS (
    SELECT user_id, COUNT(*) AS n FROM evidence GROUP BY user_id
  ),
  u AS (
    SELECT user_id FROM f UNION SELECT user_id FROM m UNION SELECT user_id FROM e
  )
  SELECT u.user_id                             AS user_id,
         COALESCE(f.n, 0)                      AS file_count,
         COALESCE(f.b, 0)                      AS file_bytes,
         COALESCE(e.n, 0)                      AS evidence_count,
         COALESCE(m.n, 0)                      AS message_count,
         COALESCE(m.b, 0)                      AS message_bytes,
         COALESCE(f.b, 0) + COALESCE(m.b, 0)   AS total_bytes
    FROM u
    LEFT JOIN f ON f.user_id = u.user_id
    LEFT JOIN m ON m.user_id = u.user_id
    LEFT JOIN e ON e.user_id = u.user_id
    ${userFilter}
   ORDER BY u.user_id
`;
}

const SQL_ALL_USERS = userRowsSql('');
const SQL_ONE_USER = userRowsSql('WHERE u.user_id = ?');

/** 全库口径。三个字节桶互斥且穷尽：有主(去重) / 有引用无主 / 无人引用。 */
const SQL_TOTALS = `
  WITH file_owner AS (
    ${FILE_OWNER}
  ),
  owned AS (SELECT DISTINCT file_id FROM file_owner)
  SELECT
    (SELECT COALESCE(SUM(size), 0) FROM files) AS physical_bytes,
    (SELECT COUNT(*) FROM files)               AS physical_count,
    (SELECT COALESCE(SUM(fl.size), 0) FROM files fl
      WHERE EXISTS (SELECT 1 FROM owned o WHERE o.file_id = fl.id)) AS attributed_bytes,
    (SELECT COUNT(*) FROM files fl
      WHERE EXISTS (SELECT 1 FROM owned o WHERE o.file_id = fl.id)) AS attributed_count,
    (SELECT COALESCE(SUM(fl.size), 0) FROM files fl
      WHERE NOT EXISTS (SELECT 1 FROM owned o WHERE o.file_id = fl.id)
        AND (${IS_REFERENCED}))                AS unattributed_bytes,
    (SELECT COUNT(*) FROM files fl
      WHERE NOT EXISTS (SELECT 1 FROM owned o WHERE o.file_id = fl.id)
        AND (${IS_REFERENCED}))                AS unattributed_count,
    (SELECT COALESCE(SUM(fl.size), 0) FROM files fl
      WHERE NOT (${IS_REFERENCED}))            AS orphan_bytes,
    (SELECT COUNT(*) FROM files fl
      WHERE NOT (${IS_REFERENCED}))            AS orphan_count
`;

export interface UserStorageRow {
  user_id: number;
  /** 该用户可达的**去重后**文件数（同一文件被自己多处引用只算一个）。 */
  file_count: number;
  file_bytes: number;
  evidence_count: number;
  /** 该用户名下全部对话消息行数，含 content 为 NULL 的生成中/中断行。 */
  message_count: number;
  /** content 的 UTF-8 字节数，**不含** tokens_json / model 等元数据列。 */
  message_bytes: number;
  /** file_bytes + message_bytes。 */
  total_bytes: number;
}

export interface StorageTotals {
  physical_bytes: number;
  physical_count: number;
  /** 去重后、能推出属主的文件。 */
  attributed_bytes: number;
  attributed_count: number;
  /** 有引用但推不出属主（如证据已删的出证证书 PDF）。 */
  unattributed_bytes: number;
  unattributed_count: number;
  /** 无任何引用者（filesGc 的回收对象）。 */
  orphan_bytes: number;
  orphan_count: number;
  /** Σ各用户 file_bytes − attributed_bytes：多个用户共享同一份文件造成的重复计数。 */
  double_counted_bytes: number;
}

export interface StorageAuditReport {
  users: UserStorageRow[];
  totals: StorageTotals;
}

/** 空用量用户的零行。查无此人与用量为零在前端是两种渲染，不在这里抹平（由调用方决定给谁零行）。 */
export function emptyStorageRow(userId: number): UserStorageRow {
  return {
    user_id: userId,
    file_count: 0,
    file_bytes: 0,
    evidence_count: 0,
    message_count: 0,
    message_bytes: 0,
    total_bytes: 0,
  };
}

/**
 * 查单个用户的存储用量（只读）。无任何用量时给零行而非 undefined——
 * 「这个用户没占空间」是一个正常答案，不该让调用方去分辨 undefined 是没查到还是没用量。
 */
export function getUserStorage(db: Database.Database, userId: number): UserStorageRow {
  const row = db.prepare(SQL_ONE_USER).get(userId) as UserStorageRow | undefined;
  return row ?? emptyStorageRow(userId);
}

/** 全量审计（只读，不写任何行）。 */
export function auditStorage(db: Database.Database): StorageAuditReport {
  const users = db.prepare(SQL_ALL_USERS).all() as UserStorageRow[];
  const t = db.prepare(SQL_TOTALS).get() as Omit<StorageTotals, 'double_counted_bytes'>;
  const summed = users.reduce((s, r) => s + r.file_bytes, 0);
  return { users, totals: { ...t, double_counted_bytes: summed - t.attributed_bytes } };
}

/** 对照管线重算出来的同一批数（键为 user_id）。 */
interface ControlCounts {
  fileBytesByUser: Map<number, number>;
  messageBytesByUser: Map<number, number>;
  summedFileBytes: number;
  physicalBytes: number;
  attributedBytes: number;
  unattributedBytes: number;
  orphanBytes: number;
}

/**
 * 对照管线：**不复用主查询的任何一条 SQL**，改从基表原样取行、在 TS 里把同一批数重算一遍。
 *
 * 刻意在每个易错处换一种实现，好让两条管线不会一起错：
 *   · 去重用 JS Set，不用 SQL 的 UNION；
 *   · 字节用 Buffer.byteLength，不用 SQLite 的 LENGTH（字符/字节之分正是本模块踩过的坑）；
 *   · 归属靠逐表取 (id, user_id) 后在内存里接图，不用 JOIN 拼出 user_id；
 *   · 「有无引用」直接遍历 REFERENCERS 各列，不用 EXISTS 条件式。
 * 分桶口径与主查询保持一致（有主 / 非有主但有引用 / 无引用），故「有主却无人引用」这种
 * 归属与引用判据打架的情形两边会一致地多计——那一路由恒等式 ① 单独兜。
 *
 * 【日后加第四条 files 外键】OWNER_PATHS 与本函数都要加。只加 OWNER_PATHS 的表现是本自检
 * **误报**（主查询说有主、对照说无主），错在偏报警那一侧，不会把错数静默放过。
 */
function recomputeFromBaseTables(db: Database.Database): ControlCounts {
  const sizeOf = new Map<number, number>();
  for (const f of db.prepare('SELECT id, size FROM files').iterate() as Iterable<{
    id: number;
    size: number;
  }>) {
    sizeOf.set(f.id, f.size);
  }

  const ownersOf = new Map<number, Set<number>>();
  const own = (fileId: number | null, userId: number | null | undefined) => {
    if (fileId == null || userId == null || !sizeOf.has(fileId)) return;
    let s = ownersOf.get(fileId);
    if (!s) {
      s = new Set();
      ownersOf.set(fileId, s);
    }
    s.add(userId);
  };

  const userOfCase = new Map<number, number>();
  for (const c of db.prepare('SELECT id, user_id FROM cases').iterate() as Iterable<{
    id: number;
    user_id: number;
  }>) {
    userOfCase.set(c.id, c.user_id);
  }

  const userOfEvidence = new Map<number, number>();
  for (const e of db.prepare('SELECT id, user_id, file_id FROM evidence').iterate() as Iterable<{
    id: number;
    user_id: number;
    file_id: number | null;
  }>) {
    userOfEvidence.set(e.id, e.user_id);
    own(e.file_id, e.user_id);
  }
  for (const d of db.prepare('SELECT case_id, file_id FROM company_docs').iterate() as Iterable<{
    case_id: number;
    file_id: number | null;
  }>) {
    own(d.file_id, userOfCase.get(d.case_id));
  }
  for (const a of db
    .prepare('SELECT evidence_id, cert_pdf_file_id FROM attestations')
    .iterate() as Iterable<{ evidence_id: number | null; cert_pdf_file_id: number | null }>) {
    own(a.cert_pdf_file_id, a.evidence_id == null ? null : userOfEvidence.get(a.evidence_id));
  }

  const referenced = new Set<number>();
  for (const [t, c] of REFERENCERS) {
    for (const r of db.prepare(`SELECT DISTINCT ${c} AS fid FROM ${t}`).iterate() as Iterable<{
      fid: number | null;
    }>) {
      if (r.fid != null) referenced.add(r.fid);
    }
  }

  const fileBytesByUser = new Map<number, number>();
  let physicalBytes = 0;
  let attributedBytes = 0;
  let unattributedBytes = 0;
  let orphanBytes = 0;
  for (const [id, size] of sizeOf) {
    physicalBytes += size;
    const owners = ownersOf.get(id);
    if (owners && owners.size > 0) {
      attributedBytes += size;
      for (const uid of owners) fileBytesByUser.set(uid, (fileBytesByUser.get(uid) ?? 0) + size);
    } else if (referenced.has(id)) {
      unattributedBytes += size;
    }
    if (!referenced.has(id)) orphanBytes += size;
  }

  const caseOfThread = new Map<number, number>();
  for (const t of db.prepare('SELECT id, case_id FROM threads').iterate() as Iterable<{
    id: number;
    case_id: number;
  }>) {
    caseOfThread.set(t.id, t.case_id);
  }
  const messageBytesByUser = new Map<number, number>();
  for (const m of db.prepare('SELECT thread_id, content FROM messages').iterate() as Iterable<{
    thread_id: number;
    content: string | Buffer | null;
  }>) {
    const caseId = caseOfThread.get(m.thread_id);
    const uid = caseId == null ? undefined : userOfCase.get(caseId);
    if (uid === undefined) continue;
    const bytes = m.content == null ? 0 : Buffer.byteLength(m.content, 'utf8');
    messageBytesByUser.set(uid, (messageBytesByUser.get(uid) ?? 0) + bytes);
  }

  let summedFileBytes = 0;
  for (const b of fileBytesByUser.values()) summedFileBytes += b;

  return {
    fileBytesByUser,
    messageBytesByUser,
    summedFileBytes,
    physicalBytes,
    attributedBytes,
    unattributedBytes,
    orphanBytes,
  };
}

/**
 * 自检：一条恒等式 + 一条**独立重算**的对照。返回违反的说明（空数组=对得上）。
 *
 * 【为什么审计要自检】一张按用户列字节的表，谁都不会去核对它加起来对不对——
 * 错了也只是「某个数看着有点大」。所以把核对变成 CLI 的退出码。
 *
 * 【为什么必须是两条管线】自检若只拿主查询产出的数互相验算，写出来的会是恒真式。
 * 本函数上一版正是如此：double_counted 由「Σ各用户 − 有主」算出，自检又拿同样的
 * Σ各用户与有主相减去比它，无论 SQL 被改成什么都恒等——那行断言从来没有过牙。
 * 现在对照值改由 recomputeFromBaseTables 从基表原样取行、换一套实现重算，
 * 两条管线出错的方式不一样，才有资格互证。
 *
 * 【实测能点名的改坏】（storageAudit.test.ts「产线变异」把改动施在源码上再跑真 CLI，
 * 逐条断言退出码变 1）：去重写成 UNION ALL；三条归属路径中任一条的 SQL 被改哑；
 * 对话字节从 LENGTH(CAST(…AS BLOB)) 退回按字符数计。
 *
 * 【它管不到的】两条管线都建立在 OWNER_PATHS 那套「谁是属主」的语义上：若这套语义
 * 本身是错的（例如 evidence.user_id 与 cases.user_id 漂移），两边会一致地错，本自检不会响。
 * 那是对账（reconcile.ts）的活，见本文件抬头「一个假设」。
 */
export function checkStorageIdentities(db: Database.Database, r: StorageAuditReport): string[] {
  const t = r.totals;
  const out: string[] = [];

  const bucketSum = t.attributed_bytes + t.unattributed_bytes + t.orphan_bytes;
  if (bucketSum !== t.physical_bytes) {
    out.push(
      `物理字节对不上：SUM(files.size)=${t.physical_bytes}，而 有主=${t.attributed_bytes}` +
        ` + 无主=${t.unattributed_bytes} + 孤儿=${t.orphan_bytes} = ${bucketSum}（差 ${t.physical_bytes - bucketSum}）。` +
        `三个桶本应互斥且穷尽，对不上说明归属判据与引用判据用了不同口径。`,
    );
  }

  const ctl = recomputeFromBaseTables(db);
  const cmp = (what: string, main: number, control: number) => {
    if (main !== control) {
      out.push(`与对照重算不符 · ${what}：主查询=${main}，逐表重算=${control}（差 ${main - control}）。`);
    }
  };
  cmp('物理字节', t.physical_bytes, ctl.physicalBytes);
  cmp('有主字节', t.attributed_bytes, ctl.attributedBytes);
  cmp('无主字节', t.unattributed_bytes, ctl.unattributedBytes);
  cmp('孤儿字节', t.orphan_bytes, ctl.orphanBytes);
  cmp('重复计数', t.double_counted_bytes, ctl.summedFileBytes - ctl.attributedBytes);

  const mainFiles = new Map(r.users.map((u) => [u.user_id, u.file_bytes]));
  const mainMsgs = new Map(r.users.map((u) => [u.user_id, u.message_bytes]));
  const uids = new Set<number>([
    ...mainFiles.keys(),
    ...ctl.fileBytesByUser.keys(),
    ...ctl.messageBytesByUser.keys(),
  ]);
  for (const uid of [...uids].sort((a, b) => a - b)) {
    cmp(`user_id=${uid} 文件字节`, mainFiles.get(uid) ?? 0, ctl.fileBytesByUser.get(uid) ?? 0);
    cmp(`user_id=${uid} 对话字节`, mainMsgs.get(uid) ?? 0, ctl.messageBytesByUser.get(uid) ?? 0);
  }

  if (t.double_counted_bytes < 0) {
    out.push(
      `重复计数为负（${t.double_counted_bytes}）：说明存在「有主但没算进任何用户行」的文件，` +
        `多半是某条归属路径把 user_id 取成了 NULL。`,
    );
  }

  return out;
}

/** 字节数的人读形式。审计表全是 9 位数时肉眼分不出 30MB 和 300MB。 */
export function humanBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${n} B` : `${v.toFixed(1)} ${units[i]}`;
}

/**
 * CLI 本体：只读打开 dbPath、全量审计、打印明细与总账。
 * @returns 进程退出码（0=恒等式成立；1=口径对不上，报告不可信）。
 */
export function storageAuditCli(dbPath: string): number {
  console.log(`[存储审计] 库：${dbPath}`);
  const db = openCliDb(dbPath, { readonly: true, fileMustExist: true });
  let report: StorageAuditReport;
  let violations: string[];
  try {
    report = auditStorage(db);
    // 自检要另取一遍基表跑对照重算，所以必须在关库之前做完
    violations = checkStorageIdentities(db, report);
  } catch (e) {
    rethrowIfSchemaStale(e, dbPath); // 恒只读，跑不了迁移
  } finally {
    db.close();
  }

  for (const u of report.users) {
    console.log(
      `  user_id=${u.user_id}  合计 ${humanBytes(u.total_bytes)}` +
        `（文件 ${humanBytes(u.file_bytes)} / ${u.file_count} 个，` +
        `对话 ${humanBytes(u.message_bytes)} / ${u.message_count} 条）` +
        `  证据 ${u.evidence_count} 条`,
    );
  }

  const t = report.totals;
  console.log(`[存储审计] ${report.users.length} 个用户有用量`);
  console.log(
    `[总账] 物理 ${humanBytes(t.physical_bytes)}（${t.physical_count} 个文件）` +
      ` = 有主 ${humanBytes(t.attributed_bytes)}（${t.attributed_count}）` +
      ` + 无主 ${humanBytes(t.unattributed_bytes)}（${t.unattributed_count}）` +
      ` + 孤儿 ${humanBytes(t.orphan_bytes)}（${t.orphan_count}）`,
  );
  if (t.double_counted_bytes > 0) {
    console.log(
      `[总账] 其中 ${humanBytes(t.double_counted_bytes)} 被重复计数` +
        `（多个用户共享同一份文件，各自全额计入；盘上只存一份）`,
    );
  }
  if (t.unattributed_count > 0) {
    console.log(
      `[提示] ${t.unattributed_count} 个文件有引用但推不出属主` +
        `（多为证据已删、出证证书仍在的情形），不计入任何用户名下。`,
    );
  }
  if (t.orphan_count > 0) {
    console.log(`[提示] ${t.orphan_count} 个文件无任何引用，可用 npm run gc:files 回收。`);
  }

  for (const v of violations) console.error(`[口径错] ${v}`);
  if (violations.length > 0) {
    console.error(`[存储审计] 失败：${violations.length} 项自检不通过，本次数字不可信。`);
    return 1;
  }
  return 0;
}
