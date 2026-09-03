/**
 * F-205：只验了手机号、还没补邮箱的人（后端叫 need_email）名下**一个案件都没有**，
 * 而 /intake 从前一次都不查——他能一路填完六步，点「进入驾驶舱」才撞上
 * 「没找到你名下的案件……退出重进或联系我们之后再试一次」。
 * 草稿确实没丢，可六步是白填的，而那三句话里没有一句说得出他该做什么。
 *
 * 这一组盯四件事，每一件都能被对应的变异打红：
 *  ① 名下没案件的人进 /intake，**第 1 步顶上**摆着关不掉的引导条（去掉即红）；
 *  ② 第 6 步提交前被拦下，给的是**同一条引导条**而不是一行裸报错（改回裸报错即红）；
 *  ③ 正常用户（名下有案件）**看不到**引导条——反向对照，摆成人人可见即红；
 *  ④ 补完邮箱回到 /intake，六步草稿原样恢复（存取往返，掉字段即红）。
 *
 * 【判据只用 renderToStaticMarkup（仓库既有套路）】测试环境是 node，没有 DOM，
 * 两处 useEffect（挂载后查案件、挂载后读草稿）都跑不到。所以替它们把结论直接喂进去：
 * 案件三态由 useCaseGuard 的替身给，停在第几步由草稿初值给——喂完之后
 * **渲染的是真的 IntakeFlow**，引导条在不在是从真产物里读出来的，不是源码里搜出来的。
 * 够不着的一处如实记下：那次 fetch 本身（checkCaseGuard）单独验，见最后一节。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CaseGuard } from '../_components/caseGuard';
import type { IntakeDraft } from '../_components/draft';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
// 页面只在按下按钮之后才用得上 toast，静态渲染里它只需要存在
vi.mock('@/components/ui/Toast', () => ({ useToast: () => vi.fn() }));

const fetchMyCases = vi.fn();
vi.mock('@/app/_ui/currentCase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/_ui/currentCase')>()),
  fetchMyCases: () => fetchMyCases(),
}));

/** 挂载后那次查（useEffect）在 node 环境不跑，这里替它把三态直接喂进去 */
const guardState: { guard: CaseGuard } = { guard: 'unknown' };
vi.mock('../_components/caseGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_components/caseGuard')>();
  return {
    ...actual,
    useCaseGuard: () => [guardState.guard, () => {}] as const,
  };
});

/** 停在第几步同样只能从初值给：loadDraft 也在 useEffect 里 */
const seed = { step: 0 };
vi.mock('../_components/draft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_components/draft')>();
  return {
    ...actual,
    get EMPTY_DRAFT() {
      return { ...actual.EMPTY_DRAFT, step: seed.step };
    },
  };
});

const { IntakeFlow } = await import('../_components/IntakeFlow');
const { NO_CASE_GUIDE_LEAD, checkCaseGuard, guidePlacement } = await import(
  '../_components/caseGuard'
);
const { destinationForFinish } = await import('../_components/submit');
// 第 2 步之后的表单格子用 <Sensitive>/DiscreetInput，它们要低调模式那份 context
const { DiscreetProvider } = await import('@/app/_ui/discreet');
const { EMPTY_DRAFT, clearDraft, loadDraft, saveDraft } = await import('../_components/draft');

const SOURCE = readFileSync(
  join(process.cwd(), 'src/app/(app)/intake/_components/IntakeFlow.tsx'),
  'utf8',
);

/** 把某一态的 /intake 整页静态渲染出来 */
function renderIntake(guard: CaseGuard, step: number): string {
  guardState.guard = guard;
  seed.step = step;
  return renderToStaticMarkup(
    createElement(DiscreetProvider, null, createElement(IntakeFlow, { cap: null })),
  );
}

const LAST_STEP = 5;

beforeEach(() => {
  fetchMyCases.mockReset();
});

/* ── ① 第 1 步：名下没案件就把话说在前头 ───────────────────────── */

