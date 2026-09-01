'use client';

/**
 * 对话页顶上那条「当前阶段与最近期限」的数据层。
 *
 * 【立这一层的由头】那条提要此前恒读 `demoCase.stage` 与 `demoDeadlines`，
 * 真实案件靠外面一句 `seeded &&` 整条藏起来——于是真实用户在自己案子里从来看不到
 * 自己走到哪一步、最近哪天到期，而库里两样都有。藏起来不是对的，读演示值更不是。
 *
 * 接口形状取自同仓路由实现，一个新端点都没加：
 *   GET /api/v1/cases/{id}?timeline_limit=1   阶段（case.stage）
 *   GET /api/v1/cases/{id}/deadlines          期限（默认只回未了结的）
 */

import { demoCase, demoDeadlines } from '@/app/_mock/demo';
import { apiFetch } from '@/app/_ui/api';

export interface CaseStatus {
  /** 取不到就是 null：这一格宁可不出现，也不写一个编的阶段 */
  stage: string | null;
  nearestDueAt: string | null;
}

interface ApiCaseRow {
  id: number;
  title: string;
  stage: string | null;
}

interface ApiDeadlineRow {
  id: number;
  due_at: string;
}

/** 两样都没有就别占这一条：空壳提要比没有提要更让人以为「我的案子是空的」 */
export function hasStatus(status: CaseStatus | null): status is CaseStatus {
  return status !== null && (status.stage !== null || status.nearestDueAt !== null);
}

/**
 * 时间线只取 1 条：这里要的只有 case.stage，档案接口顺带回的时间线一条都用不上，
 * 但接口不带 timeline 就没有 stage，所以取最小的那一档。
 */
export async function fetchCaseStatus(caseId: string): Promise<CaseStatus> {
  const [detail, deadlines] = await Promise.all([
    apiFetch<{ case: ApiCaseRow }>(`/cases/${caseId}?timeline_limit=1`),
    apiFetch<{ deadlines: ApiDeadlineRow[] }>(`/cases/${caseId}/deadlines`),
  ]);
  const nearest = [...deadlines.deadlines].sort((a, b) => a.due_at.localeCompare(b.due_at))[0];
  const stage = typeof detail.case.stage === 'string' ? detail.case.stage.trim() : '';
  return { stage: stage === '' ? null : stage, nearestDueAt: nearest?.due_at ?? null };
}

/** 演示案件走这条，一次网络请求都不发 */
export function demoCaseStatus(): CaseStatus {
  const nearest = [...demoDeadlines].sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
  return { stage: demoCase.stage, nearestDueAt: nearest?.dueAt ?? null };
}
