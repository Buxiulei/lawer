'use client';

/**
 * 「我正看着的这个案子属于哪个领域」——共用页面取领域包的**唯一入口**。
 *
 * ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
 * 不得出现任何具体领域的字面量。这里只有「怎么问」，问出来的字全在 lib/domains/<key>.ts。
 * 由 app/__tests__/page-domain-guard.test.ts 机检。
 * ─────────────────────────────────────────────────────
 *
 * 【为什么要有这一层，而不是每一页各写一次 fetch】要按领域换文案的共用页有六处
 *（驾驶舱、设置、证据、文书、关系图、解读），它们的取数各不相同、没有一处顺手带着
 * cases.domain。各写一遍的形态是：写 N 次忘 N 次，而忘掉的那一处**照常渲染**、
 * 一个报错都没有——只有那个行当的用户读到的每一句都在讲另一件事。
 *
 * 【为什么按 caseId 缓存】同一次页面加载里几个组件都要问同一个案子的领域。
 * 不缓存的形态是：打开一页发四次同样的请求，而屏幕上看不出任何区别。
 * 缓存只活在这一次页面加载里（模块级变量），刷新即清——它不是持久层，
 * 拿它当"记住了"的形态是：案件领域在别处被改了，这一页还照旧。
 *
 * 【首帧一律"不知道"】服务端渲染阶段没有 effect、也没有 token，问不出领域。
 * 所以这个 hook 首帧恒回空串，由调用方交给 packOf 退回缺省领域（与 IntakeFlow
 * 那一处 `packOf(caseProbe.domain || undefined)` 同一条口径）。代价是第二个领域的
 * 用户会先看到一瞬缺省领域的那句话；把它做成"等问到再渲染"的代价更大——
 * 整页要为这一句话空着，而绝大多数用户是缺省领域、本来就不必等。
 */

import { useEffect, useState } from 'react';

import { apiFetch } from './api';
import { CASE_ID_PATTERN, fetchMyCases } from './currentCase';
import { latestOf } from '@/app/(app)/case/_components/resolve';

/** GET /cases/{id} 回的整行里，这一层只关心这一列。 */
interface CaseDetailResponse {
  case: { domain?: string };
}

/**
 * 这一次页面加载里已经问过的答案。**只存问成了的**：
 * 存失败结果的形态是，一次网络抖动把这一页钉死在缺省领域的文案上，直到刷新。
 */
const answered = new Map<string, string>();
/** 正在问的那一次。同一个 caseId 的第二个调用方接同一个 promise，不再发第二条请求。 */
const asking = new Map<string, Promise<string>>();

/** 问一次「这个案子属于哪个领域」。问不到（未登录、网络断、旧后端没这一列）回空串。 */
async function askCaseDomain(caseId: string): Promise<string> {
  try {
    const detail = await apiFetch<CaseDetailResponse>(`/cases/${caseId}`);
    const domain = detail.case?.domain;
    return typeof domain === 'string' ? domain : '';
  } catch {
    return '';
  }
}

/** 问一次「我名下最新那个案子属于哪个领域」。同上，问不到回空串。 */
async function askMyDomain(): Promise<string> {
  try {
    return latestOf(await fetchMyCases())?.domain ?? '';
  } catch {
    return '';
  }
}

/** 缓存包一层：命中就同步回，没命中就发一次（同一 key 只发一次）。 */
function cached(key: string, ask: () => Promise<string>): string | Promise<string> {
  const hit = answered.get(key);
  if (hit !== undefined) return hit;
  let pending = asking.get(key);
  if (!pending) {
    pending = ask().then((domain) => {
      // 空串不进缓存：它代表"这次没问到"，不是"这个案子没有领域"。
      // 存进去的形态是——网络恢复之后这一页仍旧退回缺省领域，而没有任何一处会重试。
      if (domain) answered.set(key, domain);
      asking.delete(key);
      return domain;
    });
    asking.set(key, pending);
  }
  return pending;
}

function useAskedDomain(key: string | null, ask: () => Promise<string>): string {
  const [domain, setDomain] = useState('');
  useEffect(() => {
    if (key === null) return;
    const got = cached(key, ask);
    if (typeof got === 'string') {
      setDomain(got);
      return;
    }
    let alive = true;
    void got.then((next) => {
      if (alive) setDomain(next);
    });
    return () => {
      alive = false;
    };
    // ask 每次渲染都是新函数，进依赖会把 effect 变成每帧重跑；真正决定问什么的是 key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return domain;
}

/**
 * 这个案件属于哪个领域。**首帧与问不到时都回空串**，调用方交给 packOf 退回缺省领域。
 *
 * 演示案件（id 不是正整数）一个字都不问：演示数据本来就是缺省领域那一套，
 * 去问一次只会换回一条 404，而屏幕上看不出任何区别。
 */
export function useCaseDomain(caseId: string): string {
  const askable = CASE_ID_PATTERN.test(caseId) ? caseId : null;
  return useAskedDomain(askable, () => askCaseDomain(caseId));
}

/**
 * 名下最新那个案件属于哪个领域。给**不在案件路由下**的页面用（设置页）。
 *
 * 名下有多个跨领域的案件时，这里给的是最新那一个——接入话术是"给我的 agent 用的"，
 * 而不是"给某一个案子用的"，它只能有一个答案。这个取法与「我的案件」指向哪一个
 * （currentCase.latestOf）是同一条，不另立第二种口径。
 */
export function useMyDomain(): string {
  return useAskedDomain('#mine', askMyDomain);
}
