// app/src/lib/referral/packet.ts
// 转介数据包的服务端生成（设计稿 §14 决定 4）。
//
// 【一句话】把「这个人现在怎么样」整理成一份对方接得住的东西，
// 而**不把他的事情**一起送出去。这两件事的边界就是本文件全部的难点。
//
// 【落库的那份不含手机明文】数据包整份进 referrals.payload_json，而库里不得有手机明文
// （spec §10）。所以包里恒是 `phone_masked`；真正的手机号在**发送那一刻**由发送方
// 从 users.phone_enc 解出来补进去（见 withPlainPhone），不经过磁盘。
// 反过来做的形态是：包里存明文、发送时再脱敏——那样库里已经躺着一份明文了。
import type { Database } from 'better-sqlite3';

import { CRISIS_CARD_MARKER } from '@/lib/agent/crisis';
import { maskPhone } from '@/lib/auth/phone';
import { decryptField, hashLookup, masterKeyConfigured } from '@/lib/crypto';
import { listCaseMessages } from '@/lib/db/agent';
import * as realnameStore from '@/lib/db/realname';

import { clampSummary, companyTerms, sanitizeNeutral } from './neutral';

/** 对方 leads 里记的来源渠道（设计稿 §14：channel=tubashu）。 */
export const REFERRAL_CHANNEL = 'tubashu';

/** 近 30 天：情绪记录的取数窗口。 */
const EMOTION_WINDOW_DAYS = 30;
/** 近 72 小时：紧迫度的取数窗口。 */
const CRISIS_WINDOW_HOURS = 72;
/** 拿最近多少条对话去让模型总结。太多没用——摘要只有 200 字。 */
const MESSAGE_WINDOW = 20;

export interface ReferralIdentity {
  real_name: string | null;
  /** 落库恒为掩码；发送时另加 phone 明文（见 withPlainPhone） */
  phone_masked: string | null;
  /** 本站的 users.auth_status */
  realname_status: string;
  /** 实名是在哪一侧完成的：cloudauth / passport / nbdpsy；从没认证过为 null */
  realname_source: string | null;
}

export interface ReferralPacket {
  source_system: typeof REFERRAL_CHANNEL;
  identity: ReferralIdentity;
  /** ≤200 字，已过中立化过滤 */
  emotion_summary: string;
  /**
   * 这次过滤挡下了几个词。**只记个数，不记是哪几个**。
   *
   * 【为什么不记词】本结构整份就是发出去的那份（payload_json 即请求体）。
   * 把被挡的词列出来，等于在同一份数据里附上一张「我们本来要说但没说的东西」清单——
   * 公司全名会原样躺在那里，而过滤器报告自己工作正常。2026-09-06 判据实测撞到过。
   */
  emotion_summary_redactions: number;
  /** 用户为什么想转介，一句话（同样过中立化过滤：这里最容易被写成一段案情） */
  referral_reason: string;
  needs: string[];
  /** 一句话说他办到哪一步了，不含任何细节 */
  stage_sentence: string;
  urgency: { crisis_recent: boolean; crisis_hits_72h: number };
  consent_at: string;
  /** 由案件编号 HMAC 而来，**反查不出案情**；两边对账用 */
  source_case_hash: string;
}

/** 生成摘要的模型。与 lib/evidence 的 BriefLlm 同形（都只要一个 chatJSON）。 */
export interface SummaryLlm {
  chatJSON(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): Promise<string>;
}

const SUMMARY_SYSTEM =
  '你在为一次心理咨询转介写一段【情绪状态摘要】，读它的人是心理咨询师。\n' +
  '只写这个人的状态：情绪起伏、睡眠、精力、自我评价、社会支持、有没有求助意愿。\n' +
  '**严禁**写出任何单位名称、事件经过、金额、纠纷与流程细节——咨询师不需要这些，也无权得到。\n' +
  '不超过 200 字，一段话，不要分点，不要下诊断结论。\n' +
  '只输出 JSON：{"summary":"……"}';

interface EmotionRow {
  level: string;
  note: string | null;
  created_at: string;
}

