// app/src/lib/company/probe.ts
// 免费前置探测（§2.3）：**扣费之前**免费返回四个数字 + 一行工商状态，把「必定有货」
// 从承诺变成扣费前可验证的事实。
//
// ─────────────── 这个文件的四条形态约束（别按别的形态设计）───────────────
// 【零 LLM】纯归一 + 缓存读 + 计数。本文件没有 llm 注入点，也不 import 任何模型——
//   四个数字是采集侧数出来的客观计数，不是模型生成的。这条由 probe.test.ts 结构守卫盯着。
// 【采集在外勤、不在服务器】cache miss 时那句「真去采集侧拉一次」由外勤工作站完成
//   （住宅代理 + 真人过验证码），**app 侧没有「去采集」这个动作**。故 collect 是可注入的、
//   默认缺席；缺席时如实降级，不静默返回空（空会被读成「查无此公司」），也不报错。
// 【限流】登录后每用户每日 dossier.probe_free_per_day(2) 次。配额**只由「真采集一次」消耗**——
//   缓存命中免费、不限次、不占配额（命中的边际成本为 0）。配额耗尽即降级为「仅缓存命中」
//   并如实告知（§2.3-B：把被竞品白嫖公司库的敞口先收窄）。
// 【as_of 是硬门槛】四个数字缺了采集时点就是四个悬浮的数，同 stats 的 as_of 红线：
//   没有 as_of 的载荷不许进缓存，读侧永远不会拿到一份「说不出数据截止到哪天」的探测。
import type { Database } from 'better-sqlite3';

import { readConfigInt } from '../billing/pricing-config';

import { companyKey } from './normalize';

/** 表里 dossier.probe_free_per_day 有行即以表为准；缺行回落此常量。 */
export const DEFAULT_PROBE_FREE_PER_DAY = 2;
/** 缓存有效期（小时）。表里 dossier.probe_ttl_hours 有行即以表为准；缺行回落 24。 */
export const DEFAULT_PROBE_TTL_HOURS = 24;

/**
 * 探测载荷：四个数字 + 工商状态 + 主体命中。**外勤采集侧产出，app 侧只读不算**。
 * 四个计数直接决定每个模块卡的 availability（§6）：
 *   relation_count=0 → M3 置灰；litigation_count=0 → M4 置灰；doc_url_count<5 → M5 置灰。
 */
export interface ProbePayload {
  /** 主体命中与否。未命中时四个计数必须全 0（否则自相矛盾，assertPayload 会拒） */
  entity_matched: boolean;
  /** 命中的规范全名（未命中为 null） */
  entity_name: string | null;
  /** 统一社会信用代码（未命中或采集不到为 null） */
  uscc: string | null;
  /** 工商状态一行：存续 / 经营异常 / 已注销 / 简易注销公告中（明细在 M2） */
  gs_status: string | null;
  /** 关联主体数（明细在 M3） */
  relation_count: number;
  /** 关联主体分解，如 {股权:3, 同法代:1, 同址:1}；可选 */
  relation_breakdown?: Record<string, number>;
  /** 涉诉记录数（明细在 M4） */
  litigation_count: number;
  /** 其中劳动争议数 */
  labor_count: number;
  /** 其中有公开文书链接的篇数（M5 可售性判据：<5 置灰不卖） */
  doc_url_count: number;
  /** 采集时点。**必填**：四个数字没有它就是四个悬浮的数 */
  as_of: string;
}

/**
 * 探测结果的四种状态，**每种都要如实说清**：
 *   hit             缓存命中（TTL 内），0 成本、不占配额，payload 必有
 *   collected       缓存未命中、配额够、采集器在场：真采了一次，占 1 配额，payload 必有
 *   no_collector    缓存未命中、配额够、但采集器未接入：**如实降级**，不是「查无此公司」
 *   quota_exhausted 缓存未命中、今日配额已用完：降级为仅缓存命中并告知，不报错不返回空
 */
export type ProbeStatus = 'hit' | 'collected' | 'no_collector' | 'quota_exhausted';

export interface ProbeResult {
  company_key: string;
  status: ProbeStatus;
  /** fresh=有 TTL 内缓存；none=没有可用缓存（未命中的三种降级态均为 none） */
  cache_state: 'fresh' | 'none';
  /** hit / collected 时必有；降级态没有（没有就是没有，不给一个空壳 payload） */
  payload?: ProbePayload;
  /** 今日剩余免费次数（= 报价页的 probe_quota_left） */
  quota_left: number;
  /** 降级态的人话说明——为什么这次没有数字、下一步能做什么。命中态没有 */
  reason?: string;
}

