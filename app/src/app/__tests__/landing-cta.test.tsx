/**
 * 主页（`/`）的两条硬规矩，2026-09-01 产品负责人亲测后裁定：
 *
 *   ①「不要默认都跳转到 case 里！默认就是主页！」——**这一页对谁都渲染，不自动跳走**。
 *     此前落地页正文之前注入一段同步脚本，读到 token 就 location.replace 进案件；
 *     登录用户地址栏输 `/` 从来没见过主页，只能退出登录才看得到。
 *
 *   ② 进案件只靠主动点击：主 CTA 在登录态下变成「进入我的案件」，去处由
 *     _ui/currentCase 那个唯一入口算（未登录 → /login，已登录 → 解析页或自己的案件）。
 *
 * 【这些断言各有多强】跳转那条是**渲染断言**：真把整页渲染出来，看有没有 `<script`。
 * 它挡得住"把脚本注入加回来"的任何写法（不管脚本内容是什么），也挡得住换个常量名再注入。
 * 它挡不住 middleware / next.config 里的服务端跳转——那两处本仓目前没有，
 * 真加了得另立判据。CTA 那几条是渲染断言，验的是字面与 href，不验像素。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 登录态的替身开关；_ui/auth 与 _ui/currentCase 都从这里取答案 */
const auth = { token: null as string | null };

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// currentCase.ts 里那句 `import { useAuthToken } from './auth'` 与这里是同一个模块，
// 所以这一份替身同时管住 PrimaryCta 和 useMyCaseHref 两边。
vi.mock('@/app/_ui/auth', () => ({
  useAuthToken: () => auth.token,
  useSignedIn: () => auth.token !== null,
}));

const { default: LandingPage } = await import('../page');
const { PrimaryCta } = await import('../_components/PrimaryCta');

/** 案件 id 缓存的替身（readCachedCaseId 走 localStorage） */
function stubCache(caseId: string | null) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k === 'lawer.caseId' ? caseId : null),
    setItem: () => {},
    removeItem: () => {},
  });
}

function signIn(caseId: string | null = null) {
  auth.token = 'jwt-abc';
  stubCache(caseId);
}

beforeEach(() => {
  auth.token = null;
  stubCache(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const text = (html: string) => html.replace(/<[^>]+>/g, '');
const hrefOf = (html: string) => html.match(/href="([^"]*)"/)?.[1] ?? null;

/* ── 一、主 CTA 双态 ───────────────────────────────────── */

describe('主页那颗主 CTA', () => {
  it('未登录：写「开始我的案件」，去登录页', () => {
    const html = renderToStaticMarkup(<PrimaryCta />);
    expect(text(html)).toBe('开始我的案件');
    expect(hrefOf(html)).toBe('/login');
  });

  it('已登录、还不知道是哪个案件：写「进入我的案件」，去解析页', () => {
    signIn(null);
    const html = renderToStaticMarkup(<PrimaryCta />);
    expect(text(html)).toBe('进入我的案件');
    expect(hrefOf(html)).toBe('/case');
  });

  it('已登录、缓存里有案件：同样写「进入我的案件」，直接指他自己那个', () => {
    signIn('2');
    const html = renderToStaticMarkup(<PrimaryCta />);
    expect(text(html)).toBe('进入我的案件');
    expect(hrefOf(html)).toBe('/case/2');
  });

  it('已登录也不指演示案件——demo 只从那条写着「看演示」的入口进', () => {
    signIn('2');
    expect(hrefOf(renderToStaticMarkup(<PrimaryCta />))).not.toContain('demo');
  });
});

/* ── 二、这一页不跳走 ──────────────────────────────────── */

describe('主页（登录与否都渲染，不自动跳）', () => {
  /**
   * 变异核：把 signedInRedirectScript 那段 `<script dangerouslySetInnerHTML>`
   * 加回 page.tsx，这两条立刻红。
   */
  it('未登录：整页里没有任何注入脚本', () => {
    expect(renderToStaticMarkup(<LandingPage />)).not.toContain('<script');
  });

  it('已登录（连缓存里的案件 id 都有）：照样渲染主页，没有注入脚本', () => {
    signIn('2');
    const html = renderToStaticMarkup(<LandingPage />);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('location.replace');
  });

  it('正对照：整页确实渲染出来了（否则上面几条在空字符串上永远绿）', () => {
    signIn('2');
    const plain = text(renderToStaticMarkup(<LandingPage />));
    expect(plain).toContain('被裁员了，不知道下一步？');
    expect(plain).toContain('进入我的案件');
  });

  it('登录用户仍看得到「先看看演示案件」那条（别把主动入口误伤）', () => {
    signIn('2');
    const html = renderToStaticMarkup(<LandingPage />);
    expect(text(html)).toContain('先看看演示案件');
    expect(html).toContain('href="/case/demo"');
  });
});