function recentEmotions(db: Database, caseId: number): EmotionRow[] {
  return db
    .prepare(
      `SELECT level, note, created_at FROM emotion_log
        WHERE case_id = ? AND datetime(created_at) >= datetime('now', ?)
        ORDER BY id`,
    )
    .all(caseId, `-${EMOTION_WINDOW_DAYS} days`) as EmotionRow[];
}

/**
 * 近 72 小时的危机命中数。
 *
 * 【为什么数的是时间线里那条留痕，不是另起一张表】危机响应发生时唯一落库的痕迹
 * 就是这条 `系统动作` 事件（lib/db/agent.recordCrisisCardGiven）。再建一张 crisis_hits
 * 表的形态是：两处各记各的，某天有人改了危机那条路径只改了其中一处，
 * 而转介包里的紧迫度会**永远显示 0**，看起来完全正常。
 */
export function crisisHits72h(db: Database, caseId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM timeline_events
        WHERE case_id = ? AND title = ? AND datetime(happened_at) >= datetime('now', ?)`,
    )
    .get(caseId, CRISIS_CARD_MARKER, `-${CRISIS_WINDOW_HOURS} hours`) as { n: number };
  return row.n;
}

/** 本案登记过的公司名（含关联主体）。它们是过滤器要拦的第一批词。 */
function companyNames(db: Database, caseId: number): string[] {
  return (
    db.prepare('SELECT name FROM company_profiles WHERE case_id = ?').all(caseId) as {
      name: string;
    }[]
  ).map((r) => r.name);
}

/**
 * 没有模型时的兜底摘要：**只报数，不复述**。
 *
 * 【为什么不是「暂无摘要」】对方拿到一句「暂无」，看起来像这个人没什么状况；
 * 而我们手上明明有「近 30 天 7 条记录、其中 4 条是严重」这种确凿的东西。
 * 这份兜底不好看，但它说的每个字都是真的。
 */
export function fallbackSummary(rows: EmotionRow[]): string {
  if (rows.length === 0) {
    return `近 ${EMOTION_WINDOW_DAYS} 天没有情绪记录；本次转介由本人主动提出，具体状态请当面了解。`;
  }
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.level, (counts.get(r.level) ?? 0) + 1);
  const spread = [...counts.entries()].map(([level, n]) => `${level} ${n} 次`).join('、');
  const last = rows[rows.length - 1];
  return (
    `近 ${EMOTION_WINDOW_DAYS} 天共有 ${rows.length} 条情绪记录：${spread}；` +
    `最近一次记录在 ${last.created_at.slice(0, 10)}，档位为「${last.level}」。` +
    '这段是按记录统计生成的，没有经过复述。'
  );
}

function stripFence(raw: string): string {
  const m = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : raw.trim();
}

/**
 * 让模型写一段摘要；**拿不到、格式不对、写空了都回落到兜底**，绝不抛错。
 * 抛错的形态是：一个已经点了「同意并转介」的人，因为模型这一刻抽风而看到一句报错。
 */
async function draftSummary(
  llm: SummaryLlm | null,
  rows: EmotionRow[],
  recentTalk: string,
): Promise<string> {
  if (!llm) return fallbackSummary(rows);
  const material =
    `【近 ${EMOTION_WINDOW_DAYS} 天的情绪记录】\n` +
    (rows.length
      ? rows.map((r) => `${r.created_at.slice(0, 16)} ${r.level}：${r.note ?? '（无备注）'}`).join('\n')
      : '（没有记录）') +
    `\n\n【最近的对话片段】\n${recentTalk || '（没有对话）'}`;
  try {
    const raw = await llm.chatJSON([
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: material },
    ]);
    const parsed = JSON.parse(stripFence(raw)) as { summary?: unknown };
    const text = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    return text || fallbackSummary(rows);
  } catch {
    return fallbackSummary(rows);
  }
}

export interface BuildPacketInput {
  caseId: number;
  userId: number;
  stage: string;
  reason: string;
  needs: string[];
  consentAt: string;
  llm?: SummaryLlm | null;
}

/**
 * 生成一份数据包。**过滤是最后一道**：模型写完 → 拿本案的公司名 + 案情词表过一遍 →
 * 截到 200 字。顺序反过来（先截后滤）会把露出的公司名留在前 200 字里。
 */
export async function buildPacket(
  db: Database,
  input: BuildPacketInput,
): Promise<ReferralPacket> {
  const emotions = recentEmotions(db, input.caseId);
  const talk = listCaseMessages(db, input.caseId, MESSAGE_WINDOW)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content ?? ''}`)
    .join('\n');

  // 【三段自由文本走同一道过滤】摘要是模型写的，reason 与 needs 是人（或替他说话的
  // agent）写的。人写的那两段更容易带案情——"因为被裁了很焦虑"这种句子几乎必然出现。
  // 只滤摘要的形态是：过滤器每次都报干净，而公司名从 needs 那一栏走了出去。
  const forbidden = companyTerms(companyNames(db, input.caseId));
  const drafted = await draftSummary(input.llm ?? null, emotions, talk);
  const filtered = sanitizeNeutral(drafted, forbidden);
  const reason = sanitizeNeutral(input.reason, forbidden);
  const needs = input.needs.map((n) => sanitizeNeutral(n, forbidden).text);

  const user = db
    .prepare('SELECT phone_enc, real_name_enc, auth_status FROM users WHERE id = ?')
    .get(input.userId) as
    | { phone_enc: string | null; real_name_enc: string | null; auth_status: string }
    | undefined;
  const latest = realnameStore.latestByUser(db, input.userId);

  let phoneMasked: string | null = null;
  if (user?.phone_enc) {
    try {
      phoneMasked = maskPhone(decryptField(user.phone_enc));
    } catch {
      phoneMasked = null; // 解不开就当没有，绝不回落明文
    }
  }
  let realName: string | null = null;
  if (user?.real_name_enc) {
    try {
      realName = decryptField(user.real_name_enc);
    } catch {
      realName = null;
    }
  }

  const hits = crisisHits72h(db, input.caseId);
  return {
    source_system: REFERRAL_CHANNEL,
    identity: {
      real_name: realName,
      phone_masked: phoneMasked,
      realname_status: user?.auth_status ?? '未认证',
      realname_source: latest?.provider ?? null,
    },
    emotion_summary: clampSummary(filtered.text),
    emotion_summary_redactions: new Set([...filtered.redacted, ...reason.redacted]).size,
    referral_reason: clampSummary(reason.text),
    needs,
    stage_sentence: `他的事情目前处在「${input.stage}」这一步。`,
    urgency: { crisis_recent: hits > 0, crisis_hits_72h: hits },
    consent_at: input.consentAt,
    source_case_hash: sourceCaseHash(input.caseId),
  };
}

