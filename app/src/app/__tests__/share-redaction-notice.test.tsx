// app/src/app/__tests__/share-redaction-notice.test.tsx
// 免登录分享页正文之前的那一句：**这一份被替换过没有**（协议第五条第 4 款）。
//
// 【立这一组的由头】此前这一页只在**脱敏过**的时候说话，不脱敏时一个字都不说。
// 那个形态是：拿到链接的人读到一份看起来干干净净的正文，无从知道里面的手机号、
// 身份证号、公司名就是真的——他可能顺手转发到一个群里；
// 而分享的人这一侧同样读不到任何提示，他以为"平台大概会处理一下"。
// 沉默在这里不是中立：它让两边各自补上了一个对自己有利的假设。
//
// 【为什么必须两臂】只验"不脱敏那一路印了未脱敏"的形态是：把它改成**恒印**也照样绿，
// 而那会让声明了敏感级的领域的分享页同时印着「已脱敏」与「未脱敏」两句话。
// 所以两臂一起钉：有声明的印它自己那一句、且**不**印未脱敏；没声明的反过来。
//
// 【量具边界】这一组只管"给定 redact_notice 是不是 null，页面画哪一句"。
// "什么样的案件 redact_notice 才是 null"由 lib/__tests__/sensitive-exits.test.ts 钉
// （那边用真库真领域跑）。下面第一条把这两组之间的接缝显式验一次，
// 免得两组各自绿着、而中间那一跳其实断了。
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const { NO_REDACTION_NOTICE } = await import('@/app/s/[token]/page');
const { DEFAULT_DOMAIN, DOMAINS } = await import('@/lib/domains/registry');

const text = (html: string) => html.replace(/<[^>]+>/g, '');

/** 分享页是 server component：直接 await 它，再把返回的树渲成字符串。 */
async function sharePageHtml(view: Record<string, unknown>): Promise<string> {
  vi.resetModules();
  vi.doMock('@/lib/db/client', () => ({ getDb: () => ({}) }));
  vi.doMock('@/lib/shares', () => ({ readShare: () => ({ state: 'ok', view }) }));
  const { default: SharePage } = await import('@/app/s/[token]/page');
  return renderToStaticMarkup(<>{await SharePage({ params: Promise.resolve({ token: 't' }) })}</>);
}

const DRAFT_VIEW = {
  kind: 'draft',
  title: '一份文书',
  expires_at: '2026-09-10 00:00:00',
  body: '正文若干。',
  meta: null,
  redact_notice: null as string | null,
  ai_label: '不构成某种专业意见',
};

describe('接缝：哪一种领域会走到哪一臂', () => {
  it('缺省领域没有 sensitive 声明，counseling 有（变异：给缺省领域加一条 sensitive → 红）', () => {
    expect(
      DOMAINS[DEFAULT_DOMAIN].sensitive ?? null,
      '缺省领域声明了敏感级？那它的分享页就该走"已脱敏"那一臂，本组的第二臂要重写',
    ).toBeNull();
    expect(
      DOMAINS.counseling.sensitive?.redactNotice,
      '没有任何一个领域声明敏感级时，第一臂验的是一个不存在的场景',
    ).toBeTruthy();
  });
});

describe('第一臂：声明了敏感级的领域（redact_notice 非空）', () => {
  const NOTICE = DOMAINS.counseling.sensitive!.redactNotice;

  it('印的是领域自己那一句脱敏说明', async () => {
    const html = await sharePageHtml({ ...DRAFT_VIEW, redact_notice: NOTICE });
    expect(text(html)).toContain(NOTICE);
  });

  it('**不**印「未脱敏」那一句（变异：把两句改成恒印 → 红）', async () => {
    const html = await sharePageHtml({ ...DRAFT_VIEW, redact_notice: NOTICE });
    expect(
      text(html),
      '同一页上同时说"已脱敏"和"未脱敏"，读的人只能挑一句信',
    ).not.toContain(NO_REDACTION_NOTICE);
  });
});

describe('第二臂：没有 sensitive 声明的领域（redact_notice 为 null）', () => {
  it('正文之前印「本页内容未脱敏，按原样展示」（变异：把这一块删掉 → 红）', async () => {
    const html = await sharePageHtml(DRAFT_VIEW);
    expect(NO_REDACTION_NOTICE).toBe('本页内容未脱敏，按原样展示。');
    expect(text(html)).toContain(NO_REDACTION_NOTICE);
  });

  it('这句话排在正文**之前**（变异：挪到正文后面 → 红）', async () => {
    const html = await sharePageHtml(DRAFT_VIEW);
    const body = text(html);
    expect(body).toContain('正文若干。');
    expect(
      body.indexOf(NO_REDACTION_NOTICE),
      '排在正文后面的形态是：他读完整篇才知道刚才看的每个号码都是真的',
    ).toBeLessThan(body.indexOf('正文若干。'));
  });

  it('证据那一路（只有元数据、没有正文）同样说得清楚', async () => {
    const html = await sharePageHtml({
      ...DRAFT_VIEW,
      kind: 'evidence',
      body: null,
      ai_label: null,
      meta: { 分类: '解除文件', 文件哈希: 'abc' },
    });
    expect(text(html), '材料那一路的元数据里同样有真号码').toContain(NO_REDACTION_NOTICE);
  });

  it('对照臂：链接失效时不印任何一句（那时页面上没有内容可谈）', async () => {
    vi.resetModules();
    vi.doMock('@/lib/db/client', () => ({ getDb: () => ({}) }));
    vi.doMock('@/lib/shares', () => ({ readShare: () => ({ state: 'revoked' }) }));
    const { default: SharePage } = await import('@/app/s/[token]/page');
    const html = renderToStaticMarkup(
      <>{await SharePage({ params: Promise.resolve({ token: 't' }) })}</>,
    );
    expect(text(html)).toContain('已被收回');
    expect(
      text(html),
      '一条已经收回的链接不该再声称"本页内容未脱敏"——本页上没有内容',
    ).not.toContain(NO_REDACTION_NOTICE);
  });
});
