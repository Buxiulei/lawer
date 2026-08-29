// app/src/lib/auth/ip-quota.ts
// 发码的 IP 维度限流（OTP 三条限流里的第三条）。
//
// **发码这一桶走库**（ip_quota_events，SQL 在 lib/db/ip-quota.ts）：进程内计数重启即清零、
// 多副本之间互不可见——限流恰好在最需要它的时候（被刷爆、服务频繁重启）失效，
// 且它是未来多实例部署的死结。本文件下半段的 createIpQuota 仍是进程内 Map，
// 只剩公开验证页的复核在用（见 lib/evidence/recheck.ts），那条另行处理。
import type { Database } from 'better-sqlite3';

import { countIpEventsSince, recordIpEvent } from '@/lib/db/ip-quota';
import { toSql } from '@/lib/db/time';

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 单 IP 24h 发码上限。
 *
 * 【为什么是 300，不是原来的 30】30 是照抄 NBDpsy 的家用宽带口径，用在这里是错的：
 * 本产品的用户是**同一家公司刚被裁的一批人**，他们从同一个企业/园区 NAT 出口上来，
 * 对外只有一个 IP。30 意味着这家公司第 31 个人点「获取验证码」就被拒——
 * 而那是拉新漏斗的第一步，被拒的人不会知道是限流，只会以为产品坏了。
 * 300 按「一次集体裁员波及百人级、每人重试两三次」定；灌爆攻击拦不拦得住不靠这个数，
 * 靠的是按手机号/邮箱那两条（60s 冷却 + 10 次/日），它们对每一次发码全额生效。
 */
const MAX_PER_WINDOW = 300;

/**
 * 旧行保留时长。判定窗口是 24h，多留一倍是为了**留出可查的余量**：
 * 有人报「我被限流了」时，24h 窗口外那一截正是判断他是不是真撞了墙的依据。
 * 再久就纯属占地方——这张表一次发码一行，没有回看价值。
 */
const RETENTION_MS = 48 * 60 * 60 * 1000;

/**
 * 记一次发码并判断该 IP 是否还有额度；超限返回 false（且不记这一次）。
 * 计数落库，所以重启不清零、多实例共享同一份真值。
 */
export function checkAndRecordIp(db: Database, ip: string, now: Date = new Date()): boolean {
  const since = toSql(new Date(now.getTime() - WINDOW_MS));
  if (countIpEventsSince(db, ip, since) >= MAX_PER_WINDOW) return false;
  recordIpEvent(db, {
    ip,
    createdAt: toSql(now),
    gcBeforeIso: toSql(new Date(now.getTime() - RETENTION_MS)),
  });
  return true;
}

/** 拒绝时给用户看的话。走三段式：撞到的是什么、为什么会撞到、现在能怎么办。 */
export const IP_QUOTA_MESSAGE =
  `当前网络今日的验证码请求已达上限（同一出口 IP 24 小时内 ${MAX_PER_WINDOW} 次）。` +
  '公司或园区里的人共用一个出口 IP，人多时会一起算到这个数上。' +
  '可以换用手机流量后重试；已经注册过的账号登录不受这条限制。';

export interface IpQuota {
  /**
   * 记一次调用并判断该 IP 是否还有额度。
   * 超限返回 false（且不记这一次）；未超限记录时间戳后返回 true。
   */
  checkAndRecord(ip: string, now?: Date): boolean;
  /** 仅供单测隔离用例使用 */
  reset(): void;
}

/**
 * 造一个独立计数器（进程内 Map，重启即清零；现仅剩 lib/evidence/recheck.ts 在用）。
 * 每个用途一个实例，**计数不共享**——
 * 公开验证页的复核请求不该消耗登录用户的发码额度，反之亦然。
 */
export function createIpQuota(maxPerWindow: number, windowMs: number = WINDOW_MS): IpQuota {
  const hits = new Map<string, number[]>();
  return {
    checkAndRecord(ip: string, now: Date = new Date()): boolean {
      const cutoff = now.getTime() - windowMs;
      const kept = (hits.get(ip) ?? []).filter((t) => t > cutoff);
      if (kept.length >= maxPerWindow) {
        hits.set(ip, kept);
        return false;
      }
      kept.push(now.getTime());
      hits.set(ip, kept);
      return true;
    },
    reset(): void {
      hits.clear();
    },
  };
}

/**
 * 从请求头取客户端 IP（Caddy 反代会带 X-Real-IP / X-Forwarded-For）。
 * 取不到统一记 "unknown"，此时 IP 限流退化成全局桶，手机号维度的限流仍然有效。
 */
export function extractClientIp(headers: Headers): string {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return 'unknown';
}
