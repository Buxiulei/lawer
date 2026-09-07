// app/src/lib/lifecycle/case-export.ts
// 整案导出（协议 v0.2 五.9「导出整案副本」、五.12，附一第 7 项）：档案全表 JSON + 文书 PDF
// + 证据原件，打成一个 zip，走既有的一次性下载地址下发。**免费**。
//
// 【档案全表是查出来的，不是手抄的一张表名清单】导出的语义是「这个案子在我们库里的全部
// 内容」。手写清单的形态是：新开一张挂着 case_id 的表，导出不动——而它看起来仍然完整，
// 用户拿到的副本少了一整类记录，没有任何一处会报错。所以表名由 PRAGMA 现查：
// 凡是有 case_id 列的表都进包，唯一一张按 thread_id 挂靠的 messages 单独接线，并由判据钉住。
//
// 【列级过滤：凭据与密文不出包】分享令牌、下载令牌哈希、密文字段进了包只有两种下场——
// 要么是一串用户看不懂的乱码，要么是一把还能用的钥匙躺在一个会被转发的文件里。
//
// 【一份包里可以有洞，但洞必须看得见】某份文书渲染不出来、某个原件在盘上读不回来时，
// 不让整次导出失败（那等于因为一份坏文件就交不出任何副本），而是把它记进清单.json 的
// omissions，并在 README 里明写。留一个看得见的洞，而不是一个看不见的空白。
import { Buffer } from 'node:buffer';

import type { Database } from 'better-sqlite3';

import { aiLabelPdfMeta } from '@/lib/ai-label';
import { caseAiLabelLine } from '@/lib/ai-label-case';
import * as cases from '@/lib/cases';
import type { DomainFailure, Result } from '@/lib/cases';
import { readBytes, storeBytes } from '@/lib/evidence/files';
import { renderDraftPdf } from '@/lib/evidence/sidecar-client';
import { DOWNLOAD_TOKEN_TTL_MS, issueDownloadToken } from '@/lib/files/download-token';
import { downloadUrlFor } from '@/lib/drafts/export';
import { toSql } from '@/lib/db/time';

import { buildZip, type ZipEntry } from './zip';

const TTL_MINUTES = DOWNLOAD_TOKEN_TTL_MS / 60_000;

/**
 * 一份包最多装多少字节。**不是性能调优，是内存护栏**：整包在内存里拼（见 zip.ts），
 * 一个存了几个 G 录像的案子会把进程直接撑死，而那时页面上什么都看不出来。
 * 超预算的原件不进包、进 omissions，用户看得见少了哪几份、为什么少。
 */
export const EXPORT_BYTE_BUDGET = 200 * 1024 * 1024;

/**
 * 不进包的列。
 *   · `token` / `token_hash`：分享与下载的凭据，进包等于把还能用的钥匙随包发出去；
 *   · `*_enc`：密文，用户拿到只是一串乱码（对应的明文另有出口）；
 *   · `*_hash`：查找摘要与危机词哈希，对用户无意义，且是可反查的辅助键。
 * 判据钉着这份名单真的生效（见 __tests__/case-export.test.ts）。
 */
function isSecretColumn(name: string): boolean {
  return name === 'token' || name.endsWith('_enc') || name.endsWith('_hash');
}

interface TableRows {
  table: string;
  rows: Record<string, unknown>[];
}

/** 库里所有带 case_id 列的表名（按名字排序，包内顺序稳定，两次导出可逐字对比）。 */
export function tablesWithCaseId(db: Database): string[] {
  const names = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
  return names.filter((t) =>
    (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some(
      (c) => c.name === 'case_id',
    ),
  );
}

function stripSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!isSecretColumn(k)) out[k] = v;
  return out;
}

/**
 * 这个案子在库里的全部内容。
 *
 * messages 单独一条：它是唯一一张不带 case_id、按 thread_id 挂靠的业务表，而它装的正是
 * 对话记录——协议第五条第 8 款点名要删、第 9 款点名要能导出的那一样。漏掉它的形态是，
 * 一份"完整副本"里一句对话都没有。
 */
