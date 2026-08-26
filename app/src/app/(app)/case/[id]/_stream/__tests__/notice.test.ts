import { describe, expect, it, vi } from 'vitest';
import { noticeCopy, type NoticeCode, type NoticeFrame } from '../frames';

function notice(code: NoticeCode, message = ''): NoticeFrame {
  return { type: 'notice', code, message };
}

/**
 * 全量 code 清单。写成 Record 而不是数组，是为了让**新增 code 却忘了在这里登记**
 * 变成一个编译错误——否则下面那条「不得出现空字符串」的护栏会随着新码悄悄漏测。
 */
const ALL_CODES: Record<NoticeCode, true> = {
  KNOWLEDGE_MISS: true,
  KNOWLEDGE_UNAVAILABLE: true,
  ACTION_CARD_CAPPED: true,
  ACTION_CARD_MISSING: true,
  REFERRAL_ALREADY_USED: true,
  TOOL_INPUT_REJECTED: true,
  CITATION_BLOCKED: true,
  CITATION_INCOMPLETE: true,
  PRECEDENT_CONTAMINATED: true,
  CALC_FAILED: true,
  EMOTIONAL_LEVERAGE_DETECTED: true,
  NBDPSY_PITCH_BLOCKED: true,
};

describe('CALC_FAILED：唯一一条用后端原文的用户可见提示', () => {
  // 这是本条 code 存在的全部意义：后端把「还差哪几项」拼好下发，
  // 前端照搬。词表里写死一句话或写成 '' 都等于把出路藏起来。
  it('照搬后端 message，缺失项一字不改地送到用户眼前', () => {
    const msg =
      '这笔金额我暂时算不出来——还差：入职日期、最近12个月工资。你把这几项告诉我，我立刻重算一遍；其他部分不受影响，可以先看。';
    expect(noticeCopy(notice('CALC_FAILED', msg))).toBe(msg);
  });

  // 空提示行比不出提示更让人心慌，所以退化成静默而不是渲染一个空框。
  it.each(['', '   ', '\n'])('后端 message 为空白(%j) → 静默', (msg) => {
    expect(noticeCopy(notice('CALC_FAILED', msg))).toBeNull();
  });
});

describe('词表口径', () => {
  it('两条法条库提示出固定文案', () => {
    expect(noticeCopy(notice('KNOWLEDGE_MISS'))).toContain('法条库暂无逐字依据');
    expect(noticeCopy(notice('KNOWLEDGE_UNAVAILABLE'))).toContain('没连上');
  });

  // 治理类信号一律静默，尤其不得让用户看见「拦截」类字样。
  it.each<NoticeCode>([
    'ACTION_CARD_CAPPED',
    'ACTION_CARD_MISSING',
    'REFERRAL_ALREADY_USED',
    'TOOL_INPUT_REJECTED',
    'CITATION_BLOCKED',
    'CITATION_INCOMPLETE',
    'PRECEDENT_CONTAMINATED',
    'EMOTIONAL_LEVERAGE_DETECTED',
    'NBDPSY_PITCH_BLOCKED',
  ])('%s 静默', (code) => {
    expect(noticeCopy(notice(code, '后端随便说了什么'))).toBeNull();
  });

  /**
   * 回归护栏。2026-08-26 真实事故的形状：词表里把 CALC_FAILED 配成 `''`，
   * 渲染层 `if (!copy) return null` 把它当静默吞了——
   * **看着像「配了文案」，实际一个字都不显示，而且没有任何异常信号**。
   * 空字符串在这张表里永远是笔误：要么给文案，要么明写 null。
   */
  it('任何 code 都不得返回空字符串——要么有文案要么明确静默', () => {
    for (const code of Object.keys(ALL_CODES) as NoticeCode[]) {
      const copy = noticeCopy(notice(code, '后端原文'));
      expect(copy === null || copy.trim().length > 0).toBe(true);
    }
  });

  it('未知 code 忽略并 warn，不让后端加码把老前端打崩', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(noticeCopy(notice('SOMETHING_NEW' as NoticeCode, '新码'))).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
