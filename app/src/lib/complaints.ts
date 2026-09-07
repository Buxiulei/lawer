// app/src/lib/complaints.ts
// 投诉、举报与个人信息权利请求的领域层（协议第十二条第 1 款）。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量：这条入口对**每一个**行当的用户都是同一条，
// 而且未建档的人也走得到它（他可能正是为了「你们把我的信息删掉」才来的）。
// ─────────────────────────────────────────────────────
//
// 【对外口径在 lib/complaints-policy.ts】三种类型、两个时限、两道长度闸都在那边，
// 本文件原样再导出一遍供服务端用。分家的理由见那个文件的头注释（表单是客户端件）。
//
// 【为什么不落"到期日期"只落工作日数】3 / 15 个工作日要扣掉法定节假日，
// 而本仓没有节假日表（lib/deadline 只做周末顺延）。算一个日期出来的形态是：
// 页面上印着「2026-10-08 前答复」，看起来权威、精确、可追责——而它是错的。
import type { Database } from 'better-sqlite3';

import crypto from 'node:crypto';

import type { DomainFailure, Result } from '@/lib/cases';
import { decryptField, encryptField } from '@/lib/crypto';
import * as store from '@/lib/db/complaints';
import {
  COMPLAINT_ACK_WORKDAYS,
  COMPLAINT_BODY_MAX,
  COMPLAINT_BODY_MIN,
  COMPLAINT_CONTACT_MAX,
  COMPLAINT_KINDS,
  COMPLAINT_REPLY_WORKDAYS,
  type ComplaintKind,
} from './complaints-policy';

export {
  COMPLAINT_ACK_WORKDAYS,
  COMPLAINT_BODY_MAX,
  COMPLAINT_BODY_MIN,
  COMPLAINT_CONTACT_MAX,
  COMPLAINT_KIND_HINTS,
  COMPLAINT_KINDS,
  COMPLAINT_REPLY_WORKDAYS,
  type ComplaintKind,
} from './complaints-policy';

/**
 * 受理编号。形如 `TB-20260907-K7M2QD`。
 *
 * 【为什么带日期段】用户来问的时候多半只记得「上周三提的那条」。纯随机串的形态是：
 * 他念一串我们也念一串，两边都不知道该翻哪一段时间。
 *
 * 【为什么随机段用这套字母表】去掉了 I/L/O/U 与 0/1，因为这串要**在电话里念、
 * 在邮件里手敲**。留着 0 与 O 的形态是：他念「零」我们记成 O，编号查无此条，
 * 而两边都确信自己没记错。
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_LEN = 6;

export function newReceiptNo(now: Date = new Date()): string {
  const ymd = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('');
  // crypto.randomInt 而不是 Math.random：这串是用户手上唯一的凭据，
  // 可预测的编号意味着别人能猜着去查一条不属于他的投诉（真要防查询还得靠鉴权，
  // 但先别自己造一个可枚举的凭据）。
  let tail = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) tail += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `TB-${ymd}-${tail}`;
}

/** 撞车重试次数。30^6 ≈ 7.29e8 的空间里连撞 5 次，说明出的不是运气问题。 */
const RECEIPT_RETRIES = 5;

function fail(status: number, errorCode: string, message: string): DomainFailure {
  return { ok: false, status, errorCode, message };
}

export interface ComplaintCreated {
  complaint_id: number;
  receipt_no: string;
  kind: ComplaintKind;
  created_at: string;
  /** 受理时限（工作日），随回执一起下发：页面不另写一份 */
  ack_workdays: number;
  /** 答复时限（工作日） */
  reply_workdays: number;
}

/**
 * 登记一条。**编号在这里生成并保证唯一**：撞车就换一串重试，
 * 重试用尽宁可报错也不发一个可能重复的编号出去（见 lib/db/complaints 的文件头）。
 */