export function collectCaseArchive(db: Database, caseId: number): TableRows[] {
  const out: TableRows[] = [
    {
      table: 'cases',
      rows: (db.prepare('SELECT * FROM cases WHERE id = ?').all(caseId) as Record<string, unknown>[]).map(
        stripSecrets,
      ),
    },
  ];
  for (const table of tablesWithCaseId(db)) {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE case_id = ? ORDER BY rowid`).all(caseId) as Record<
      string,
      unknown
    >[];
    out.push({ table, rows: rows.map(stripSecrets) });
  }
  out.push({
    table: 'messages',
    rows: (
      db
        .prepare(
          `SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id
            WHERE t.case_id = ? ORDER BY m.id`,
        )
        .all(caseId) as Record<string, unknown>[]
    ).map(stripSecrets),
  });
  return out;
}

/** 路径分隔符与控制字符换成下划线；中文原样保留（zip 头按 UTF-8 写，见 zip.ts）。 */
function safeName(raw: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex -- 控制字符正是这里要洗掉的东西
  const cleaned = (raw ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60);
  return cleaned || fallback;
}

/** 包里少了什么、为什么少。 */
export interface ExportOmission {
  path: string;
  reason: string;
}

export interface CaseExported {
  case_id: number;
  filename: string;
  download_url: string;
  expires_at: string;
  size: number;
  sha256: string;
  /** 包里有哪些文件（顺序即包内顺序） */
  entries: string[];
  omissions: ExportOmission[];
  note: string;
}

/** 渲染一份文书 PDF 的注入点（判据注入假渲染器；生产走 sidecar）。 */
export type RenderDraftPdf = (payload: unknown) => Promise<Buffer>;
/** 读一份原件明文的注入点（同上）。 */
export type ReadFileBytes = (db: Database, fileId: number) => Buffer;

export interface ExportCaseInput {
  db: Database;
  caseId: number;
  userId: number;
  now?: Date;
  renderPdf?: RenderDraftPdf;
  readFile?: ReadFileBytes;
}

interface DraftRow {
  id: number;
  title: string;
  content: string | null;
  version: number;
}

interface EvidenceFileRow {
  id: number;
  name: string;
  file_id: number;
  size: number;
  mime: string | null;
}

/**
 * 导出整案副本。**只读**案卷：除了落一份导出件与签一条下载地址，一行案卷数据都不改。
 *
 * 归属走 cases.getCase（同全站那道门：不是自己的案件与不存在的案件同码）。
 * 实名闸不在这里判——它是能力条目上的 precondition，由唯一入口统一拦。
 */
export async function exportCase(input: ExportCaseInput): Promise<Result<CaseExported>> {
  const { db, caseId, userId } = input;
  const owned = cases.getCase(db, { caseId, userId, timelineLimit: 1 });
  if (!owned.ok) return owned as DomainFailure;

  const now = input.now ?? new Date();
  const render = input.renderPdf ?? renderDraftPdf;
  const read = input.readFile ?? readBytes;
  const omissions: ExportOmission[] = [];
  const entries: ZipEntry[] = [];
  let budget = EXPORT_BYTE_BUDGET;

  /** 装一个条目；超预算就不装、记一条洞。 */
  const add = (name: string, data: Buffer, whatIsIt: string): void => {
    if (data.length > budget) {
      omissions.push({
        path: name,
        reason:
          `${whatIsIt}有 ${data.length} 字节，装进去会超出单包上限 ${EXPORT_BYTE_BUDGET} 字节，本次没有装。` +
          '怎么办：这一份可以单独下载（材料详情页里那份原件），或者联系我们分批导出。',
      });
      return;
    }
    budget -= data.length;
    entries.push({ name, data });
  };

  // ① 档案全表
  const archive = collectCaseArchive(db, caseId);
  add(
    '档案.json',
    Buffer.from(
      JSON.stringify(
        {
          exported_at: toSql(now),
          case_id: caseId,
          note:
            '这是你在土八鼠的案件档案在导出这一刻的全部内容，逐表原样导出。' +
            '凭据类与密文类的列不在其中（分享令牌、下载令牌哈希、加密字段）。',
          tables: Object.fromEntries(archive.map((t) => [t.table, t.rows])),
        },
        null,
        2,
      ),
      'utf-8',
    ),
    '档案 JSON',
  );

  // ② 文书 PDF。渲染不出来的那一份改装 markdown 原文，并记一条洞——
  // 让整次导出因为一份文书失败，等于用户为一份坏稿子拿不到任何副本。
  const drafts = db
    .prepare('SELECT id, title, content, version FROM drafts WHERE case_id = ? ORDER BY id')
    .all(caseId) as DraftRow[];
  const aiLabel = caseAiLabelLine(db, caseId);
  for (const draft of drafts) {
    const body = cases.stripConfirmationFooter(draft.content ?? '').trim();
    const base = `文书/${draft.id}-${safeName(draft.title, '文书')}`;
    if (!body) {
      omissions.push({
        path: `${base}.pdf`,
        reason: `文书 ${draft.id}《${draft.title}》正文是空的，没有可渲染的内容（一份零字的 PDF 看起来像导出成功了）。`,
      });
      continue;
    }
    try {
      const pdf = await render({
        title: draft.title,
        subtitle: null,
        markdown: body,
        footer_note: null,
        // 显式标识（标识办法 §4 末款：导出的文件里必须含显式标识）与隐式标识（§5）。
        // 与 lib/drafts/export 那条路同源同字段名——两处不一致的话，其中一条导出的 PDF
        // 打开来就少了法条要的那一句，而文件本身完全正常。
        ai_label: aiLabel,
        ai_meta: aiLabelPdfMeta(`draft:${draft.id}@v${draft.version}`),
      });
      add(`${base}.pdf`, pdf, `文书《${draft.title}》的 PDF`);
    } catch (err) {
      omissions.push({
        path: `${base}.pdf`,
        reason:
          `渲染服务没有把这份 PDF 交回来：${err instanceof Error ? err.message : String(err)}。` +
          '正文原文已经在 档案.json 的 drafts 表里，一个字都没丢；稍后重新导出一次即可拿到 PDF。',
      });
    }
  }

  // ③ 证据原件
  const files = db
    .prepare(
      `SELECT e.id AS id, e.name AS name, e.file_id AS file_id, f.size AS size, f.mime AS mime
         FROM evidence e JOIN files f ON f.id = e.file_id
        WHERE e.case_id = ? ORDER BY e.id`,
    )
    .all(caseId) as EvidenceFileRow[];
  for (const ev of files) {
    const path = `证据原件/${ev.id}-${safeName(ev.name, '材料')}`;
    try {
      add(path, read(db, ev.file_id), `材料《${ev.name}》的原件`);
    } catch (err) {
      omissions.push({
        path,
        reason:
          `这份原件没能取回来：${err instanceof Error ? err.message : String(err)}。` +
          '它的登记信息（名称、分类、证明目的、哈希）仍在 档案.json 的 evidence 表里。',
      });
    }
  }

  // ④ 清单与说明。**清单排在最后装**：上面每一步都可能往 omissions 里加一条，
  // 先装的那一份记的是半截状态，而它看起来同样完整。
  const manifest = {
    exported_at: toSql(now),
    case_id: caseId,
    entries: entries.map((e) => ({ path: e.name, size: e.data.length })),
    omissions,
  };
  entries.push({
    name: '清单.json',
    data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
  });
  entries.push({
    name: 'README.txt',
    data: Buffer.from(
      [
        '这是你在土八鼠的整案副本。',
        '',
        '档案.json      —— 案件档案的全部数据，逐表原样导出。',
        '文书/          —— 每一份文书的 PDF（正文原文，不含站内那段「发出前必读」提醒）。',
        '证据原件/      —— 你上传过的材料原件。',
        '清单.json      —— 这个包里有什么、少了什么以及为什么少。',
        '',
        omissions.length > 0
          ? `注意：这个包里少了 ${omissions.length} 项，逐条原因见 清单.json 的 omissions。`
          : '这一次没有任何条目被略过。',
        '',
        '文书 PDF 是人工智能生成合成内容，文件里带有显式与隐式标识；',
        '你把它发到别的平台时，请一并声明它是人工智能生成合成内容。',
      ].join('\n'),
      'utf-8',
    ),
  });

  const zip = buildZip(entries, now);
  const stored = storeBytes(db, zip, 'application/zip');
  const filename = `案件${caseId}-整案副本-${toSql(now).slice(0, 10)}.zip`;
  const issued = issueDownloadToken(db, {
    fileId: stored.fileId,
    userId,
    filename,
    mime: 'application/zip',
    now,
  });

  return {
    ok: true,
    case_id: caseId,
    filename,
    download_url: downloadUrlFor(issued.token),
    expires_at: issued.expiresAt,
    size: zip.length,
    sha256: stored.sha256,
    entries: entries.map((e) => e.name),
    omissions,
    note:
      `导出不收费。下载地址只能取一次、${TTL_MINUTES} 分钟内有效，直接用浏览器打开即可（不必带凭据）。` +
      '过期或已取过就再导出一次。' +
      (omissions.length > 0
        ? `本次有 ${omissions.length} 项没有装进包里，逐条原因在 omissions 与包内的 清单.json 里——**不要把这次导出说成完整副本**。`
        : ''),
  };
}