describe('第 1 步：名下没有案件的人一进来就被告知', () => {
  it('引导条在第 1 步渲染出来了，写的是「先补一个邮箱」并给出去补的按钮', () => {
    const html = renderIntake('no-case', 0);
    expect(html, '第 1 步没有引导条 = 他会一路填到第 6 步才撞墙').toContain(
      NO_CASE_GUIDE_LEAD,
    );
    expect(html).toContain('去补邮箱');
    expect(html).toContain('href="/login"');
  });

  it('引导条关不掉：没有「知道了」也没有叉', () => {
    const html = renderIntake('no-case', 0);
    // 关掉之后他照样会填完六步撞墙，所以这条不许有出口
    expect(html).not.toContain('知道了');
    expect(html).not.toContain('稍后再说');
    expect(html).not.toContain('不再提示');
  });

  it('引导条摆在第 1 步的**顶上**：排在那句「填的内容只存在这台设备」之前', () => {
    const html = renderIntake('no-case', 0);
    const guideAt = html.indexOf(NO_CASE_GUIDE_LEAD);
    const bottomHintAt = html.indexOf('填的内容只存在这台设备的浏览器里');
    expect(guideAt).toBeGreaterThanOrEqual(0);
    expect(bottomHintAt).toBeGreaterThanOrEqual(0);
    expect(guideAt).toBeLessThan(bottomHintAt);
  });
});

/* ── ③ 反向对照：正常用户不该看见它 ──────────────────────────── */

describe('反向对照：不该摆的时候一个字都不摆', () => {
  it('名下有案件的正常用户：第 1 步与第 6 步都没有引导条', () => {
    expect(renderIntake('has-case', 0)).not.toContain(NO_CASE_GUIDE_LEAD);
    expect(renderIntake('has-case', LAST_STEP)).not.toContain(NO_CASE_GUIDE_LEAD);
  });

  it('还没查到 / 查不到（unknown）也不摆：查不到不等于没有', () => {
    expect(renderIntake('unknown', 0)).not.toContain(NO_CASE_GUIDE_LEAD);
    expect(renderIntake('unknown', LAST_STEP)).not.toContain(NO_CASE_GUIDE_LEAD);
  });

  it('正对照：同一个页面在 no-case 下确实摆得出来（上面那两条不是因为渲染空了才绿）', () => {
    expect(renderIntake('no-case', 0)).toContain(NO_CASE_GUIDE_LEAD);
    expect(renderIntake('has-case', 0)).toContain('现在到哪一步了');
  });

  it('中间四步不摆：草稿一直留着，不填完也不会丢', () => {
    for (const step of [1, 2, 3, 4]) {
      expect(renderIntake('no-case', step)).not.toContain(NO_CASE_GUIDE_LEAD);
    }
  });
});

/* ── ② 第 6 步：提交前拦下，给出路不给裸报错 ──────────────────── */

describe('第 6 步：拦在提交前，并且给的是出路', () => {
  it('第 6 步同样摆引导条，贴着「进入驾驶舱」', () => {
    const html = renderIntake('no-case', LAST_STEP);
    expect(html, '第 6 步没有引导条 = 又回到裸报错那一版').toContain(NO_CASE_GUIDE_LEAD);
    expect(html).toContain('去补邮箱');
  });

  it('末步「名下没有案件」这一支带 guide 标志，用的是引导条的话，不是原来那句裸报错', () => {
    const dest = destinationForFinish({ kind: 'no-case' });
    expect(dest.guide, 'guide=false = 页面只会再摆一行红字，说不出该去哪儿').toBe(true);
    expect(dest.notice.message).toContain(NO_CASE_GUIDE_LEAD);
    // 原来那句：说了出事，没说该做什么
    expect(dest.notice.message).not.toContain('联系我们');
    expect(dest.notice.message).not.toContain('退出重进');
    // 低调模式下这句会被顶替，顶替的那句不许带案件字样
    expect(dest.notice.discreet).not.toContain('案件');
    // 没存下的老规矩一条都不松
    expect(dest.href).toBeNull();
    expect(dest.clearDraft).toBe(false);
    expect(dest.notice.tone).not.toBe('success');
  });

  it('别的没存下的支仍然走那行红字：它们没有一条现成的出路可指', () => {
    expect(destinationForFinish({ kind: 'failed', message: '网络没连上。' }).guide).toBe(false);
    expect(destinationForFinish({ kind: 'signed-out' }).guide).toBe(false);
    expect(destinationForFinish({ kind: 'saved', caseId: 7 }).guide).toBe(false);
  });

  it('结构守卫：guide 那一支接的是引导条，红字只留给 !guide 的支', () => {
    expect(SOURCE).toContain("if (dest.guide) setCaseGuard('no-case')");
    expect(SOURCE).toContain('!dest.guide');
    expect(SOURCE).toContain("placement === 'first-step'");
    expect(SOURCE).toContain("placement === 'last-step'");
  });
});

