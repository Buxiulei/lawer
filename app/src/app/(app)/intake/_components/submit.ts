'use client';

/**
 * 首诊最后一步「进入驾驶舱」按下之后到底发生什么——**判断本身抽成纯函数**，
 * 好让每一种结局都能逐条验。
 *
 * 【立这个模块的由头（P0）】按钮此前是这么写的：
 *   toast('档案已建好，正在打开驾驶舱'); router.push('/case/demo');
 * 既没有任何请求，也没有任何案件——用户填完六步，服务器上一个字都没有，
 * 却被告知「档案已建好」，然后落进演示案件。**三件事同时错**：没存、去错地方、还撒了谎。
 *
 * 所以这里定死一条：**「已经存好了」这句话只能出现在拿到 case_id 的那一支**。
 * 失败与没查到案件都不许弹成功提示，也不许清掉本地草稿——草稿是用户此刻唯一还剩的东西。
 */

import { apiFetch, humanError } from '@/app/_ui/api';
import { fetchMyCases } from '@/app/_ui/currentCase';
import { latestOf } from '@/app/(app)/case/_components/resolve';
import type { IntakeDraft } from './draft';

/** 末步按钮按下之后的四种结局，没有一种是「看不出所以然就给 demo」 */
export type FinishOutcome =
  /** 本机没有 token：草稿留着，先去登录 */
  | { kind: 'signed-out' }
  /** 已经写进服务器上的这个案件 */
  | { kind: 'saved'; caseId: number }
  /** 登录了，但名下一个案件都没有（注册中途断了之类）——不是「存好了」 */
  | { kind: 'no-case' }
  /** 网络断了、后端拒收、校验没过：**没存下**，如实说 */
  | { kind: 'failed'; message: string };

export interface FinishNotice {
  message: string;
  tone: 'success' | 'amber';
  /** 低调模式下顶替 message 的那句中性话（带案件字样的必须给） */
  discreet: string;
}

export interface FinishDestination {
  /** 要跳的地址；null = 留在这一页，让用户看见出了什么事 */
  href: string | null;
  notice: FinishNotice;
  /** 能不能清掉本地草稿。**只有确实存进服务器的那一支为 true** */
  clearDraft: boolean;
}

export function destinationForFinish(outcome: FinishOutcome): FinishDestination {
  switch (outcome.kind) {
    case 'signed-out':
      return {
        href: '/login',
        notice: {
          message: '你填的内容已暂存在这台设备上，注册后我会把它并入你的案件档案',
          tone: 'amber',
          discreet: '已经暂存在这台设备上',
        },
        clearDraft: false,
      };

    case 'saved':
      return {
        href: `/case/${outcome.caseId}`,
        notice: {
          message: '已经存进你的档案，正在打开驾驶舱',
          tone: 'success',
          discreet: '已经存好了',
        },
        clearDraft: true,
      };

    // 【这一支不许说"存好了"，也不许去 demo】名下没有案件是个异常，不是一种正常去处。
    // 把人送进演示案件，他会以为那就是自己的档案。
    case 'no-case':
      return {
        href: null,
        notice: {
          message: '没找到你名下的案件，所以这一份还没能存进去。你填的内容还在这台设备上，退出重进或联系我们之后再试一次。',
          tone: 'amber',
          discreet: '这一份还没能存进去，内容还在本机',
        },
        clearDraft: false,
      };

    case 'failed':
      return {
        href: null,
        notice: {
          // 自述三段式：缺什么 / 为什么缺 / 怎么办
          message: `${outcome.message}这一份还没存进去，你填的内容一个字都没丢，还在这台设备上。点「进入驾驶舱」可以再试一次。`,
          tone: 'amber',
          discreet: '这一份还没能存进去，内容还在本机',
        },
        clearDraft: false,
      };
  }
}

/** 月工资输入框里那串字 → 分。不是正数就回 null（服务端也会再挡一次） */
export function wageFenOf(raw: string): number | null {
  const yuan = Number.parseFloat(raw);
  if (!Number.isFinite(yuan) || yuan <= 0) return null;
  return Math.round(yuan * 100);
}

/** 草稿 → 接口请求体。字段名照后端路由，前端不另起一套语义。 */
export function toIntakePayload(draft: IntakeDraft): Record<string, unknown> {
  return {
    stage: draft.stage,
    company_name: draft.companyName,
    employed_from: draft.hiredOn,
    monthly_wage_fen: wageFenOf(draft.monthlyWage),
    position: draft.position,
    contract_count: draft.contractCount,
    events: draft.events.map((e) => ({ date: e.date, text: e.text })),
    free_text: draft.freeText,
    company_docs: {
      terminationNotice: draft.terminationNotice,
      settlementAgreement: draft.settlementAgreement,
      otherPaper: draft.otherPaper,
    },
    company_wording: draft.companyWording,
    goals: draft.goals,
    bottom_line: draft.bottomLine,
  };
}

/**
 * 真正去存。先问「我的案件是哪一个」（与 /case 解析页同一个口径），再往它上面提交。
 * 任何一步失败都回 failed —— **不吞异常、不回落 demo**。
 */
export async function saveIntake(draft: IntakeDraft): Promise<FinishOutcome> {
  try {
    const target = latestOf(await fetchMyCases());
    if (!target) return { kind: 'no-case' };
    await apiFetch(`/cases/${target.id}/intake`, {
      method: 'POST',
      body: toIntakePayload(draft),
    });
    return { kind: 'saved', caseId: target.id };
  } catch (err) {
    return { kind: 'failed', message: humanError(err) };
  }
}
