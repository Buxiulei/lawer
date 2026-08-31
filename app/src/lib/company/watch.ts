// app/src/lib/company/watch.ts
// 守望盯梢的建/查（spec v3 §2.1 M3「每个节点可一键加入守望」的后端原语）。
// 「一键加守望」= 从谱系图某个节点一点，就把这家主体挂进 company_watches——
// 本文件提供那一点背后要做的事，按钮/图谱 UI 在别处。
//
// 计费不在这里：建盯梢只落一行盯梢记录（tier 决定它日后按哪档收费），
// 真正扣费在 lib/company/watch-billing 的月度巡检里走 lib/billing.gongdaoSettle。
import type Database from 'better-sqlite3';
import { WATCH_TIER_GONGDAO, type WatchTier } from '../billing/pricing';

/** 一键加守望的入参。tier 缺省进圈1（每日）——「加盯梢」的常态就是要每天盯着。 */
export interface AddWatchInput {
  caseId: number;
  name: string;
  uscc?: string | null;
  companyProfileId?: number | null;
  /** daily=圈1 199 / weekly=圈2 60 / archive=圈3 0。缺省 daily。 */
  tier?: WatchTier;
}

export interface AddWatchResult {
  id: number;
  /** true=本次新建；false=命中已存在的活跃盯梢，原样返回（一键去重，见下） */
  created: boolean;
}

/**
 * 一键加守望：为某案某主体建一条盯梢（若尚无活跃盯梢）。
 *
 * 【为什么去重】「一键」意味着用户可能连点、或对同一个节点反复点。同一案对同一主体只该有一条
 * 活跃盯梢，否则月度计费会对同一家公司重复扣费。去重键取**最具体的可用标识**：
 * 给了 companyProfileId 就按 (case_id, company_profile_id) 去重，否则按 (case_id, name)。
 * 命中已存在的活跃盯梢时**原样返回、不改它的 tier**——改档是另一个显式动作，不该被"再点一次加守望"顺手改掉。
 *
 * 建档默认 billing_status='free'（尚未计过费）、arrears_rounds=0，与迁移列默认一致（显式写出，不靠列默认兜）。
 */
export function addWatch(db: Database.Database, input: AddWatchInput): AddWatchResult {
  const tier: WatchTier = input.tier ?? 'daily';
  if (!(tier in WATCH_TIER_GONGDAO)) {
    throw new Error(`未知守望档 tier=${tier}，可选：${Object.keys(WATCH_TIER_GONGDAO).join('/')}`);
  }

  const existing =
    input.companyProfileId != null
      ? (db
          .prepare(
            "SELECT id FROM company_watches WHERE case_id=? AND company_profile_id=? AND status='active' ORDER BY id LIMIT 1",
          )
          .get(input.caseId, input.companyProfileId) as { id: number } | undefined)
      : (db
          .prepare(
            "SELECT id FROM company_watches WHERE case_id=? AND name=? AND status='active' ORDER BY id LIMIT 1",
          )
          .get(input.caseId, input.name) as { id: number } | undefined);
  if (existing) return { id: existing.id, created: false };

  const info = db
    .prepare(
      `INSERT INTO company_watches
         (case_id, company_profile_id, name, uscc, status, tier, billing_status, arrears_rounds)
       VALUES (?, ?, ?, ?, 'active', ?, 'free', 0)`,
    )
    .run(input.caseId, input.companyProfileId ?? null, input.name, input.uscc ?? null, tier);
  return { id: Number(info.lastInsertRowid), created: true };
}
