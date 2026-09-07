// app/src/lib/lifecycle/case-delete.ts
// 删除一个案件（协议 v0.2 五.9「删除案件」，附一第 7 项）。
//
// 【两段：先标删、30 日后真删】第一段只落 deleted_at，读侧当作不存在（lib/db/cases 的两个
// 取数口过滤它）；第二段由 lib/jobs/retention-worker 到期硬删。当场硬删做不到两件事：
// 一是误删无从挽回——一次点击抹掉全部证据与文书；二是协议第五条第 8 款承诺的是「30 日内
// 彻底删除」，那句话本身就是一段窗口，而不是「立刻」。
//
// 【两步：先出确认单、带 confirm_token 才执行】与 draft_export 的报价→确认同形。
// 一步式的形态是：用户自己的 agent 把「我想把这个案子清掉」听成一次调用，
// 而这一步没有下一次机会。第一次调用**零写入**，回包里写清会删什么、什么会留下。
//
// 【confirm_token 从案件身份派生，不落库】它要满足三件事：不可猜（否则「二次确认」等于没有）、
// 稳定（重放同一次删除必须还能用，否则幂等就断在这里）、无状态（一张令牌表意味着又一批
// 会过期、会漏清的行）。HMAC(本机主密钥, 案件身份) 三件事一次满足。
import type { Database } from 'better-sqlite3';

import type { DomainFailure, Result } from '@/lib/cases';
import { hashLookup } from '@/lib/crypto';
import * as store from '@/lib/db/cases';
import * as lifecycle from '@/lib/db/lifecycle';
import { nowSql, toSql } from '@/lib/db/time';

import { RETENTION_DAYS, purgeAfter } from './retention';

function fail(status: number, errorCode: string, message: string): DomainFailure {
  return { ok: false, status, errorCode, message };
}

const NOT_FOUND = () =>
  fail(404, 'CASE_NOT_FOUND', '案件不存在');

/**
 * 这个案子的删除确认令牌。取案件身份里三个**永不改变**的值：id、属主、建档时刻。
 * 取 32 位十六进制（128 bit）——猜不动，也短到能让人在对话里念一遍。
 *
 * 【为什么不掺入 deleted_at 之类会变的列】掺进去的那一刻，令牌就会在第一次删除成功之后
 * 变成另一串，于是重放同一次删除（客户端没收到回包，照说明书原样重试）拿到的是
 * INVALID_CONFIRM_TOKEN——一次本该幂等的重试变成了一个看起来像出错的失败。
 */
export function caseDeleteConfirmToken(row: { id: number; user_id: number; created_at: string }): string {
  return hashLookup(`case_delete:${row.id}:${row.user_id}:${row.created_at}`).slice(0, 32);
}

/** 会被删掉的东西（回包里逐项念给用户听，不用「等」字含糊过去）。 */
export const CASE_DELETE_REMOVES: readonly string[] = [
  '这个案子的档案本身（抬头、阶段、目标与底线、用工基本盘）',
  '上传的材料条目与它们的原件文件',
  '全部对话记录与由它生成的个案报告',
  '情绪记录与危机识别记录',
  '时间线、行动卡、法定期限、诉求清单、公司档案与来文解读',
  '这个案子下的全部文书草稿',
];

/** 不会被删掉的东西。**这一份比上面那份更要紧**：用户最担心的往往正是它的补集。 */
export const CASE_DELETE_KEEPS: readonly string[] = [
  '已经出具过的存证证明：证明文件、订单号、哈希与时间戳照旧可查（公开核验地址不受影响）',
  '支付记录与账目流水：法律要求留存，按法定期限保留',
  '你此前说过「不需要心理咨询」这类拒绝记录：它要比案件活得久，否则删完案子会被重新推荐一次',
];

export interface CaseDeleteConfirm {
  stage: 'confirm';
  case_id: number;
  title: string;
  confirm_token: string;
  removes: readonly string[];
  keeps: readonly string[];
  retention_days: number;
  note: string;
}

export interface CaseDeleted {
  stage: 'deleted';
  case_id: number;
  deleted_at: string;
  /** 这一刻之后清理任务会把它真正删掉 */
  purge_after: string;
  /** 这次顺手收回了几条免登录分享链接（0 = 本来就没有活着的链接） */
  shares_revoked: number;
  /** true = 之前就删过，这一次没有改写首次删除时刻（幂等重放） */
  already_deleted: boolean;
  removes: readonly string[];
  keeps: readonly string[];
  note: string;
}

