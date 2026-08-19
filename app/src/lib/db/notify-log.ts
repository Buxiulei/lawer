// app/src/lib/db/notify-log.ts
// notify_log 表的封装（spec §6：lib/db 是唯一 SQL 层）。表结构见 migrate.ts。
//
// 本文件是通知幂等闸门的**唯一正确用法**——发送方不要自己拼 INSERT。
// 语义靠 uq_notify_sent（(scene, biz_key, channel) WHERE status='sent' 部分唯一索引）落地：
//   · tryMarkSent 拿到 false = 这个通道对这个业务键已经成功发过，调用方不得重发；
//   · 部分索引只盖 sent，故 failed/skipped 可重复落行（每次重试都留痕）；
//   · 也因此"短信成功"不会挡住"邮件失败后重试"——每通道各自独立判定。
//     NBDpsy 教训：一条通道成功掩盖另一条通道的失败，等于用户以为收到了其实没有。
//
// 先占位再发送：tryMarkSent 必须在真正调用三方之前跑，返回 true 才发。倒过来（先发后记）
// 一旦记录那步失败，下一轮重试会再发一遍——期限提醒重复轰炸就是这么来的。
// detail 对 failed 是必填且必须是三方返回的原文，"发送失败"四个字等于没写，本层直接抛错拦住。
import type { Database } from 'better-sqlite3';

export interface NotifyLogRow {
  id: number;
  scene: string;
  biz_key: string;
  channel: string;
  status: string;
  detail: string | null;
  created_at: string;
}

/** logAttempt 只收这两种；成功一律走 tryMarkSent，不从这里写 sent。 */
export type AttemptStatus = 'failed' | 'skipped';

/**
 * 抢占"这个通道这个业务键的成功位"。返回 true 才可以发；false = 已经发过，直接跳过。
 * 走 INSERT OR IGNORE + changes 守卫：唯一索引冲突不抛错，只是不落行。
 */
export function tryMarkSent(
  db: Database,
  params: { scene: string; bizKey: string; channel: string; detail?: string | null },
): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO notify_log (scene, biz_key, channel, status, detail)
       VALUES (?, ?, ?, 'sent', ?)`,
    )
    .run(params.scene, params.bizKey, params.channel, params.detail ?? null);
  return info.changes > 0;
}

/**
 * 记一次没发成的尝试。failed 必须带三方返回的错误原文——detail 为空直接抛错，
 * 这是把 migrate.ts 那句「禁止只写发送失败」硬化成代码：留痕留不出原因等于没留。
 */
export function logAttempt(
  db: Database,
  params: {
    scene: string;
    bizKey: string;
    channel: string;
    status: AttemptStatus;
    /** failed 时为三方返回的错误码与文案原文，不得为空 */
    detail: string;
  },
): number {
  if (params.status === 'failed' && !params.detail?.trim()) {
    throw new Error('notify_log: failed 必须写明失败原因原文（三方返回的错误码与文案）');
  }
  const info = db
    .prepare(
      'INSERT INTO notify_log (scene, biz_key, channel, status, detail) VALUES (?, ?, ?, ?, ?)',
    )
    .run(params.scene, params.bizKey, params.channel, params.status, params.detail);
  return Number(info.lastInsertRowid);
}

/** 只查不占位（对账/展示用）。发送前的判定请用 tryMarkSent，别用这个再自己插——中间有竞态。 */
export function wasSent(db: Database, scene: string, bizKey: string, channel: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS hit FROM notify_log WHERE scene = ? AND biz_key = ? AND channel = ? AND status = 'sent'",
    )
    .get(scene, bizKey, channel) as { hit: number } | undefined;
  return row !== undefined;
}