export function createComplaint(
  db: Database,
  input: { userId: number | null; kind: string; body: string; contact: string; now?: Date },
): Result<ComplaintCreated> {
  const kind = COMPLAINT_KINDS.find((k) => k === input.kind.trim());
  if (!kind) {
    return fail(
      400,
      'BAD_COMPLAINT_KIND',
      `类型要在这三个里选一个：${COMPLAINT_KINDS.join(' / ')}（收到 ${JSON.stringify(input.kind)}）。` +
        '三类分开是因为后面的处理流程与法定期限不一样，不是分类学洁癖。',
    );
  }

  const body = input.body.trim();
  if (body.length < COMPLAINT_BODY_MIN || body.length > COMPLAINT_BODY_MAX) {
    return fail(
      400,
      'BAD_COMPLAINT_BODY',
      `描述要填 ${COMPLAINT_BODY_MIN}–${COMPLAINT_BODY_MAX} 个字（收到 ${body.length} 个）。` +
        '写清楚发生了什么、你希望我们怎么处理，比只写一句「有问题」更快得到答复。',
    );
  }

  const contact = input.contact.trim();
  if (!contact || contact.length > COMPLAINT_CONTACT_MAX) {
    return fail(
      400,
      'BAD_COMPLAINT_CONTACT',
      `联系方式要填，且不超过 ${COMPLAINT_CONTACT_MAX} 个字。` +
        '没有联系方式我们就只能把答复挂在站内，而你可能不会再登录——' +
        '协议承诺的是「答复处理结果」，不是「把结果放在某处」。',
    );
  }

  const contactEnc = encryptField(contact);
  const now = input.now ?? new Date();
  for (let attempt = 0; attempt < RECEIPT_RETRIES; attempt += 1) {
    const receiptNo = newReceiptNo(now);
    try {
      const id = store.insertComplaint(db, {
        receiptNo,
        userId: input.userId,
        kind,
        body,
        contactEnc,
      });
      const row = store.findComplaintById(db, id);
      return {
        ok: true,
        complaint_id: id,
        receipt_no: receiptNo,
        kind,
        created_at: row?.created_at ?? '',
        ack_workdays: COMPLAINT_ACK_WORKDAYS,
        reply_workdays: COMPLAINT_REPLY_WORKDAYS,
      };
    } catch (err) {
      if (!store.isUniqueViolation(err)) throw err;
      // 撞了：换一串再来。落到循环外面就是"连撞 5 次"，那不再是运气。
    }
  }
  return fail(
    503,
    'RECEIPT_NO_EXHAUSTED',
    `连续 ${RECEIPT_RETRIES} 次生成的受理编号都已被占用，这一条没有登记。` +
      '为什么会这样：编号是日期段 + 6 位随机段，连撞这么多次说明随机源或编号空间出了问题，不是运气。' +
      '怎么办：请把这句话连同时间告诉我们（协议第十二条的邮箱），并稍后重试一次。',
  );
}

/** 一条受理记录的对外形状。**联系方式已解密**，只给本人与后台。 */
export interface ComplaintView {
  complaint_id: number;
  receipt_no: string;
  kind: string;
  body: string;
  contact: string;
  created_at: string;
  /** 提交人的账号 id；null = 账号已注销（记录按法定期限留存，见 migrate.ts） */
  user_id: number | null;
}

/**
 * 解密联系方式。**解不开时不抛、也不假装它是空的**，原样交出一句自述——
 * 抛出去的形态是后台整页 500，一条坏行让人看不到其余全部；
 * 假装空的形态是后台以为这个人没留联系方式，于是那条投诉永远等不到答复。
 */
function readContact(row: store.ComplaintRow): string {
  try {
    return decryptField(row.contact_enc);
  } catch (err) {
    return `〔联系方式解不开：${err instanceof Error ? err.message : String(err)}。` +
      '多半是数据密钥换过而这一行是旧密钥加的，需要人工回溯〕';
  }
}

function toView(row: store.ComplaintRow): ComplaintView {
  return {
    complaint_id: row.id,
    receipt_no: row.receipt_no,
    kind: row.kind,
    body: row.body,
    contact: readContact(row),
    created_at: row.created_at,
    user_id: row.user_id,
  };
}

/** 本人提过的那几条。 */
export function listMyComplaints(db: Database, userId: number): ComplaintView[] {
  return store.listComplaintsByUser(db, userId).map(toView);
}

/** 后台只读列表。 */
export function listAllComplaints(db: Database, limit?: number): ComplaintView[] {
  return store.listAllComplaints(db, limit).map(toView);
}
