// app/src/app/__tests__/ai-labeling.test.tsx
// 生成合成内容标识在**页面这一侧**的四件事：
//   ① 标识件本身的样式（§4：一句可被明显感知的提示；低调模式糊的是后半截，不是整句）
//   ② 免登录分享页真的把它画出来了（§4；证据那一路不画）
//   ③ 隐式标识的三要素齐（§5）
//   ④ §8 那一页存在、说清了方法与样式、且注册处够得着
//
// 【为什么 ①②③④ 分开钉】它们全都能单独坏，而且坏了都不报错：
// 标识件在但没人用它、分享页画了但拿的是空串、元数据少一项、协议页写了但没有入口。
// 合成一条判据的形态是：某一件坏掉时判据仍然绿，因为另外三件还好着。
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// 登录页里那个表单是客户端件、要 app router；本组验的是页脚那条链接，跟路由无关。
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/login',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const { AiGeneratedNotice } = await import('@/app/_ui/AiGeneratedNotice');
const {
  AI_GENERATED_LABEL,
  AI_LABEL_ATTRIBUTE,
  AI_LABEL_PROVIDER,
  aiLabelPdfMeta,
} = await import('@/lib/ai-label');
const { AI_LABELING_TERMS_HREF, AI_LABELING_TERMS_LINK_TEXT } = await import(
  '@/app/_ui/aiLabelingTerms'
);
const { DOMAINS } = await import('@/lib/domains/registry');

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) => html.replace(/<[^>]+>/g, '');

/* ── ① 标识件本身 ─────────────────────────────────────────── */

describe('显式标识的样式（标识办法 §4 第（一）项）', () => {
  it('法定那半句逐字在（变异：把 AI_GENERATED_LABEL 改掉不同步 → 红）', () => {
    expect(text(ssr(<AiGeneratedNotice disclaimer="不构成某种专业意见" />))).toContain(
      AI_GENERATED_LABEL,
    );
  });

  it('后半截原样跟在后面，不被吞掉', () => {
    expect(text(ssr(<AiGeneratedNotice disclaimer="不构成某种专业意见" />))).toContain(
      `${AI_GENERATED_LABEL}，不构成某种专业意见。`,
    );
  });

  it('后半截给空串时只出法定那半句，不兜一句自己编的行当话', () => {
    expect(text(ssr(<AiGeneratedNotice disclaimer="" />))).toBe(`${AI_GENERATED_LABEL}。`);
  });

  /**
   * 低调模式（DESIGN.md RISK 1）把带 data-veil 的块整体糊起来。
   * 整句都挂 data-veil 的形态是：开着低调模式的人**读不到**这句提示，
   * 而 §4 要的正是"可以被用户明显感知到"——两条政策在同一个元素上打架，
   * 只能是"带行当的那半截进糊层、法定那半句不进"。
   */
  it('糊层只罩后半截：法定那半句不在 data-veil 里（变异：把 data-veil 挪到外层 <p> → 红）', () => {
    const html = ssr(<AiGeneratedNotice disclaimer="不构成某种专业意见" />);
    const veiled = html.slice(html.indexOf('data-veil'));
    expect(veiled, '带行当的那半截没进糊层').toContain('不构成某种专业意见');
    expect(html.slice(0, html.indexOf('data-veil')), '法定那半句被糊层罩住了').toContain(
      AI_GENERATED_LABEL,
    );
  });
});

describe('每个领域都要有自己那半句（标识办法 §4 + 律师法 §13）', () => {
  /**
   * 【为什么这一条不能只靠 page-copy-by-domain】那份判据把"两个包写同一句"当成
   * 同字面的键放行（「说一句就行。」那种确实该一样）。而这一个键不一样：
   * 后半截说的就是"这个行当里最容易被误当成的那种专业意见"，两个行当抄同一句，
   * 意味着其中一个包在对它的用户说另一个行当的话——页面照常渲染、闸也不响。
   * 抄错的方向还特别危险：把「不构成律师意见」抄进一个不做法律服务的行当，
   * 那句话既没有意义、又把执业身份的话题带了进来（律师法 §13 的语境）。
   */
  it('每个领域都写了，且互不相同（变异：把一个包的这半句抄成另一个包的 → 红）', () => {
    const said = Object.entries(DOMAINS).map(([key, pack]) => {
      const line = pack.copy.pages.aiLabelDisclaimer;
      expect(line, `${key} 的 copy.pages 缺 aiLabelDisclaimer`).toBeTruthy();
      return [key, line] as const;
    });
    expect(said.length, '只有一个领域时这条验不出东西').toBeGreaterThan(1);
    expect(
      new Set(said.map(([, line]) => line)).size,
      `这几个领域说的是同一句话：${JSON.stringify(said)}`,
    ).toBe(said.length);
  });
});

