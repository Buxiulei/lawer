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
const { AI_LABELING_TERMS_HREF, AI_LABELING_TERMS_LINK_TEXT, AI_LABELING_TERMS_TITLE } =
  await import('@/app/_ui/aiLabelingTerms');
const { AI_NOTICE_STICKY_CLASS } = await import('@/app/_ui/AiGeneratedNotice');
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

describe('生成合成内容标识规范说明那一页（标识办法 §8）', () => {
  /** 那一页渲成的纯文本（server component，直接当函数推） */
  async function termsText(): Promise<string> {
    const { default: TermsPage } = await import('@/app/terms/ai-labeling/page');
    return text(ssr(<TermsPage />));
  }

  it('那一页说清了方法与样式，并给出样例', async () => {
    const body = await termsText();
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

  /**
   * 【自称必须与事实一致】这条判据换过一次口径，换的理由本身就是它要守的东西：
   *
   * 2026-09-07 之前，协议还没起草，这一页写着「本平台的用户服务协议尚未起草」，
   * 标题也带着「（用户服务协议起草后并入）」——那时那是实话，本条钉的就是那句实话。
   * /terms 上线之后，同一句话变成**一句过期的实话**：读的人据它以为没有协议，
   * 于是不会去找那一份，而 §8 要的"在用户服务协议中明确说明"看起来仍然没落地。
   *
   * 所以现在钉的是新的事实：这一页自称是协议第四条的组成部分，**且给得出一条能点过去的路**。
   * 只改文案不给链接的形态是：页面上说"它是协议的一部分"，而那份协议在这一页上找不到。
   *
   * 【变异臂】把「第四条的组成部分」那句删掉 ⇒ 红；把指向 /terms 的链接删掉 ⇒ 红；
   * 把标题改回带括号的旧自称 ⇒ 红（旧自称里那半句现在是假的）。
   */
  it('自称是协议第四条的组成部分，且指得过去（变异：删掉那句或那条链接 → 红）', async () => {
    const { TERMS_HREF, TERMS_TITLE } = await import('@/app/_ui/termsLinks');
    const { default: TermsPage } = await import('@/app/terms/ai-labeling/page');
    const html = ssr(<TermsPage />);
    const body = text(html);
    expect(AI_LABELING_TERMS_TITLE).toContain('规范说明');
    expect(AI_LABELING_TERMS_TITLE, '协议已经在线，标题里不该再说它"起草后并入"').not.toContain(
      '起草后并入',
    );
    expect(body, '页面标题没用那个自称').toContain(AI_LABELING_TERMS_TITLE);
    expect(body, '正文里没说清它与协议的关系').toContain('第四条的组成部分');
    expect(body, '正文里还留着"协议尚未起草"这句过期的话').not.toContain('用户服务协议尚未起草');
    expect(html, '说是协议的一部分，却没有一条能点到协议的链接').toContain(
      `href="${TERMS_HREF}"`,
    );
    expect(body).toContain(TERMS_TITLE);
    // 链接文案与标题一致：两处对不上时，点进来的人会以为走错了页
    expect(AI_LABELING_TERMS_TITLE.startsWith(AI_LABELING_TERMS_LINK_TEXT)).toBe(true);
  });

  /**
   * 【适用链条】§4 只说"属于深度合成规定 §17 第一款情形的"要加标识，
   * 到底哪一种服务属于那一款写在**另一份**规章里。只引 §4 的形态是：
   * 读的人无从判断我们是不是那一款，而我们自己也就无从被质疑。
   * 引文与原件的逐字关系另有一组判据（ai-labeling-quotes.test.ts）。
   */
  it('写出了两跳的适用链条（变异：把深度合成那一节删掉 → 红）', async () => {
    const body = await termsText();
    expect(body).toContain('《互联网信息服务深度合成管理规定》');
    expect(body).toContain('第十七条第一款');
    expect(body, '没说清我们落在哪一项上').toContain('智能对话、智能写作');
    expect(body, '隐式标识那一跳（§5 → 深度合成 §16）没写').toContain('第十六条');
  });

  /**
   * 【措辞与实现要对得上】这一页向用户承诺对话界面那条提示「不随对话滚走」。
   * 实现成一个普通块的形态是：聊过三五轮它已经滚出屏幕，而这句承诺还印在页面上，
   * 两边都不报错。所以把承诺与那个定位常量钉在一起。
   *
   * 【变异臂】把 AI_NOTICE_STICKY_CLASS 里的 sticky 去掉 ⇒ 红；
   * 把页面上「不随对话滚走」改掉而实现不动 ⇒ 也红。
   */
  it('「不随对话滚走」这句承诺背后真有 sticky（变异：删掉 sticky → 红）', async () => {
    const body = await termsText();
    expect(body, '页面没有向用户承诺它持续可见').toContain('不随对话滚走');
    expect(
      AI_NOTICE_STICKY_CLASS.split(/\s+/),
      '页面承诺了不随对话滚走，实现却不是 sticky',
    ).toContain('sticky');
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

/* ── ⑤ 另外两处整段模型输出 ─────────────────────────────── */

/**
 * 【为什么这两页要单独钉】它们与对话页、文书页一样是**整段模型输出**，
 * 却不在最初那四处的清单里：个案报告页的 rendered_md 从第一个字到最后一个字都是
 * agent 写的；文件解读页那张四态大卡（签/不签 + 理由 + 逐条改签要点）也是。
 * 漏掉的形态是它们照常渲染、看不出少了什么——只有法条上缺一块。
 *
 * 首帧问不到领域（useCaseDomain 在 SSR 那一遍恒回空串），所以这里只验
 * **法定那半句在不在**；后半截随领域变，由 page-copy-by-domain 那一组按渲染产物验。
 */
describe('个案报告页与文件解读页的显式标识（标识办法 §4）', () => {
  const REPORT = {
    version: 3,
    updated_at: '2026-09-01 10:00:00',
    updated_by: 'agent:7',
    rendered_md: '## 争议焦点\n\n这里是整理过的长期记忆。',
    stale: { state: null, since: null, changes: 0, detail: '' },
  } as const;

  it('个案报告页画了标识（变异：把 <CaseAiGeneratedNotice/> 删掉 → 红）', async () => {
    const { ReportBody } = await import(
      '@/app/(app)/case/[id]/report/_components/CaseReportLoader'
    );
    const html = ssr(<ReportBody caseId="7" report={{ ...REPORT }} word="个案报告" />);
    expect(text(html), '报告正文没画出来，下面在验空页').toContain('整理过的长期记忆');
    expect(text(html)).toContain(AI_GENERATED_LABEL);
  });

  it('文件解读页那张建议卡画了标识（变异：把它删掉 → 红）', async () => {
    const { AdviceCard } = await import('@/app/(app)/case/[id]/docs/_components/AdviceCard');
    const html = ssr(
      <AdviceCard caseId="7" advice="不签" detail="这一条把竞业范围写成了全行业。" />,
    );
    expect(text(html), '建议段没画出来，下面在验空卡').toContain('竞业范围');
    expect(text(html)).toContain(AI_GENERATED_LABEL);
  });

  /**
   * 【糊层不许罩住法定那半句】这张卡的正文整块挂着 data-veil（里面全是公司名与金额）。
   * 把标识放进那一块的形态是：开着低调模式的人连「以下内容由人工智能生成合成」
   * 也读不到，而 §4 要的正是"可以被用户明显感知到"。
   *
   * 【变异臂】把 <CaseAiGeneratedNotice/> 挪回 `<div data-veil>` 里面 ⇒ 这条红。
   */
  it('建议卡的标识在糊块之外（变异：把它挪进 data-veil 那一块 → 红）', async () => {
    const { AdviceCard } = await import('@/app/(app)/case/[id]/docs/_components/AdviceCard');
    const html = ssr(
      <AdviceCard caseId="7" advice="不签" detail="这一条把竞业范围写成了全行业。" />,
    );
    const body = veiledDivHtml(html);
    // 自证取到的确实是卡正文那一块（否则下面那条在空过）
    expect(body, '没取到正文糊块，验不出"标识在糊块外"').toContain('竞业范围');
    expect(
      body,
      '法定那半句落在正文糊块里：`filter: blur` 罩整棵子树，开着低调模式的人读不到它，' +
        '而 §4 要的正是"可以被用户明显感知到"。把它挪到那一块外面（后半截自己进糊层）。',
    ).not.toContain(AI_GENERATED_LABEL);
    // 卡上确实有标识，只是不在糊块里——否则"不在里面"是因为压根没有
    expect(text(html)).toContain(AI_GENERATED_LABEL);
  });
});

/**
 * 第一个 `<div … data-veil="">` 的内层 HTML（含它自己的开合标签）。
 *
 * 【为什么要数层，不能用 indexOf 凑合】`labelAt > veilStart` 在"嵌在里面"与
 * "排在后面"两种情形下都为真——那条断言无论怎么改代码都绿。
 * 数 `<div`/`</div>` 才分得开这两件事。
 */
function veiledDivHtml(html: string): string {
  const attr = html.indexOf('data-veil=""');
  if (attr < 0) return '';
  const start = html.lastIndexOf('<div', attr);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < html.length; ) {
    const open = html.indexOf('<div', i);
    const close = html.indexOf('</div>', i);
    if (close < 0) break;
    if (open >= 0 && open < close) {
      depth += 1;
      i = open + 4;
    } else {
      depth -= 1;
      if (depth === 0) return html.slice(start, close + 6);
      i = close + 6;
    }
  }
  return html.slice(start);
}
