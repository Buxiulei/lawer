import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { gateHints, noticeCopy, type NoticeCode, type NoticeFrame } from '../frames';

function notice(code: NoticeCode, message = '', suggest?: string): NoticeFrame {
  return { type: 'notice', code, message, ...(suggest === undefined ? {} : { suggest }) };
}

/**
 * 全量 code 清单。写成 Record 而不是数组，是为了让**新增 code 却忘了在这里登记**
 * 变成一个编译错误——否则下面那条「不得出现空字符串」的护栏会随着新码悄悄漏测。
 */
const ALL_CODES: Record<NoticeCode, true> = {
  KNOWLEDGE_MISS: true,
  KNOWLEDGE_UNAVAILABLE: true,
  CORE_ARTICLE_INJECTED: true,
  CORE_ARTICLE_RENDERED: true,
  INJECTION_OBSERVED: true,
  EMPTY_PACK: true,
  ACTION_CARD_CAPPED: true,
  ACTION_CARD_MISSING: true,
  REFERRAL_ALREADY_USED: true,
  USAGE_UNREPORTED: true,
  SERVED_MODEL_MISMATCH: true,
  PROMPT_CACHE: true,
  TOOL_INPUT_REJECTED: true,
  CITATION_BLOCKED: true,
  CITATION_INCOMPLETE: true,
  STATUTE_UNVERIFIED: true,
  VALUE_UNSOURCED: true,
  GATE_REPORT: true,
  PRECEDENT_CONTAMINATED: true,
  CALC_FAILED: true,
  EMOTIONAL_LEVERAGE_DETECTED: true,
  NBDPSY_PITCH_BLOCKED: true,
  REFERRAL_OFFERED: true,
  REFERRAL_DECLINED: true,
  CONSENT_RECORDED: true,
  CRISIS_PAID_CONTENT_BLOCKED: true,
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
  // ⑤⑥⑨ 三个码**不在这份名单里**：它们改走闸提示行（GateHintLine），
  // 由下面「闸提示行」那一组钉住。`noticeCopy` 对它们照样返回 null，
  // 是为了不让同一条通知被两处各画一遍，不是"静默"。
  it.each<NoticeCode>([
    'ACTION_CARD_CAPPED',
    'ACTION_CARD_MISSING',
    'REFERRAL_ALREADY_USED',
    'TOOL_INPUT_REJECTED',
    'CITATION_INCOMPLETE',
    'GATE_REPORT',
    'PRECEDENT_CONTAMINATED',
    'EMOTIONAL_LEVERAGE_DETECTED',
    'NBDPSY_PITCH_BLOCKED',
    'CORE_ARTICLE_INJECTED',
    'CORE_ARTICLE_RENDERED',
    'INJECTION_OBSERVED',
    'EMPTY_PACK',
    'USAGE_UNREPORTED',
    'SERVED_MODEL_MISMATCH',
    'PROMPT_CACHE',
    'REFERRAL_OFFERED',
    'REFERRAL_DECLINED',
    'CRISIS_PAID_CONTENT_BLOCKED',
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

  /**
   * 【为什么这一支改成 error，而且改成三段式】码表已经从 events.ts 派生（见 frames.ts），
   * 走到这里只剩一种可能：两份表脱节了，而那本该被 tsc 拦住。
   * 它此前是 `console.warn` 一行 —— 而实测有 7 个后端**每天都在发**的码从来没进过前端词表，
   * 每一条都掉进这一支：屏幕上没有任何异样、服务端没有任何异样，只有浏览器控制台里
   * 攒着一行行没人看的字。三段式：缺什么／为什么缺／怎么办。
   */
  it('未知 code 丢弃并 console.error 三段式（不让后端加码把老前端打崩）', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(noticeCopy(notice('SOMETHING_NEW' as NoticeCode, '新码'))).toBeNull();
    expect(err).toHaveBeenCalled();
    const said = String(err.mock.calls[0]?.[0] ?? '');
    expect(said, '缺什么：哪个码').toContain('SOMETHING_NEW');
    expect(said, '为什么缺：两份表脱节').toContain('events.ts');
    expect(said, '怎么办：加进哪两处').toContain('NOTICE_COPY');
    err.mockRestore();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 码表完整性守卫：后端 events.ts 与前端词表**必须逐个对得上**
 * ═══════════════════════════════════════════════════════════════════════════
 * 【缺这条判据的形态】(实测 2026-09-10) 后端 26 个码、前端 16 个，差的 10 个里
 * 有 7 个是每天真在发的（CORE_ARTICLE_RENDERED / INJECTION_OBSERVED / EMPTY_PACK /
 * REFERRAL_OFFERED / REFERRAL_DECLINED / CRISIS_PAID_CONTENT_BLOCKED / CORE_ARTICLE_INJECTED）。
 * 两份表脱节这件事**在任何一处都不报错**：后端照发、前端照丢、页面照常。
 * 此前唯一沾边的用例拿一个虚构的 'SOMETHING_NEW' 测"不崩溃"——它测的是崩不崩，
 * 不是对不对得上。
 */
describe('码表完整性（events.ts ↔ frames.ts）', () => {
  const EVENTS_SRC = readFileSync(
    new URL('../../../../../../lib/agent/events.ts', import.meta.url),
    'utf8',
  );

  /** 从源码里读后端那份联合类型的成员。判据要读**源码**：类型在运行时不存在。 */
  function backendCodes(): string[] {
    const decl = /export type NoticeCode =([\s\S]*?);\n/.exec(EVENTS_SRC);
    expect(decl, 'events.ts 里找不到 NoticeCode 的声明——判据自己失效了').toBeTruthy();
    return [...decl![1].matchAll(/^\s*\|\s*'([A-Z][A-Z0-9_]*)'\s*$/gm)].map((m) => m[1]);
  }

  // 空名单会让下面那条永远绿（registry-guard 同款对照臂）
  it('确实读到了后端的码表（读空 → 下面那条形同虚设）', () => {
    expect(backendCodes().length).toBeGreaterThanOrEqual(26);
  });

  it('两份表逐个相等（变异：往 events.ts 的 NoticeCode 加一个码 → 红）', () => {
    const backend = [...backendCodes()].sort();
    const frontend = (Object.keys(ALL_CODES) as NoticeCode[]).slice().sort();
    expect(frontend).toEqual(backend);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 闸提示行：闸开了火，用户要看到一句「下一步」
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('gateHints', () => {
  it.each<NoticeCode>(['CITATION_BLOCKED', 'STATUTE_UNVERIFIED', 'VALUE_UNSOURCED'])(
    '%s 带 suggest 时进闸提示行（变异：词表里把它改回 null → 红）',
    (code) => {
      const hints = gateHints([notice(code, '出路：回我一句「查一下这条」。', '查一下这条')]);
      expect(hints).toHaveLength(1);
      expect(hints[0].message).toBe('出路：回我一句「查一下这条」。');
      expect(hints[0].suggest).toBe('查一下这条');
    },
  );

  it('没有 suggest 的同码通知不另起提示行（⑦ 的出路已经写在正文替换句里）', () => {
    expect(gateHints([notice('CITATION_BLOCKED', '检出 2 处伪逐字引用，已改口为待核实。')])).toEqual([]);
  });

  it('静默类的码不进闸提示行，哪怕后端硬塞了一个 suggest', () => {
    expect(gateHints([notice('GATE_REPORT', '闸链本轮：候选 3 处', '再说一遍')])).toEqual([]);
  });

  it('同一轮多条同码合并成一条，只报条数（逐条画 → 正文底下叠三行几乎一样的字）', () => {
    const hints = gateHints([
      notice('STATUTE_UNVERIFIED', '第一条：出路 A。', '查一下这条'),
      notice('STATUTE_UNVERIFIED', '第二条：出路 B。', '取新版'),
      notice('STATUTE_UNVERIFIED', '第三条：出路 C。', '取新版'),
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0].message).toContain('第一条：出路 A。');
    expect(hints[0].message).toContain('还有 2 条');
    // 合并保留第一条的 chip：把三句话拼起来就成了一段没人读得完的话
    expect(hints[0].suggest).toBe('查一下这条');
    expect(hints[0].message).not.toContain('出路 B');
  });

  it('不同码各留一条（三道闸同一轮开火 → 三行，不是一行）', () => {
    const hints = gateHints([
      notice('STATUTE_UNVERIFIED', '条号那条', '查一下这条'),
      notice('VALUE_UNSOURCED', '数值那条', '帮我算一下'),
      notice('CITATION_BLOCKED', '案号那条', '找这个案例'),
    ]);
    expect(hints.map((h) => h.code)).toEqual(['STATUTE_UNVERIFIED', 'VALUE_UNSOURCED', 'CITATION_BLOCKED']);
  });

  it('message 空白时不画（空提示行比不出提示更让人心慌）', () => {
    expect(gateHints([notice('STATUTE_UNVERIFIED', '   ', '查一下这条')])).toEqual([]);
  });
});