/* ── ② 免登录分享页 ───────────────────────────────────────── */

describe('免登录分享页上的显式标识（标识办法 §4）', () => {
  /** 分享页是 server component：直接 await 它，再把返回的树渲成字符串。 */
  async function sharePageHtml(view: Record<string, unknown> | null): Promise<string> {
    vi.resetModules();
    vi.doMock('@/lib/db/client', () => ({ getDb: () => ({}) }));
    vi.doMock('@/lib/shares', () => ({
      readShare: () => (view ? { state: 'ok', view } : { state: 'not_found' }),
    }));
    const { default: SharePage } = await import('@/app/s/[token]/page');
    return renderToStaticMarkup(<>{await SharePage({ params: Promise.resolve({ token: 't' }) })}</>);
  }

  const DRAFT_VIEW = {
    kind: 'draft',
    title: '一份文书',
    expires_at: '2026-09-10 00:00:00',
    body: '正文若干。',
    meta: null,
    redact_notice: null,
    ai_label: '不构成某种专业意见',
  };

  it('文书分享页把标识画出来（变异：把那一块删掉 → 红）', async () => {
    const html = await sharePageHtml(DRAFT_VIEW);
    expect(text(html), '分享页上的正文没画出来，下面在验空页').toContain('正文若干。');
    expect(text(html)).toContain(`${AI_GENERATED_LABEL}，不构成某种专业意见。`);
  });

  it('ai_label 为 null 的那一路整块不画（变异：改成恒画 → 红）', async () => {
    const html = await sharePageHtml({ ...DRAFT_VIEW, body: null, ai_label: null, meta: {} });
    expect(text(html), '一份不含生成合成内容的分享被标成了 AI 生成').not.toContain(
      AI_GENERATED_LABEL,
    );
  });
});

/* ── ③ 隐式标识 ───────────────────────────────────────────── */

describe('隐式标识的三要素（标识办法 §5）', () => {
  it('属性 / 服务提供者 / 内容编号各就各位', () => {
    const meta = aiLabelPdfMeta('draft:7@v2');
    expect(meta.subject).toContain(AI_LABEL_ATTRIBUTE);
    expect(meta.producer).toBe(AI_LABEL_PROVIDER);
    expect(meta.keywords).toContain('draft:7@v2');
  });

  it('服务提供者写的是运营主体全称，不是只有品牌名（对得上出证证书的 CN）', () => {
    expect(AI_LABEL_PROVIDER).toContain('北京天开艾洛迪心理咨询有限公司');
  });

  it('内容编号缺失就抛，不悄悄发一份缺要素的隐式标识（变异：把那句 throw 删掉 → 红）', () => {
    expect(() => aiLabelPdfMeta('')).toThrow();
    expect(() => aiLabelPdfMeta('   ')).toThrow();
  });
});

/* ── ④ 用户服务协议里的标识条款 ───────────────────────────── */

describe('用户服务协议的标识条款（标识办法 §8）', () => {
  it('那一页说清了方法与样式，并给出样例', async () => {
    const { default: TermsPage } = await import('@/app/terms/ai-labeling/page');
    const body = text(ssr(<TermsPage />));
    // §8 要的「方法、样式」：显式怎么加、隐式加在哪、样例长什么样
    expect(body).toContain('第四条');
    expect(body).toContain('第五条');
    expect(body).toContain('第八条');
    expect(body, '样例没摆出来，"样式"这一半是空的').toContain(AI_GENERATED_LABEL);
    expect(body, '隐式标识写了哪几项没说').toContain(AI_LABEL_PROVIDER);
    // §8 后半句：提示用户仔细阅读并理解标识管理要求（§10 的义务与禁止行为）
    expect(body).toContain('仔细阅读');
    expect(body).toContain('不得恶意删除、篡改、伪造、隐匿');
  });

  it('注册处够得着：登录页有一条指过去的链接（变异：删掉那条链接 → 红）', async () => {
    const { default: LoginPage } = await import('@/app/login/page');
    const html = ssr(<LoginPage />);
    expect(html).toContain(`href="${AI_LABELING_TERMS_HREF}"`);
    expect(text(html)).toContain(AI_LABELING_TERMS_LINK_TEXT);
  });

  it('首页页脚也有（没登录的人也读得到）', async () => {
    const { default: HomePage } = await import('@/app/page');
    expect(ssr(<HomePage />)).toContain(`href="${AI_LABELING_TERMS_HREF}"`);
  });
});