/** 采集器：给 company_key、拉回一份载荷。prod 由外勤侧注入；app 侧默认缺席。 */
export type ProbeCollector = (key: string) => Promise<ProbePayload>;

/**
 * 载荷体检：把「一份能进缓存的探测」的判据硬化成代码，不靠采集侧自觉。
 * 任一条不过当场抛（自述错误：缺什么/为什么不能收/怎么办），**绝不把可疑载荷写进缓存**——
 * 缓存是全站共享的，一份脏载荷会被 24 小时内所有查这家公司的人读到。
 */
function assertPayload(p: ProbePayload): void {
  const counts: [string, number][] = [
    ['relation_count', p.relation_count],
    ['litigation_count', p.litigation_count],
    ['labor_count', p.labor_count],
    ['doc_url_count', p.doc_url_count],
  ];
  for (const [name, v] of counts) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(
        `探测载荷的 ${name} 不是非负整数（读到 ${JSON.stringify(v)}）：` +
          '这四个数是数出来的客观计数，不该有小数或负数；多半是采集侧字段映射错了，' +
          '请核对外勤输出后重采，本次不写缓存（脏载荷会被 24 小时内所有查这家公司的人读到）。',
      );
    }
  }
  // 包含关系：有文书链接 ⊆ 劳动争议 ⊆ 全部涉诉（§2.3 那三行数字天然是层层子集）。
  if (p.labor_count > p.litigation_count) {
    throw new Error(
      `探测载荷自相矛盾：劳动争议 ${p.labor_count} 条多于涉诉总数 ${p.litigation_count} 条。` +
        '劳动争议是涉诉记录的子集，前者不可能更多；请核对采集侧计数口径。',
    );
  }
  if (p.doc_url_count > p.labor_count) {
    throw new Error(
      `探测载荷自相矛盾：有公开文书链接 ${p.doc_url_count} 篇多于劳动争议 ${p.labor_count} 条。` +
        '文书链接数是劳动争议里「有链接」的那部分，不可能更多；请核对采集侧计数口径。',
    );
  }
  if (!p.as_of || !String(p.as_of).trim()) {
    throw new Error(
      '探测载荷缺 as_of（采集时点）：四个数字没有采集时点就是四个悬浮的数，' +
        '同统计层的 as_of 红线——没有它整条探测不可信，不写缓存。请让采集侧补上采集时点。',
    );
  }
  // 未命中主体却报出关联/涉诉数：这是自相矛盾的载荷，拒收。
  if (!p.entity_matched) {
    const anyNonZero =
      p.relation_count !== 0 ||
      p.litigation_count !== 0 ||
      p.labor_count !== 0 ||
      p.doc_url_count !== 0;
    if (anyNonZero) {
      throw new Error(
        '探测载荷自相矛盾：entity_matched=false（未命中主体）却报出了非零的关联/涉诉计数。' +
          '未命中就意味着没有可归属的记录，四个数应全为 0；请核对采集侧的主体消歧结果。',
      );
    }
  }
}

interface ProbeCacheRead {
  fresh: boolean;
  payload?: ProbePayload;
  fetched_at?: string;
}

/** 读缓存并判 TTL。now 可注入（测试用），缺省走库时钟。 */
export function readProbeCache(
  db: Database,
  key: string,
  opts: { now?: string; ttlHours?: number } = {},
): ProbeCacheRead {
  const row = db
    .prepare('SELECT payload_json, fetched_at FROM company_probe_cache WHERE company_key = ?')
    .get(key) as { payload_json: string; fetched_at: string } | undefined;
  if (!row) return { fresh: false };
  const ttlHours = opts.ttlHours ?? readConfigInt(db, 'dossier.probe_ttl_hours', DEFAULT_PROBE_TTL_HOURS);
  const { cutoff } = db
    .prepare("SELECT datetime(COALESCE(?, 'now'), ?) AS cutoff")
    .get(opts.now ?? null, `-${ttlHours} hours`) as { cutoff: string };
  return {
    fresh: row.fetched_at >= cutoff,
    payload: JSON.parse(row.payload_json) as ProbePayload,
    fetched_at: row.fetched_at,
  };
}

/**
 * 写缓存（采集器路径与外勤导入器共用的唯一写点）。**先体检再落库**——
 * 体检不过直接抛，脏载荷进不了缓存。company_key 冲突即覆盖（新采集覆盖旧的）。
 */