/* ── 摆在哪一步的判断本身 ────────────────────────────────────── */

describe('引导条摆在哪一步', () => {
  it('只有 no-case 才摆，且只摆第 1 步与第 6 步', () => {
    expect(guidePlacement({ guard: 'no-case', step: 0, total: 6 })).toBe('first-step');
    expect(guidePlacement({ guard: 'no-case', step: 5, total: 6 })).toBe('last-step');
    expect(guidePlacement({ guard: 'no-case', step: 2, total: 6 })).toBe('none');
    expect(guidePlacement({ guard: 'has-case', step: 0, total: 6 })).toBe('none');
    expect(guidePlacement({ guard: 'unknown', step: 0, total: 6 })).toBe('none');
  });
});

/* ── 那次查本身：三种回答各一条，「查不到」不许算「没有」 ──────── */

describe('名下有没有案件这一问', () => {
  it('接口回空清单 = 确实没有', async () => {
    fetchMyCases.mockResolvedValueOnce([]);
    await expect(checkCaseGuard()).resolves.toBe('no-case');
  });

  it('接口回了案件 = 有', async () => {
    fetchMyCases.mockResolvedValueOnce([{ id: 6, title: '我的案件' }]);
    await expect(checkCaseGuard()).resolves.toBe('has-case');
  });

  it('网络断了 / 后端 5xx = unknown，**不许**当成没有', async () => {
    fetchMyCases.mockRejectedValueOnce(new Error('Failed to fetch'));
    await expect(
      checkCaseGuard(),
      '把「查不到」当成「没有」，就是拿一条看着很正常的引导条挡住一个名下有案件的人',
    ).resolves.toBe('unknown');
  });
});

/* ── ④ 补完邮箱回来，六步原样还在 ───────────────────────────── */

describe('补完邮箱回到 /intake：六步草稿原样恢复', () => {
  const FULL: IntakeDraft = {
    ...EMPTY_DRAFT,
    step: LAST_STEP,
    stage: '已解除',
    hiredOn: '2021-04-12',
    monthlyWage: '22000',
    position: '后端工程师',
    companyName: '华衡永泰',
    contractCount: '续签两次及以上',
    events: [{ id: 'e1', date: '2026-08-01', text: 'HR 约谈' }],
    freeText: '当天下午被要求交出门禁卡',
    terminationNotice: '有',
    settlementAgreement: '没有',
    otherPaper: '不确定',
    companyWording: '组织架构调整',
    goals: ['违法解除赔偿金（2N）', '拖欠的工资'],
    bottomLine: '至少拿到 N+1',
  };

  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it('六步每一格都原样读回来，包括停在第几步', () => {
    saveDraft(FULL);
    const back = loadDraft();
    expect(back, '读不回来 = 用户补完邮箱回来看见一张空表').not.toBeNull();
    // savedAt 是落盘那一刻现写的，不参与比对；其余每一格都要一模一样
    const { savedAt: _drop, ...rest } = FULL;
    expect(back).toMatchObject(rest);
    expect(back?.events).toEqual(FULL.events);
    expect(back?.goals).toEqual(FULL.goals);
  });

  it('反向对照：清掉之后就真的没有了（上面那条不是因为读的是内存里的同一个对象）', () => {
    saveDraft(FULL);
    clearDraft();
    expect(loadDraft()).toBeNull();
  });
});