/**
 * 来源案件哈希：带密钥的 HMAC，**不可反查**。
 *
 * 【为什么不能用 sha256(case_id)】案件号是小整数，几万次哈希就能把全表反推出来——
 * 那不是哈希，是编码。带密钥之后，没有本站密钥的人拿到这一串什么都推不出。
 */
export function sourceCaseHash(caseId: number): string {
  return hashLookup(`referral-case:${caseId}`).slice(0, 32);
}

/** 密钥没配好时连手机号都解不开，这一步该在建包之前拦住。 */
export function cryptoReady(): boolean {
  return masterKeyConfigured();
}

/**
 * 发送前把手机明文补进去（只在内存里）。**落库的那份永远是没有明文的那份。**
 * 解不开就不带这个键——对方按已有的 phone_hash 匹配不上时会当作新线索，
 * 那比发一个空串过去要诚实。
 */
export function withPlainPhone(
  db: Database,
  userId: number,
  packet: ReferralPacket,
): Record<string, unknown> {
  const row = db.prepare('SELECT phone_enc FROM users WHERE id = ?').get(userId) as
    | { phone_enc: string | null }
    | undefined;
  let phone: string | null = null;
  if (row?.phone_enc) {
    try {
      phone = decryptField(row.phone_enc);
    } catch {
      phone = null;
    }
  }
  return {
    ...packet,
    channel: REFERRAL_CHANNEL,
    identity: { ...packet.identity, ...(phone ? { phone } : {}) },
  };
}
