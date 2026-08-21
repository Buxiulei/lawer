// app/src/lib/auth/ip-quota.ts
// 同一 IP 24h 内最多 30 次发码（照抄 NBDpsy auth_sms.rs 的 IP_QUOTA）。
//
// 内存计数，进程重启即清空 —— 这是**兜底**不是主防线：真正的限流是按手机号/邮箱那两条，
// 走库、重启不丢。IP 这条只为挡「单机器换号灌爆」，允许它在重启后放过一批。
// 单进程部署下够用；将来上多副本要么换 Redis 要么把它挪到 Caddy，届时另议。

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;

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
 * 造一个独立计数器。每个用途一个实例，**计数不共享**——
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

/** 发码用的那一桶（OTP 三条限流里的第三条） */
const otpQuota = createIpQuota(MAX_PER_WINDOW);

export function checkAndRecordIp(ip: string, now: Date = new Date()): boolean {
  return otpQuota.checkAndRecord(ip, now);
}

/** 仅供单测隔离用例使用 */
export function resetIpQuota(): void {
  otpQuota.reset();
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
