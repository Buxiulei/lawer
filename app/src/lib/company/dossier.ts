// app/src/lib/company/dossier.ts
// company_dossiers 的封装：建档、状态机、缓存命中判定、队列位次。
//
// 档案是**公司维度的平台资产**（company_key 唯一，跨案共享），与案件维度的 company_profiles
// 是两件事——见 migrate.ts 那段注释。本文件是 company_key 的唯一消费方，
// 键本身一律由 normalize.companyKey() 产出，**不在这里另算一遍**。
import type { Database } from 'better-sqlite3';

import { readConfigInt } from '../billing/pricing-config';

import { companyKey } from './normalize';

/**
 * 档案状态机。同 intake_stage 裁决：库侧不加 CHECK，值集由本层把关。
 *   queued             已扣费入队，什么都还没跑
 *   graph_done         谱系块已交付（图谱页解锁），文书块还没开始
 *   awaiting_relay     进了人工接力队列，等外勤开窗取证——**这一段的时延不由我们控制**
 *   stats_ready        文书增量已入库、统计已重算
 *   done               全档完成
 *   litigation_expired 超 SLA 未交付文书块，已退文书块的钱；**谱系块不退也不删**
 */
export type DossierStatus =
  | 'queued'
  | 'graph_done'
  | 'awaiting_relay'
  | 'stats_ready'
  | 'done'
  | 'litigation_expired';

export const DOSSIER_STATUSES: readonly DossierStatus[] = [
  'queued',
  'graph_done',
  'awaiting_relay',
  'stats_ready',
  'done',
  'litigation_expired',
];

export interface DossierRow {
  id: number;
  company_key: string;
  name: string;
  uscc: string | null;
  status: string;
  paid_by: string | null;
  paid_ref: string | null;
  charge_ref: string | null;
  graph_refreshed_at: string | null;
  litigation_refreshed_at: string | null;
  ordered_by_user_id: number | null;
  created_at: string;
}

const COLS =
  'id, company_key, name, uscc, status, paid_by, paid_ref, charge_ref, ' +
  'graph_refreshed_at, litigation_refreshed_at, ordered_by_user_id, created_at';

/** 工商快照的默认有效期（天）。表里 `dossier.ttl_graph_days` 有行即以表为准。 */
export const DEFAULT_TTL_GRAPH_DAYS = 30;

export function findDossierByKey(db: Database, key: string): DossierRow | undefined {
  return db.prepare(`SELECT ${COLS} FROM company_dossiers WHERE company_key = ?`).get(key) as
    | DossierRow
    | undefined;
}

export function getDossier(db: Database, id: number): DossierRow | undefined {
  return db.prepare(`SELECT ${COLS} FROM company_dossiers WHERE id = ?`).get(id) as
    | DossierRow
    | undefined;
}

/**
 * 建档（或取回已有的同 key 档案）。**不扣费、不碰账本**——公道值一律经 lib/billing，
 * 本文件一行 gongdao 的 SQL 都不该有。
 *
 * company_key 冲突时返回已有行而不是抛错：档案按公司唯一是设计意图，
 * 第二个买家买的是「增量刷新」，不是第二份档案。
 */
