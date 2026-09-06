// app/src/lib/agent/__tests__/crisis-by-domain.test.ts
// 危机层**换包就换话**（设计稿 §13「危机」行）。
//
// 【这条判据在证什么】判定机制（否定语境、两态首段、切分）跨领域共用，词表与话按领域来。
// 证法是造一个**与缺省领域完全不同**的假包，看同一段代码是否照它的词表判、照它的话说。
// 不造假包只测缺省领域的形态是：代码里就算写死了缺省领域的词表，测试照样全绿——
// 因为它只问过缺省领域这一个包。
import { describe, expect, it } from 'vitest';

import { assembleCrisisOpener, type CrisisOpenerText } from '../crisis-opener';
import { assessCrisis, buildCrisisOpener, splitCrisisOpener } from '../crisis';
import { DEFAULT_DOMAIN, DOMAINS, type DomainCrisis } from '@/lib/domains/registry';

const DEFAULT_CRISIS = DOMAINS[DEFAULT_DOMAIN].crisis;

/** 一个假领域的危机包：词表、否定标记、话，与缺省领域**没有一个字重合**。 */
const OPENER: CrisisOpenerText = {
  head: ['假领域开场第一行。', '假领域开场第二行：'],
  tail: '假领域收束句。',
  after: '假领域附加句。',
};
const FAKE: DomainCrisis = {
  lexicon: ['甲乙丙'],
  negations: ['并非'],
  resourcePackId: 'fake-resource-card',
  directive: '假领域的危机指令。',
  openerText: OPENER,
  safeFallback: '假领域的兜底正文。',
  firstSegment: (ctx) => assembleCrisisOpener(OPENER, ctx.facts, { compact: ctx.compact }),
};

const FACTS = {
  hotlines: [
    { name: '假热线', phone: '12345', category: 'crisis' as const, status: 'usable' as const, hours: '全天' },
  ],
};

describe('危机判定按领域包走', () => {
  it('假包只认自己的词：缺省领域的触发词在它这里不触发（变异：把词表写死回缺省领域 → 红）', () => {
    const defaultTerm = DEFAULT_CRISIS.lexicon[0];
    expect(assessCrisis(defaultTerm).triggered).toBe(true);
    expect(assessCrisis(defaultTerm, FAKE).triggered).toBe(false);
  });

  it('假包认自己的词，并回自己的指令与资源卡 id（变异：directive 写死 → 红）', () => {
    const got = assessCrisis('我觉得甲乙丙', FAKE);
    expect(got.triggered).toBe(true);
    expect(got.matched).toEqual(['甲乙丙']);
    expect(got.directive).toBe(FAKE.directive);
    expect(got.resourcePackId).toBe('fake-resource-card');
  });

  it('否定语境用的是**这个包的**否定标记（变异：把 negations 写死 → 红）', () => {
    // 假包的否定标记是「并非」，缺省领域没有它
    const got = assessCrisis('这并非甲乙丙', FAKE);
    expect(got.triggered).toBe(false);
    expect(got.suppressed).toEqual(['甲乙丙']);
    // 反过来：缺省领域的否定标记在假包里不生效
    expect(assessCrisis('我不是甲乙丙', FAKE).triggered).toBe(true);
  });

  it('首段两态都用这个包的话，且座机标记这类机制照旧生效', () => {
    const full = buildCrisisOpener(FACTS, {}, FAKE);
    expect(full).toContain(OPENER.head[0]);
    expect(full).toContain('12345');
    expect(full).toContain(OPENER.tail);
    expect(full).toContain(OPENER.after!);
    expect(full).not.toContain(DEFAULT_CRISIS.openerText.tail);

    const compact = buildCrisisOpener(FACTS, { compact: true }, FAKE);
    expect(compact).toContain('12345');
    // 复现态不重印描述性内容，也不跟 after 那一句
    expect(compact).not.toContain('全天');
    expect(compact).not.toContain(OPENER.after!);
  });

  it('一条热线都取不到时只发开场第一行（两个包同一机制）', () => {
    expect(buildCrisisOpener({ hotlines: [] }, {}, FAKE)).toBe(OPENER.head[0]);
    expect(buildCrisisOpener({ hotlines: [] })).toBe(DEFAULT_CRISIS.openerText.head[0]);
  });

  it('切分认的是**同一个包**的首段：拿缺省领域去切假包的正文 ⇒ 切不出来', () => {
    const text = `${buildCrisisOpener(FACTS, {}, FAKE)}\n\n模型段正文`;
    const byFake = splitCrisisOpener(text, FAKE);
    expect(byFake.body).toBe('模型段正文');
    expect(byFake.opener).toContain(OPENER.after!);

    // 用缺省领域的首段去切假包的正文：开头对不上，整段被当成模型段（这正是要防的那种静默拆错）
    const byDefault = splitCrisisOpener(text);
    expect(byDefault.opener).toBe('');
    expect(byDefault.body).toBe(text);
  });
});
