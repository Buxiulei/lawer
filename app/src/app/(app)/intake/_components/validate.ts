'use client';

/**
 * 首诊的逐步校验：这一步还差什么，用**这一步自己的话**说出来。
 *
 * 【为什么要逐步拦】此前只有第 0 步校验（`step !== 0 || Boolean(draft.stage)`），
 * 后面五步一律放行：入职日期和月工资空着也能一路点到最后一步，然后档案页上
 * 「预估诉求金额」整列写着「待补材料」，用户不知道是哪一步漏了、也不知道回哪儿补。
 * 而这两个数是 N/2N/N+1 的**计算输入**——空着往下走，等于把一场白填留到最后才揭晓。
 *
 * 【提示写在拦下来的那一步】返回的字符串直接贴在按钮下方，说的是「这一步差什么」，
 * 不是「有必填项未填」。一句放之四海皆准的提示等于没提示。
 */

import type { IntakeDraft } from './draft';
import { wageFenOf } from './submit';

/** 步序：与 IntakeFlow 的 STEPS 一一对应，改了那边要同步这里 */
export const STEP_STAGE = 0;
export const STEP_BASICS = 1;
export const STEP_GOALS = 4;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 是不是一个真实存在的日子（'2026-02-31' 要判否）。与服务端 normalizeDateOnly 同口径。 */
export function isRealDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

/**
 * 这一步还不能往下走的理由；null = 可以走。
 *
 * @param today 'YYYY-MM-DD'，用来挡住「入职时间填在未来」
 */
export function advanceBlock(step: number, draft: IntakeDraft, today: string): string | null {
  if (step === STEP_STAGE) {
    return draft.stage ? null : '先选一个最接近你现在情况的阶段。';
  }

  if (step === STEP_BASICS) {
    if (!draft.hiredOn.trim()) {
      return '入职时间要填：工龄按它算，补偿是几个月全看这一格。记不清就填大概的那天，之后传合同能改。';
    }
    if (!isRealDate(draft.hiredOn.trim())) {
      return '入职时间填成 2021-04-12 这样的日子；现在这个日期不存在。';
    }
    if (draft.hiredOn.trim() > today) {
      return '入职时间不能晚于今天。填错了就改成合同上写的那天。';
    }
    if (!draft.monthlyWage.trim()) {
      return '月工资要填：所有金额都拿它当基数。填离职前 12 个月的平均实发工资。';
    }
    if (wageFenOf(draft.monthlyWage) === null) {
      return '月工资只填数字，例如 25000；带「万」「元」或逗号都算不了。';
    }
    if (!draft.companyName.trim()) {
      return '公司名称要填：仲裁时它就是被申请人，写合同上盖章的那个名字。';
    }
    return null;
  }

  if (step === STEP_GOALS) {
    return draft.goals.length > 0
      ? null
      : '至少选一项你想要的。现在选不准也没关系，档案建好后随时改。';
  }

  return null;
}