export function createDossier(
  db: Database,
  input: {
    name: string;
    uscc?: string | null;
    orderedByUserId?: number | null;
    /** 'gongdao' 走账本扣费；'membership_credit' 核销权益券 */
    paidBy?: string | null;
    /** membership_credit 时为 entitlements.id——「这单为什么没扣钱」的唯一可查凭据 */
    paidRef?: string | null;
    chargeRef?: string | null;
  },
): DossierRow {
  const key = companyKey({ uscc: input.uscc, name: input.name });
  const existing = findDossierByKey(db, key);
  if (existing) return existing;
  db.prepare(
    `INSERT INTO company_dossiers
       (company_key, name, uscc, status, paid_by, paid_ref, charge_ref, ordered_by_user_id)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
  ).run(
    key,
    input.name,
    input.uscc ?? null,
    input.paidBy ?? null,
    input.paidRef ?? null,
    input.chargeRef ?? null,
    input.orderedByUserId ?? null,
  );
  return findDossierByKey(db, key)!;
}

/** 推进状态。未知值当场抛错：静默落到某个默认档意味着这份档案从此没人推进。 */
export function setStatus(db: Database, id: number, status: DossierStatus): void {
  if (!DOSSIER_STATUSES.includes(status)) {
    throw new Error(
      `未知档案状态 status=${status}：可选 ${DOSSIER_STATUSES.join(' / ')}。` +
        '状态值集由 lib/company 把关（库侧不加 CHECK），写错会让这份档案卡在队列里没人推进。',
    );
  }
  const info = db.prepare('UPDATE company_dossiers SET status = ? WHERE id = ?').run(status, id);
  if (info.changes !== 1) throw new Error(`company_dossiers: id=${id} 查无此行，状态没写进去`);
}

/** 采集时点回填。谱系与文书两条线各自有各自的新鲜度，别共用一个字段。 */
export function markRefreshed(
  db: Database,
  id: number,
  which: 'graph' | 'litigation',
  at: string,
): void {
  const col = which === 'graph' ? 'graph_refreshed_at' : 'litigation_refreshed_at';
  const info = db.prepare(`UPDATE company_dossiers SET ${col} = ? WHERE id = ?`).run(at, id);
  if (info.changes !== 1) throw new Error(`company_dossiers: id=${id} 查无此行，采集时点没写进去`);
}

export type CacheMissReason =
  | '无此档案'
  | '档案未完成'
  | '工商快照已过期'
  | '已入档条目与统计快照对不上';

export interface CacheLookup {
  hit: boolean;
  dossier?: DossierRow;
  /** 未命中时说清为什么——报价页要如实告诉用户「本次为什么按首次价 / 按刷新价」 */
  reason?: CacheMissReason;
}

/**
 * 缓存命中判定：同 company_key、status='done'、且工商快照在 TTL 内。
 *
 * 【第三条判据不是多余的】company_litigation 的行挂在 company_profiles 上、
 * 随案件 ON DELETE CASCADE。档案是跨案资产，而它的判例行的宿主却是案件私有的——
 * 第一个买家把自己的案件删掉，这份档案的判例行会被连带删掉，
 * 而 company_dossier_stats 里那张快照还停在「已入档 N 条」。
 * 此时若照常命中缓存，第二个用户会看到一份**分母还在、行已经没了**的统计。
 * 所以命中前对一次数：对不上就不命中，按重采处理。**这是遮羞布，不是修复**：
 * 真正的修法是让判例行归档案所有（company_profile_id 可空），需要重建表，
 * 卡在「迁移框架无事务」那笔债上——已在交付说明里点名给 manager。
 */
export function lookupCache(
  db: Database,
  input: { uscc?: string | null; name?: string | null },
  opts: { now?: string } = {},
): CacheLookup {
  const key = companyKey(input);
  const d = findDossierByKey(db, key);
  if (!d) return { hit: false, reason: '无此档案' };
  if (d.status !== 'done') return { hit: false, dossier: d, reason: '档案未完成' };

  const ttlDays = readConfigInt(db, 'dossier.ttl_graph_days', DEFAULT_TTL_GRAPH_DAYS);
  const { cutoff } = db
    .prepare("SELECT datetime(COALESCE(?, 'now'), ?) AS cutoff")
    .get(opts.now ?? null, `-${ttlDays} days`) as { cutoff: string };
  if (!d.graph_refreshed_at || d.graph_refreshed_at < cutoff) {
    return { hit: false, dossier: d, reason: '工商快照已过期' };
  }

  const snap = db
    .prepare('SELECT docs_total FROM company_dossier_stats WHERE dossier_id = ?')
    .get(d.id) as { docs_total: number } | undefined;
  if (snap) {
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM company_litigation WHERE dossier_id = ?')
      .get(d.id) as { n: number };
    if (n !== snap.docs_total) {
      return { hit: false, dossier: d, reason: '已入档条目与统计快照对不上' };
    }
  }
  return { hit: true, dossier: d };
}

/**
 * 队列位次（同 status 内按 id 排序，从 1 起）。用户看得见自己排第几——
 * 一个说不出位次的队列，等待时长与「卡住了」在用户那里长得一模一样。
 * 档案不在库里时返回 0（不是 1）：0 表示「没有位次这回事」，不是「排在最前面」。
 */
export function queuePosition(db: Database, id: number): number {
  const d = getDossier(db, id);
  if (!d) return 0;
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM company_dossiers WHERE status = ? AND id <= ?')
    .get(d.status, id) as { n: number };
  return n;
}
