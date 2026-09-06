// app/src/lib/evidence/void.ts
// 作废一件材料（援助律师 09-06 实测缺口④）。MCP 工具与网页路由共用这一份。
//
// 【作废是什么】用户说「这份不作数」时按下的那个开关：材料仍在盘上、仍占存储配额，
// 但它从此不进任何**对外当成证据用**的视图——清单默认不列、事实卡不列、出证直接拒。
//
// 【为什么不删】已出证的条目背后有一张不可撤销的存证订单：时间戳已经签发，
// 对方拿订单号照样能核。删掉材料行会让那个订单号指向一条不存在的材料，
// 而订单本身仍然验得过——那是比"这份不作数"严重得多的一种不一致。
// 所以本模块**一个字都不动 attestations**，只在 evidence 上打标记。
//
// 【为什么理由必填】没有理由的作废，事后与"误点了一下"无法分辨。而这个动作会让
// 一份可能是关键证据的材料从所有视图里消失，读到的人（下一个 agent、开庭前的用户本人）
// 需要知道它当初为什么被摘出去，才能判断该不该撤回这个决定。
import type { Database } from 'better-sqlite3';

import { nowSql } from '@/lib/db/time';

import { fail, type Result } from './attest';

/** 作废后 evidence.status 的取值，与 已上传 / 已固化 / 已出证 同一族。 */
export const EV_VOIDED = '已作废';

export interface VoidedEvidenceView {
  evidence_id: number;
  case_id: number;
  name: string;
  /** 作废前的状态，原样带回：已出证的材料作废后，那张存证订单仍然有效 */
  previous_status: string;
  status: string;
  void_reason: string;
  voided_at: string;
  /** 这条材料有没有存证订单。有 = 订单未撤销，只是材料不再当证据用 */
  attested: boolean;
  note: string;
}

interface VoidRow {
  id: number;
  case_id: number;
  user_id: number;
  name: string;
  status: string;
  void_reason: string | null;
  voided_at: string | null;
}

const NOT_FOUND = () =>
  fail(
    404,
    'EVIDENCE_NOT_FOUND',
    '这件材料不存在，或不属于本人（两者刻意不区分）。先用 evidence_list 取本人名下真实的编号。',
  );

/**
 * 作废一件材料。已经作废过的直接回既有结果（幂等，不改写理由与时刻）——
 * 重试与"改主意换个理由"是两件事，后者该先撤销再作废，本工具不提供静默改写。
 */
export function voidEvidence(
  db: Database,
  input: { evidenceId: number; userId: number; reason: string; voidedBy?: string },
): Result<VoidedEvidenceView> {
  if (!Number.isInteger(input.evidenceId) || input.evidenceId <= 0) return NOT_FOUND();
  const reason = input.reason.trim();
  if (!reason) {
    return fail(
      400,
      'VOID_REASON_REQUIRED',
      'reason（为什么作废这份材料）不能为空。' +
        '为什么：作废会让这份材料从清单、事实卡与出证里全部消失，而文件本身还在。' +
        '没有理由的话，日后读到的人分不出这是"当事人确认不作数"还是"手滑点错了"。' +
        '怎么办：写一句话，例如「重复上传，与条目 12 是同一份」或「当事人确认这份是草稿版」。',
    );
  }

  const row = db
    .prepare(
      'SELECT id, case_id, user_id, name, status, void_reason, voided_at FROM evidence WHERE id = ?',
    )
    .get(input.evidenceId) as VoidRow | undefined;
  if (!row || row.user_id !== input.userId) return NOT_FOUND();

  const attested =
    (db.prepare('SELECT 1 AS hit FROM attestations WHERE evidence_id = ? LIMIT 1').get(row.id) as
      | { hit: number }
      | undefined) !== undefined;

  if (row.voided_at !== null) {
    return {
      ok: true,
      evidence_id: row.id,
      case_id: row.case_id,
      name: row.name,
      previous_status: row.status,
      status: row.status,
      void_reason: row.void_reason ?? '',
      voided_at: row.voided_at,
      attested,
      note: '这件材料之前已经作废过了，本次没有改动任何字段（理由与时刻保持首次那一份）。',
    };
  }

  const at = nowSql();
  // WHERE voided_at IS NULL：并发下第二笔落空，不会把首次的理由与时刻覆盖掉。
  const changed = db
    .prepare(
      'UPDATE evidence SET status = ?, void_reason = ?, voided_at = ? WHERE id = ? AND voided_at IS NULL',
    )
    .run(EV_VOIDED, reason, at, row.id).changes;
  if (changed === 0) return NOT_FOUND();

  return {
    ok: true,
    evidence_id: row.id,
    case_id: row.case_id,
    name: row.name,
    previous_status: row.status,
    status: EV_VOIDED,
    void_reason: reason,
    voided_at: at,
    attested,
    note:
      '已作废：这件材料不再出现在证据清单（除非显式要 include_voided）、不再进案件事实卡，' +
      '也不能再发起出证。文件本身没有删除，仍占用户的存储配额。' +
      (attested
        ? '**它此前已经出过证，那张存证订单没有撤销**——订单号照旧可以被对方核验，' +
          '作废只表示当事人不再拿这份材料当证据用。'
        : ''),
  };
}
