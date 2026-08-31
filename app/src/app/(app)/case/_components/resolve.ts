/**
 * 「打开我的案件」这一步的判断本身，抽成纯函数好逐态验。
 *
 * 判断只有四种输入形态，四种去处各不相同——**关键是它们里没有一种是"看不出所以然就给 demo"**。
 * 原来的病灶正是那一种：全站唯一的去处是 demo，于是有案件的人也被送进演示案件。
 */

import { DEMO_CASE_PATH, type CaseSummary } from '@/app/_ui/currentCase';

export type Outcome =
  /** 本机没有 token */
  | { kind: 'signed-out' }
  /** 接口回来了（cases 可能是空清单） */
  | { kind: 'cases'; cases: CaseSummary[] }
  /** 接口说这个凭据不作数了 */
  | { kind: 'unauthorized' }
  /** 网络断了、后端 5xx 之类：**没查到，不等于没有** */
  | { kind: 'failed' };

export interface Destination {
  /** 要跳的地址；null = 留在原地，让用户看见出了什么事并能重试 */
  href: string | null;
  /** 跳转前后给用户看的一句话 */
  notice: string;
}

/**
 * 名下有多个案件时取哪一个：接口按 id 倒序返回，取第一个即"最新建的那个"。
 * 目前产品只会给每人建一个（lib/cases 的 ensureDefaultCase），这里定死口径是为了
 * 将来真出现第二个案件时，行为是**写下来过的**，而不是碰巧取到了数组头。
 */
export function latestOf(cases: CaseSummary[]): CaseSummary | null {
  return cases.length > 0 ? cases[0] : null;
}

export function destinationFor(outcome: Outcome): Destination {
  switch (outcome.kind) {
    // 未登录的人点「我的案件」应当去登录，不是去看别人的演示案件。
    // demo 只从落地页那个写着「看演示」的入口进——那里用户知道自己在看什么。
    case 'signed-out':
      return { href: '/login', notice: '先登录才能打开你的案件' };

    case 'unauthorized':
      return { href: '/login', notice: '登录状态已失效，请重新验证' };

    case 'cases': {
      const latest = latestOf(outcome.cases);
      if (latest) return { href: `/case/${latest.id}`, notice: '正在打开你的案件…' };
      // 接口明确回了空清单——这时 demo 是唯一还能看的东西，横幅会写明它是演示。
      return { href: DEMO_CASE_PATH, notice: '你名下还没有案件，先看看演示案件长什么样' };
    }

    // 【这一支不许回落到 demo】"查不到"和"确实没有"是两件事。
    // 把没查到当成没有，页面会渲染出一份完全正常的演示案件，用户看不出任何异常——
    // 而他名下明明躺着 20 条时间线。宁可停在这儿说清楚，也不给一个看着正常的错答案。
    case 'failed':
      return { href: null, notice: '没能确认你的案件在哪儿' };
  }
}
