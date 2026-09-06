// app/src/lib/company/watch.ts
// 守望盯梢的建/查（spec v3 §2.1 M3「每个节点可一键加入守望」的后端原语）。
// 「一键加守望」= 从谱系图某个节点一点，就把这家主体挂进 company_watches——
// 本文件提供那一点背后要做的事，按钮/图谱 UI 在别处。
//
// 计费不在这里：建盯梢只落一行盯梢记录（tier 决定它日后按哪档收费），
// 真正扣费在 lib/company/watch-billing 的月度巡检里走 lib/billing.gongdaoSettle。
import type Database from 'better-sqlite3';

import { WATCH_TIER_GONGDAO, type WatchTier } from '../billing/pricing';
import * as cases from '../cases';

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

// ───────────────────────────── 一键加守望的统一入口 ─────────────────────────────
// 下面这层是**网页那条 HTTP 口与用户 agent 那条工具共用的入口**：归属校验、档位校验、
// 回读真实生效的档位，三件事只写这一处。各写一份的形态是：某天有人在其中一处放宽了半条
// （比如未知档静默回落成每日档），两条路径就开始各自演化，而两边看起来都完全正常。

/** 一次「加守望」的结果。tier 是**库里真正生效的那一档**，不是请求里那个。 */
export interface SetWatchView {
  id: number;
  /** false = 连点去重命中已有那条（不是失败），且**没有改它的档位** */
  created: boolean;
  tier: WatchTier;
  monthly_gongdao: number;
  note: string;
}

export interface SetWatchFailure {
  ok: false;
  status: number;
  errorCode: string;
  message: string;
}

const CREATED_NOTE =
  '已挂上守望。**这一次没有扣钱**：档位定的是下个月起按哪一档收月费，别说成「已扣」。';
const DEDUPED_NOTE =
  '这个主体本案已经在盯了，本次没有新建、也没有改动它的档位（改档是另一个显式动作）。' +
  '回包里的 tier 是它当前真正生效的那一档。';

/**
 * 未知档一律报错，**不静默回落**：回落会让用户以为自己挑了不收费那档，下个月却按最贵那档收。
 * @returns 合法档；raw 省略/为 null 时给缺省档；认不出的值返回 null（调用方报 400）。
 */
export function parseWatchTier(raw: unknown): WatchTier | null {
  if (raw === undefined || raw === null) return 'daily';
  return typeof raw === 'string' && raw in WATCH_TIER_GONGDAO ? (raw as WatchTier) : null;
}

export function setWatch(
  db: Database.Database,
  input: {
    caseId: number;
    userId: number;
    name: string;
    uscc?: string | null;
    companyProfileId?: number | null;
    tier: WatchTier;
  },
): ({ ok: true } & { watch: SetWatchView }) | SetWatchFailure {
  // 归属校验走 lib/cases 的既有入口：「非本人案件一律当作不存在」是条红线，不复制第二份。
  const owned = cases.getCase(db, { caseId: input.caseId, userId: input.userId, timelineLimit: 1 });
  if (!owned.ok) {
    return { ok: false, status: owned.status, errorCode: owned.errorCode, message: owned.message };
  }

  const name = input.name.trim();
  if (!name) {
    return {
      ok: false,
      status: 400,
      errorCode: 'WATCH_NAME_EMPTY',
      message:
        '要盯的主体名字是空的：盯梢按「案件 + 主体」去重，没有名字就去不了重，' +
        '同一家会被重复建、下个月重复收费。请带上这家的全称。',
    };
  }

  const result = addWatch(db, {
    caseId: input.caseId,
    name,
    uscc: input.uscc ?? null,
    companyProfileId: input.companyProfileId ?? null,
    tier: input.tier,
  });

  // 去重命中时 addWatch **不改已有那条的 tier**，所以回给调用方的档位必须读库里那一行，
  // 不能回显请求里的 tier：那会让页面显示「已按每周档盯着」而库里其实是每日档，
  // 用户下个月收到的是另一个数字，而且页面与账单各自看着都对。
  const row = db.prepare('SELECT tier FROM company_watches WHERE id=?').get(result.id) as
    | { tier: string }
    | undefined;
  const effectiveTier = (row?.tier ?? input.tier) as WatchTier;

  return {
    ok: true,
    watch: {
      id: result.id,
      created: result.created,
      tier: effectiveTier,
      monthly_gongdao: WATCH_TIER_GONGDAO[effectiveTier] ?? 0,
      note: result.created ? CREATED_NOTE : DEDUPED_NOTE,
    },
  };
}
