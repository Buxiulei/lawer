'use client';

/**
 * 「我的案件」是哪一个、点它该去哪儿——全站唯一的答案在这里。
 *
 * 【立这个模块的由头（P0）】此前"我的案件在哪"在三处各写了一遍，且三处**各自**
 * 硬编码成 demo 或登录页：
 *   ① 落地页的已登录跳转脚本    → location.replace('/case/demo')
 *   ② AppShell 的 caseIdFrom()  → 任何非案件页都回 'demo'
 *   ③ 演示横幅那条「回到我的案件」→ /login
 * 于是产品唯一的真实用户（名下有案件、20 条时间线）刷新一次首页就落进演示案件，
 * 再点「回到我的案件」被送到登录页。两件事在他眼里是同一句话：「我的登录没了」。
 *
 * 独立写三次就会忘三次——这不是疏忽，是默认形态。所以收成一个入口：
 * 想知道去哪儿的人调 myCaseHref，谁都不再自己拼 `/case/...`。
 * 新写的第四处由 __tests__/currentCase.test.ts 的结构守卫点名。
 */

import { useEffect } from 'react';
import { CASE_ID_STORAGE_KEY, CASE_RESOLVER_PATH } from './bootstrap';
import { apiFetch } from './api';
import { useAuthToken } from './auth';

export { CASE_ID_STORAGE_KEY, CASE_RESOLVER_PATH };

/** 没有案件的登录用户唯一还能看的东西。只有接口明确回了空清单才允许来这儿。 */
export const DEMO_CASE_PATH = '/case/demo';

export interface CaseSummary {
  id: number;
  title: string;
}

interface CasesResponse {
  cases: { id: number; title: string }[];
}

/**
 * 「我的案件」的去处。三态各有各的答案，**没有一态是"先给你看 demo"**：
 *   未登录            → 登录页。demo 只从落地页那个明确的「看演示」入口进。
 *   已登录、已解析     → 名下最新那个案件
 *   已登录、还没解析出 → 解析页，它现查接口再定夺（含"名下确实没有案件"那一支）
 */
export function myCaseHref(input: { signedIn: boolean; caseId: number | null }): string {
  if (!input.signedIn) return '/login';
  return input.caseId === null ? CASE_RESOLVER_PATH : `/case/${input.caseId}`;
}

/** 真实案件 id 的字面形状（后端是 SQLite 自增主键）。 */
export const CASE_ID_PATTERN = /^[1-9][0-9]*$/;

/**
 * 缓存里那个 id。只认正整数：脏值当作没有，让调用方老老实实去解析页现查，
 * 而不是拿着一个 404 的地址把用户领过去。
 * 隐私模式下 localStorage 不可读，与"没缓存"同义（与 _ui/auth 的 readToken 一致）。
 */
export function readCachedCaseId(): number | null {
  try {
    const raw = localStorage.getItem(CASE_ID_STORAGE_KEY);
    return raw !== null && CASE_ID_PATTERN.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

export function writeCachedCaseId(caseId: number): void {
  try {
    localStorage.setItem(CASE_ID_STORAGE_KEY, String(caseId));
  } catch {
    // 存不下不影响本次会话：解析页每次都能现查，缓存只是省一次往返
  }
}

/** 退出登录时由 _ui/auth 的 clearToken 调用——上一个人的案件 id 不该留给下一个人。 */
export function clearCachedCaseId(): void {
  try {
    localStorage.removeItem(CASE_ID_STORAGE_KEY);
  } catch {
    // 同上
  }
}

/** 名下案件清单，新的在前（后端 ORDER BY id DESC）。 */
export async function fetchMyCases(): Promise<CaseSummary[]> {
  const res = await apiFetch<CasesResponse>('/cases');
  return res.cases.map((c) => ({ id: c.id, title: c.title }));
}

/**
 * 当前该把「我的案件」指向哪儿。
 *
 * 这个 hook **不发请求**：壳层每次路由切换都会重渲染，让它顺手拉一次接口
 * 等于给每次点击加一次往返。真正的解析在 CASE_RESOLVER_PATH 那一页做，
 * 这里只读缓存——缓存没有就回 null，链接指向解析页，由那一页去查。
 *
 * 注意首帧：服务端渲染阶段读不到 localStorage，恒为「未登录 + 无缓存」。
 * 水合后自然纠正，所以别拿它做不可逆的跳转（与 useAuthToken 同一条约束）。
 */
export function useMyCaseHref(): string {
  const signedIn = useAuthToken() !== null;
  return myCaseHref({ signedIn, caseId: signedIn ? readCachedCaseId() : null });
}

/**
 * 当前案件 id：路径里有就以路径为准（那才是用户正看着的那一份），
 * 否则用缓存里名下的那个。两个都没有回 null——**不回 demo**。
 */
export function useCurrentCaseId(pathname: string): string | null {
  const signedIn = useAuthToken() !== null;
  const fromPath = caseIdFromPath(pathname);
  const cached = signedIn && fromPath === null ? readCachedCaseId() : null;

  // 正看着自己的案件时把它记下来，下次首屏就不必再经解析页。
  // demo 不满足 CASE_ID_PATTERN，所以看演示不会污染缓存——这一条是有意的。
  useEffect(() => {
    if (signedIn && fromPath !== null && CASE_ID_PATTERN.test(fromPath)) {
      writeCachedCaseId(Number(fromPath));
    }
  }, [signedIn, fromPath]);

  return fromPath ?? (cached === null ? null : String(cached));
}

/** 路径里的案件 id，非案件页回 null。这里**没有兜底值**——问错了地方就该回"不知道"。 */
export function caseIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/case\/([^/]+)/);
  return m ? m[1] : null;
}
