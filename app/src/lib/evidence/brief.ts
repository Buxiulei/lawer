// app/src/lib/evidence/brief.ts
// 证据简报的落库口与生成器插座（设计稿 §2 B：evidence_brief_get / evidence_brief_update）。
//
// 【这个文件为什么只有插座，没有生成逻辑】简报**内容**怎么写是另一张工单的事
// （提取与解读那条线）。这里负责的是三件与内容无关、但错了就会静默出事的事：
//   1. 什么时候该生成（没有简报时才生成，绝不覆盖已有的那版）
//   2. 谁写的（brief_updated_by），
//   3. 生成失败绝不影响调用它的那件事（出证）。
// 生成器由那条线在启动时用 setBriefGenerator 插进来；没插的时候这里安静地什么都不做。
//
// 【为什么"生成失败不影响出证"要写死在这里，不靠调用方自觉】出证是用户花时间等来的
// 结果，简报是附赠品。让一个附赠品的异常把出证的 200 变成 500，用户会以为存证没成
// ——而 TSA 时间戳其实已经盖好落库了，他再点一次也只会拿到同一个订单号，
// 于是"失败"和"成功"在他眼里长得一样，只有客服能分辨。
import type { Database } from 'better-sqlite3';

import { nowSql } from '@/lib/db/time';

/** 生成器拿到的全部输入。**没有文件字节**：简报是对已有事实的整理，不是又一次读文件。 */
export interface BriefInput {
  evidenceId: number;
  caseId: number;
  userId: number;
  name: string;
  category: string;
  provePurpose: string | null;
  originalMedium: string | null;
  mime: string | null;
  /** 提取出来的正文；null = 没提取过或提取失败，此时生成器只能按元数据写 */
  extractedText: string | null;
  /** 提取的附带信息（时间轴、说话人、帧号…）原始 JSON 串 */
  extractedMetaJson: string | null;
}

/** 简报正文。分节结构由生成器那条线定，这里只负责原样序列化落库。 */
export type BriefSections = Record<string, unknown>;

/**
 * 生成器签名。返回 null = 「这件我写不出简报」，按不写处理（不是错误，不记失败）。
 * 允许是异步的：真实实现要调模型。
 */
export type BriefGenerator = (input: BriefInput) => Promise<BriefSections | null> | BriefSections | null;

let generator: BriefGenerator | null = null;

/** 插入（或用 null 拔掉）生成器。测试用假生成器走的也是这个口。 */
export function setBriefGenerator(fn: BriefGenerator | null): void {
  generator = fn;
}

export function getBriefGenerator(): BriefGenerator | null {
  return generator;
}

interface BriefRow {
  id: number;
  case_id: number;
  user_id: number;
  name: string;
  category: string;
  prove_purpose: string | null;
  original_medium: string | null;
  mime: string | null;
  extracted_text: string | null;
  extracted_meta_json: string | null;
  brief_version: number;
}

/** 为什么这次没写简报。**每一档都是可以照着查的原因，没有一个笼统的「失败」。** */
export type BriefOutcome =
  | 'written'
  | 'already' // 已经有简报，不覆盖
  | 'no_generator' // 生成器没插上（提取那条线还没接线）
  | 'not_found'
  | 'declined' // 生成器自己说写不出
  | 'error'; // 生成器抛了；异常被吞在这里，出证不受影响

/**
 * 没有简报就生成一版，已经有就原样不动。
 *
 * 【为什么条件写在 SQL 的 WHERE 里，不是先读后写】读到 version=0、生成器跑了几秒、
 * 期间用户在网页上手写了一版——这时候再写就把人手写的那版盖掉了。
 * `WHERE brief_version = 0` 让这种情况直接落空（changes=0），返回 'already'。
 */
export async function ensureBrief(
  db: Database,
  evidenceId: number,
  updatedBy = 'system',
): Promise<BriefOutcome> {
  const row = db
    .prepare(
      // mime 在 files 上，不在 evidence 上（文件按哈希去重，元数据跟着文件走）
      `SELECT e.id, e.case_id, e.user_id, e.name, e.category, e.prove_purpose, e.original_medium,
              f.mime, e.extracted_text, e.extracted_meta_json, e.brief_version
         FROM evidence e JOIN files f ON f.id = e.file_id
        WHERE e.id = ?`,
    )
    .get(evidenceId) as BriefRow | undefined;
  if (!row) return 'not_found';
  if (row.brief_version > 0) return 'already';
  const fn = generator;
  if (!fn) return 'no_generator';

  let sections: BriefSections | null;
  try {
    sections = await fn({
      evidenceId: row.id,
      caseId: row.case_id,
      userId: row.user_id,
      name: row.name,
      category: row.category,
      provePurpose: row.prove_purpose,
      originalMedium: row.original_medium,
      mime: row.mime,
      extractedText: row.extracted_text,
      extractedMetaJson: row.extracted_meta_json,
    });
  } catch {
    // 吞掉：调用方（出证）不该因为附赠品出错而失败。原因不往上抛，但档位是 'error'，
    // 调用方要记日志时分得清「没插生成器」与「生成器炸了」。
    return 'error';
  }
  if (!sections) return 'declined';

  const changed = db
    .prepare(
      `UPDATE evidence
          SET brief_json = ?, brief_version = 1, brief_updated_by = ?, brief_updated_at = ?
        WHERE id = ? AND brief_version = 0`,
    )
    .run(JSON.stringify(sections), updatedBy, nowSql(), evidenceId).changes;
  return changed === 1 ? 'written' : 'already';
}