export function upsertProbeCache(
  db: Database,
  key: string,
  payload: ProbePayload,
  opts: { fetchedAt?: string } = {},
): void {
  assertPayload(payload);
  db.prepare(
    `INSERT INTO company_probe_cache (company_key, payload_json, fetched_at)
       VALUES (?, ?, COALESCE(?, datetime('now')))
     ON CONFLICT (company_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       fetched_at   = excluded.fetched_at`,
  ).run(key, JSON.stringify(payload), opts.fetchedAt ?? null);
}

/** 今日该用户已消耗的探测次数（按库时钟的日历日，now 可注入）。 */
export function countProbesToday(db: Database, userId: number, now?: string): number {
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM company_probe_events
        WHERE user_id = ? AND date(created_at) = date(COALESCE(?, 'now'))`,
    )
    .get(userId, now ?? null) as { n: number };
  return n;
}

/** 记一次配额消耗（一次成功的真采集 = 一行）。 */
function recordProbeEvent(db: Database, userId: number, key: string, now?: string): void {
  db.prepare(
    `INSERT INTO company_probe_events (user_id, company_key, created_at)
       VALUES (?, ?, COALESCE(?, datetime('now')))`,
  ).run(userId, key, now ?? null);
}

/**
 * 免费前置探测。
 *
 * @param input.userId 登录用户 id（限流按它，必填——§2.3「登录后每用户每日 2 次」）。
 * @param opts.collect 采集器。**不传即 app 侧默认形态**：cache miss 时如实降级
 *   （no_collector），不静默返回空。prod 由外勤侧注入真采集器。
 *
 * 配额语义：**只有 status='collected'（真采了一次）才占配额**。命中缓存(hit)、降级
 * (no_collector / quota_exhausted) 都不占——降级本来就没采集到东西，不该扣补贴额度。
 */
export async function probeCompany(
  db: Database,
  input: { name?: string | null; uscc?: string | null; userId: number },
  opts: { now?: string; collect?: ProbeCollector } = {},
): Promise<ProbeResult> {
  const key = companyKey({ uscc: input.uscc, name: input.name });
  const perDay = readConfigInt(db, 'dossier.probe_free_per_day', DEFAULT_PROBE_FREE_PER_DAY);
  const ttlHours = readConfigInt(db, 'dossier.probe_ttl_hours', DEFAULT_PROBE_TTL_HOURS);

  const cache = readProbeCache(db, key, { now: opts.now, ttlHours });
  const usedToday = countProbesToday(db, input.userId, opts.now);
  const quotaLeft = Math.max(0, perDay - usedToday);

  // 缓存命中：0 成本、不占配额、不限次。
  if (cache.fresh && cache.payload) {
    return { company_key: key, status: 'hit', cache_state: 'fresh', payload: cache.payload, quota_left: quotaLeft };
  }

  // 以下都是缓存未命中。三条降级路径，每条都如实说清、都不返回空。
  if (quotaLeft <= 0) {
    return {
      company_key: key,
      status: 'quota_exhausted',
      cache_state: 'none',
      quota_left: 0,
      reason:
        `今日免费探测已用完（每日 ${perDay} 次），且这家公司 ${ttlHours} 小时内没有可复用的探测缓存。` +
        '可以明天再试，或直接建档——建档不受探测配额限制。（这不是「查无此公司」，是「今天不再免费采集」。）',
    };
  }

  if (!opts.collect) {
    return {
      company_key: key,
      status: 'no_collector',
      cache_state: 'none',
      quota_left: quotaLeft,
      reason:
        `这家公司 ${ttlHours} 小时内没有探测缓存，需要外勤工作站在线采集一次；本次未接入采集器，` +
        '无法即时出数——**这不是「查无此公司」，是「这一刻没去查」**。稍后缓存到货即可秒出。',
    };
  }

  // 真采集一次（占 1 配额）。体检在 upsertProbeCache 里做，脏载荷进不了缓存也不占配额。
  // fetched_at 记的是**我们这份拷贝的入缓存时刻**（= 探测发生的 now），不是数据的 as_of——
  // TTL 管的是「多久不再去采集侧重拉」，as_of（数据本身有多新）另存在 payload 里给 UI 显示。
  const payload = await opts.collect(key);
  upsertProbeCache(db, key, payload, { fetchedAt: opts.now });
  recordProbeEvent(db, input.userId, key, opts.now);
  return {
    company_key: key,
    status: 'collected',
    cache_state: 'fresh',
    payload,
    quota_left: quotaLeft - 1,
  };
}