export interface DeleteCaseInput {
  db: Database;
  caseId: number;
  userId: number;
  /** 不给 = 只出确认单，一行都不写；给了且对得上 = 执行 */
  confirmToken?: unknown;
  /** 注入时钟（判据用）；不给取当前时刻 */
  now?: Date;
}

/**
 * 删除一个案件。**幂等**：已经删过的再删一次照样成功，already_deleted=true，
 * 首次删除时刻与到期时刻都不变（否则每重试一次保留期就往后推 30 天）。
 *
 * 归属：按「连存在性都不承认」办（同 lib/cases.assertOwned）——不是自己的案件与不存在的
 * 案件回同一句话。这里刻意读**含已删行**的那个取数口：读活行的那个会让第二次删除回 404，
 * 而 404 与「删成功了」在客户端那里是两种处置。
 */
export function deleteCase(input: DeleteCaseInput): Result<CaseDeleteConfirm | CaseDeleted> {
  const { db, caseId, userId } = input;
  if (!Number.isInteger(caseId) || caseId <= 0) return NOT_FOUND();
  const row = store.findCaseByIdIncludingDeleted(db, caseId);
  if (!row || row.user_id !== userId) return NOT_FOUND();

  const token = caseDeleteConfirmToken(row);
  const given = typeof input.confirmToken === 'string' ? input.confirmToken.trim() : '';

  if (!given) {
    return {
      ok: true,
      stage: 'confirm',
      case_id: row.id,
      title: row.title,
      confirm_token: token,
      removes: CASE_DELETE_REMOVES,
      keeps: CASE_DELETE_KEEPS,
      retention_days: RETENTION_DAYS,
      note:
        '**本次没有删除任何东西**，这一步只出确认单。' +
        '把 removes 与 keeps 两份清单逐条念给用户听，得到明确同意后，' +
        '带上 confirm_token 再调一次才会执行。' +
        `执行后档案立即从所有页面与接口上消失，${RETENTION_DAYS} 日后由清理任务彻底删除；` +
        '这段时间里删除不可撤销——我们不提供「撤销删除」，请在确认前就说清这一点。',
    };
  }
  if (given !== token) {
    return fail(
      400,
      'INVALID_CONFIRM_TOKEN',
      'confirm_token 与这个案子对不上，本次没有删除任何东西。' +
        '为什么：令牌是按案件身份算出来的，换一个案子、或中间抄漏一位都对不上。' +
        '怎么办：不带 confirm_token 再调一次拿回这个案子的确认单，把里面那串原样传回来。',
    );
  }

  const now = input.now ?? new Date();
  const nowStr = input.now ? toSql(input.now) : nowSql();

  const done = db.transaction(() => {
    const marked = lifecycle.markCaseDeleted(db, row.id, nowStr);
    // 收链接与标删同一个事务：分开写的话，中间崩一下就会留下「档案已经删了、
    // 免登录链接还活着」——而页面上那个案子已经不见了，用户再也找不到入口去收回它。
    const shares = lifecycle.revokeCaseShares(db, row.id, nowStr);
    return { marked, shares };
  })();

  const after = store.findCaseByIdIncludingDeleted(db, row.id);
  const deletedAt = after?.deleted_at ?? nowStr;
  return {
    ok: true,
    stage: 'deleted',
    case_id: row.id,
    deleted_at: deletedAt,
    purge_after: toSql(purgeAfter(done.marked ? now : new Date(`${deletedAt.replace(' ', 'T')}Z`))),
    shares_revoked: done.shares,
    already_deleted: !done.marked,
    removes: CASE_DELETE_REMOVES,
    keeps: CASE_DELETE_KEEPS,
    note: done.marked
      ? `已删除。档案与它的全部内容此刻起在所有页面与接口上都不再出现，${RETENTION_DAYS} 日后彻底删除。` +
        '已经出具过的存证证明与支付记录按 keeps 那份清单保留。删除不可撤销。'
      : '这个案子之前就已经删过了，本次没有改动任何东西（首次删除时刻与到期时刻都不变）。',
  };
}
