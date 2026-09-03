'use client';

/**
 * /welcome 该给哪一屏：取数 + 判定。判定本身是纯的（下面的 welcomeStateFor），
 * 「空 / 非空」那一半更是收在 lib/cases/freshness 的 isFreshCase 里，全站只此一份。
 *
 * 接口一个都没新加，全是既有的：
 *   GET /api/v1/cases                        名下案件清单（新的在前）
 *   GET /api/v1/cases/{id}?timeline_limit=1  案件档案（含首诊四列）+ 时间线有没有
 *   GET /api/v1/cases/{id}/messages          聊过的话
 *   GET /api/v1/cases/{id}/evidence          证据（只有元数据）
 */

import { latestOf } from '@/app/(app)/case/_components/resolve';
import { apiFetch } from '@/app/_ui/api';
import { fetchMyCases } from '@/app/_ui/currentCase';
import { isFreshCase, type CaseSnapshot } from '@/lib/cases/freshness';

export type WelcomeState =
  /** 还在问 */
  | { kind: 'loading' }
  /** 四个维度全空（或名下压根没有案件）：档案刚建好那一屏 */
  | { kind: 'fresh' }
  /** 有东西：欢迎回来，主 CTA 直接进这个案件 */
  | { kind: 'returning'; caseId: number };

/** 后端案件行里这一页要用的那几列（照 lib/db/cases 的 CaseRow，逐字 snake_case） */
interface ApiCaseRow {
  employed_from: string | null;
  monthly_wage_fen: number | null;
  position: string | null;
  contract_count: string | null;
}

export async function fetchCaseSnapshot(caseId: number): Promise<CaseSnapshot> {
  // 时间线只要 1 条：这一页问的是"有没有"，不是"有哪些"
  const [detail, messages, evidence] = await Promise.all([
    apiFetch<{ case: ApiCaseRow; timeline: unknown[] }>(`/cases/${caseId}?timeline_limit=1`),
    apiFetch<{ messages: unknown[] }>(`/cases/${caseId}/messages`),
    apiFetch<{ evidence: unknown[] }>(`/cases/${caseId}/evidence`),
  ]);
  return {
    timelineCount: detail.timeline.length,
    messageCount: messages.messages.length,
    evidenceCount: evidence.evidence.length,
    intake: {
      employedFrom: detail.case.employed_from,
      monthlyWageFen: detail.case.monthly_wage_fen,
      position: detail.case.position,
      contractCount: detail.case.contract_count,
    },
  };
}

/**
 * 拿到（或没拿到）的东西 → 这一屏。
 *
 * 【取不到快照时为什么判「回来了」而不是「新人」】此时我们已经知道**他名下有案件**
 * （案件清单查到了 id），只是四个维度这次没读出来。两个方向的代价不对等：
 * 判成新人 = 对一个有整套记录的人说"你的档案刚建好、去做首诊"，正是 F-201 那句话；
 * 判成老用户 = 主 CTA 把他送进自己的案件，那一页有自己的取数与失败态，会如实说话。
 * 取不准时一律往"别把老用户当新人"那边错。
 */
export function welcomeStateFor(input: {
  caseId: number | null;
  snapshot: CaseSnapshot | null;
}): WelcomeState {
  if (input.caseId === null) return { kind: 'fresh' };
  if (input.snapshot === null) return { kind: 'returning', caseId: input.caseId };
  return isFreshCase(input.snapshot)
    ? { kind: 'fresh' }
    : { kind: 'returning', caseId: input.caseId };
}

/**
 * 这一页要问的全部。
 *
 * 名下清单查不到（网络断了、后端抖了）时**当作没有案件**：那时连个 id 都没有，
 * 「进入我的案件」无处可指。这一支下新人那一屏的 CTA（去首诊）至少不会把人带到 404，
 * 首诊草稿也是本机留着的。——这是这条链上唯一一处只能往"新人"那边错的地方。
 */
export async function loadWelcomeState(): Promise<WelcomeState> {
  let caseId: number | null = null;
  try {
    // 「名下有多个案件时取哪一个」的口径只有一份（resolve.latestOf），不在这儿再定一次
    caseId = latestOf(await fetchMyCases())?.id ?? null;
  } catch {
    return { kind: 'fresh' };
  }
  if (caseId === null) return { kind: 'fresh' };

  let snapshot: CaseSnapshot | null = null;
  try {
    snapshot = await fetchCaseSnapshot(caseId);
  } catch {
    snapshot = null;
  }
  return welcomeStateFor({ caseId, snapshot });
}
