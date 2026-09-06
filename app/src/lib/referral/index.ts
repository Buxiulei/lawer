// app/src/lib/referral/index.ts
// 转介的领域层（设计稿 §14）：同意闸 → 归属校验 → 生成数据包 → 落台账 → 交给队列去发。
//
// 【为什么本函数不负责「发出去」】发送要跨进程、要重试、要在对方挂掉时等着。
// 把它塞进这次调用的形态是：用户点了「同意并转介」，对面正好在重启，于是他看到一句失败——
// 而他的同意已经给过了，数据包也已经生成好了，只差发出去。所以这里只落 pending，
// 发送归 lib/jobs/referral-worker。
//
// 【同意是硬闸，不是参数校验】consent 不为 true 一律 CONSENT_REQUIRED，且**零写入**：
// 不落台账、不建包、不碰对方。写了一半再报错的形态是，库里留下一条没有同意的转介记录。
import type { Database } from 'better-sqlite3';

import { getCase, type DomainFailure, type Result } from '@/lib/cases';
import * as store from '@/lib/db/referrals';
import { nowSql } from '@/lib/db/time';

import { buildPacket, cryptoReady, type ReferralPacket, type SummaryLlm } from './packet';

export { REFERRAL_CONSENT_ITEMS, REFERRAL_NOT_SHARED, consentScript } from './consent';
export type { ReferralPacket } from './packet';

/** needs 的两条上限：条数与单条长度。防的是把整篇聊天记录塞进「需求」那一栏。 */
const MAX_NEEDS = 8;
const MAX_NEED_CHARS = 50;
const MAX_REASON_CHARS = 200;

function fail(status: number, errorCode: string, message: string): DomainFailure {
  return { ok: false, status, errorCode, message };
}

function isFailure(value: unknown): value is DomainFailure {
  return typeof value === 'object' && value !== null && (value as DomainFailure).ok === false;
}

/** 只留非空字符串，逐条截长，最多 MAX_NEEDS 条。不是数组就当没给。 */
export function normalizeNeeds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    .map((n) => n.trim().slice(0, MAX_NEED_CHARS))
    .slice(0, MAX_NEEDS);
}

export interface CreateReferralInput {
  caseId: number;
  userId: number;
  reason: unknown;
  needs: unknown;
  consent: unknown;
  /** 生成摘要的模型；不传即用按记录统计的兜底摘要（判据里注入假模型） */
  llm?: SummaryLlm | null;
}

export interface CreateReferralOutput {
  ok: true;
  referral_id: number;
  status: store.ReferralStatus;
  /** 落库的那份数据包（手机号是掩码；明文只在发送那一刻补进去） */
  packet: ReferralPacket;
}

/**
 * 缺同意时的那一条失败。**单独导出**：工具壳要在幂等外壳之前先判一次同意
 * （没同意就不该在写入台账里留下任何痕迹），两处必须是同一句话。
 */
export function consentFailure(): DomainFailure {
  return fail(
    400,
    'CONSENT_REQUIRED',
    '这次转介没有发出去：缺少用户的明示同意（consent 必须为 true）。' +
      '为什么：转介会把姓名、手机号与一段情绪状态摘要发给站外机构，这一步必须由本人点头。' +
      '怎么办：先把「会传什么、不会传什么」逐项念给用户听（工具说明里那段同意文案），' +
      '得到明确同意后再带 consent:true 调一次；不要替用户默认同意。',
  );
}

/** prepare 的产物：**还没有落库**，只是一份准备好的数据包与它的上下文。 */
export interface PreparedReferral {
  ok: true;
  caseId: number;
  userId: number;
  consentAt: string;
  packet: ReferralPacket;
}

/**
 * 建包（只读，异步）。**不写库**——写在 commitReferral，那一步是同步的，
 * 好让它整个装进幂等外壳的事务里。
 *
 * 【为什么同意闸排在归属校验前面】没给同意就不该有任何一次按 case_id 的探测——
 * 先查归属再判同意的形态是：拿别人的 case_id 试，靠 CASE_NOT_FOUND 与 CONSENT_REQUIRED
 * 的差别数出哪些案件号存在。同意在前，两种情形回的都是同一句话。
 */
export async function prepareReferral(
  db: Database,
  input: CreateReferralInput,
): Promise<PreparedReferral | DomainFailure> {
  if (input.consent !== true) return consentFailure();

  const found = getCase(db, { caseId: input.caseId, userId: input.userId, timelineLimit: 1 });
  if (isFailure(found)) return found;

  if (!cryptoReady()) {
    return fail(
      500,
      'REFERRAL_UNAVAILABLE',
      '这会儿生成不了转介数据包，是我们这边的配置问题，不是你填的内容有误。' +
        '为什么：本机没有配置字段加密主密钥，手机号与姓名解不开，也算不出来源案件哈希。' +
        '怎么办：请运维补上 LAWER_DATA_KEY 后重试；在那之前不会有任何资料外发。',
    );
  }

  const consentAt = nowSql();
  const packet = await buildPacket(db, {
    caseId: input.caseId,
    userId: input.userId,
    stage: found.case.stage,
    reason: typeof input.reason === 'string' ? input.reason.trim().slice(0, MAX_REASON_CHARS) : '',
    needs: normalizeNeeds(input.needs),
    consentAt,
    llm: input.llm ?? null,
  });
  return { ok: true, caseId: input.caseId, userId: input.userId, consentAt, packet };
}

/** 落台账（同步，可装进事务）。status 恒为 pending：发送归 lib/jobs/referral-worker。 */
export function commitReferral(db: Database, prepared: PreparedReferral): CreateReferralOutput {
  const id = store.insertReferral(db, {
    caseId: prepared.caseId,
    userId: prepared.userId,
    payloadJson: JSON.stringify(prepared.packet),
    consentAt: prepared.consentAt,
  });
  return { ok: true, referral_id: id, status: 'pending', packet: prepared.packet };
}

/** 建一条转介（prepare + commit）。回 `{ referral_id, status }`，status 恒为 pending。 */
export async function createReferral(
  db: Database,
  input: CreateReferralInput,
): Promise<Result<Omit<CreateReferralOutput, 'ok'>>> {
  const prepared = await prepareReferral(db, input);
  if (isFailure(prepared)) return prepared;
  return commitReferral(db, prepared);
}

/** 对外的一条台账（不含数据包全文：那份里有姓名，读列表的地方不需要它）。 */
export interface ReferralSummary {
  referral_id: number;
  case_id: number;
  status: string;
  external_ref: string | null;
  attempts: number;
  last_error: string | null;
  consent_at: string;
  created_at: string;
  updated_at: string;
}

function toSummary(row: store.ReferralRow): ReferralSummary {
  return {
    referral_id: row.id,
    case_id: row.case_id,
    status: row.status,
    external_ref: row.external_ref,
    attempts: row.attempts,
    last_error: row.last_error,
    consent_at: row.consent_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 某案的转介台账。归属校验走 getCase，与其余按 case_id 的读写同一道闸。 */
export function listReferrals(
  db: Database,
  input: { caseId: number; userId: number },
): Result<{ referrals: ReferralSummary[] }> {
  const found = getCase(db, { caseId: input.caseId, userId: input.userId, timelineLimit: 1 });
  if (isFailure(found)) return found;
  return { ok: true, referrals: store.listReferralsByCase(db, input.caseId).map(toSummary) };
}

/** 某人名下全部转介台账（设置页那张卡按它判「有没有记录」）。 */
export function listUserReferrals(db: Database, userId: number): ReferralSummary[] {
  return store.listReferralsByUser(db, userId).map(toSummary);
}
