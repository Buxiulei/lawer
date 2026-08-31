/**
 * 档案取数这一屏的**行为**判据：一次真的 HTTP 答复 → 一屏真的 HTML。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * DossierLoader 此前一条判据都没有，而它身上挂着一条真出过事的红线：
 * 早先这里把 `HTTP_404` 也算进"还没建档"，于是**端点根本不存在**的那段时间里，
 * 档案页对每一个真实案件都打着一个不存在的地址、显示着一屏体面的招呼页。
 * 那条规矩后来改对了，但**没有任何一条判据够得着它**——把吞噬加回去，
 * 整套 2675 条仍然全绿（取数在 useEffect 里，SSR 不跑 effect）。
 *
 * 所以这组从**网络层的答复**起跑：不 mock apiFetch（mock 掉网络层的全绿，
 * 恰恰是当年那次事故里"看起来一切正常"的来源），只把 `fetch` 换成一个
 * 吐出真 Response 的桩，让 api.ts 的 404 → ApiError 翻译也一并受判。
 *
 * 三形各一条：`status:'none'` → 引导态（orderPath 原样透传）、
 * `status:'ready'` → 档案体、404 → 报错条（不吞）。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import { mockDossier } from '@/app/_mock/company-dossier';
import { DossierScreenView, loadDossierScreen } from '../DossierLoader';

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const visibleText = (html: string) => html.replace(/<[^>]+>/g, '');

/** 招呼屏与档案体各自的那句招牌话，用来区分"这一屏到底是哪一屏" */
const NOT_ORDERED_HEADLINE = '这个案件还没有建过公司档案';
const ERROR_HINT = '已经查到的内容还在，只是这次没读出来。';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** 把 fetch 换成吐这一个 Response 的桩，返回记录下来的请求地址 */
function stubFetch(res: Response): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return res.clone();
  }) as unknown as typeof fetch;
  return { urls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** 走一遍「取数 → 渲染」，拿到这一屏的 HTML 与它的判定结果 */
async function screenOf(caseId: string) {
  const screen = await loadDossierScreen(caseId);
  return { screen, html: ssr(<DossierScreenView caseId={caseId} screen={screen} onRetry={() => {}} />) };
}

describe('还没建档（200 + status:none）⇒ 引导态，且 orderPath 原样透传', () => {
  /**
   * 变异臂：把 DossierNotOrdered 的下单链接改成前端自己按 caseId 拼的地址，这条会红——
   * 「去哪儿下单」由端点说了算（它知道这个案子该走哪条入口），前端拼一遍就会在
   * 入口改动的那天指到一个旧地址上，而页面看起来完全正常。
   */
  it('出招呼屏，链接就是响应里那一条', async () => {
    const orderPath = '/case/77/dossier/order?from=probe';
    stubFetch(json({ ok: true, status: 'none', dossier: null, orderPath }));

    const { screen, html } = await screenOf('77');
    expect(screen.kind).toBe('notOrdered');
    expect(visibleText(html)).toContain(NOT_ORDERED_HEADLINE);
    expect(html).toContain(`href="${orderPath}"`);
    // 招呼屏不是错误屏：不许出现重试条
    expect(visibleText(html)).not.toContain(ERROR_HINT);
  });
});

describe('已建档（200 + status:ready）⇒ 档案体', () => {
  it('出档案正文，不是招呼屏也不是错误条', async () => {
    stubFetch(json({ ok: true, status: 'ready', dossier: mockDossier }));

    const { screen, html } = await screenOf('77');
    expect(screen.kind).toBe('ready');
    const text = visibleText(html);
    expect(text).toContain(mockDossier.companyName);
    expect(text).toContain('进展');
    expect(text).not.toContain(NOT_ORDERED_HEADLINE);
    expect(text).not.toContain(ERROR_HINT);
  });

  it('打的是这个案件的档案端点', async () => {
    const { urls } = stubFetch(json({ ok: true, status: 'ready', dossier: mockDossier }));
    await loadDossierScreen('77');
    expect(urls).toEqual(['/api/v1/cases/77/dossier']);
  });
});

describe('404 ⇒ 报错条，绝不当成「还没建档」', () => {
  /**
   * 【这一条是整组的由头】变异臂：把 `HTTP_404`（或任何一张
   * `NOT_ORDERED_CODES` 白名单）加回 loadDossierScreen 的 catch 里当成"还没建档"，
   * 这条会红——一个打不通的端点会重新变成一屏体面的招呼页。
   *
   * 桩吐的是**没有错误信封的裸 404**（端点不存在时 Next 回的就是一段 HTML），
   * 这正是当年那次事故的原形：api.ts 认不出 error_code，落到 `HTTP_404`。
   */
  it('端点不存在（裸 404）⇒ 出错误条与重试按钮', async () => {
    stubFetch(new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }));

    const { screen, html } = await screenOf('77');
    expect(screen.kind).toBe('error');
    const text = visibleText(html);
    expect(text).toContain(ERROR_HINT);
    expect(text).toContain('重新加载');
    // 最要命的那一形：它绝不能长成招呼屏
    expect(text).not.toContain(NOT_ORDERED_HEADLINE);
    expect(html).not.toContain('/dossier/order');
  });

  /**
   * 带错误信封的 404（本案不存在/不归你）同样是故障，不是"还没建档"。
   * 变异臂：把 `CASE_NOT_FOUND` 算进"还没建档"，这条会红——
   * 别人的案件会显示成"你还没买过"，等于给出一个可以按案件 id 试探的探针。
   */
  it('CASE_NOT_FOUND 也走报错，不翻成招呼屏', async () => {
    stubFetch(json({ ok: false, error_code: 'CASE_NOT_FOUND', message: '这个案件不存在' }, 404));

    const { screen, html } = await screenOf('77');
    expect(screen.kind).toBe('error');
    expect(visibleText(html)).toContain('这个案件不存在');
    expect(visibleText(html)).not.toContain(NOT_ORDERED_HEADLINE);
  });
});
