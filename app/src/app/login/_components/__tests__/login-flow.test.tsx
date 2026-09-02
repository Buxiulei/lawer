/**
 * 登录第一屏的守卫。
 *
 * 【立这组的由头】单因素登录这次改造，**头号交付物整个没有判据**：
 * 复审时把邮箱那个 Tab 整块删掉，vitest 全绿、next build 也过——
 * 后端那 20 条判据一条都不动，因为它们只认 lib/auth，看不见页面上还有没有这个入口。
 * 「老用户能只用邮箱进」这件事，用户是在这一屏上看见的；这一屏没人盯，交付物就能无声消失。
 *
 * 【判据只用 renderToStaticMarkup（仓库既有的 7 处套路），够不着的地方说明白】
 * 测试环境是 node，没有 DOM，点不动、也驱动不了 LoginFlow 自己的 useState。
 * 所以：能静态渲染的（两个 Tab、进度条在不在、邮箱那格的文案）直接断言渲染产物；
 * 要交互才到得了的（手机验完往哪走），把 ChannelStep 的回调抓出来直接调，
 * 断言它对外做了什么（写没写 token、跳没跳走、请求带不带 token）——
 * 这三样正是「登录一共问了几样东西」在前端的全部落点。
 *
 * 够不着的两处 state 翻转，如实记下：
 *  · `setCompleting(true)`：靠「need_email=true 时不跳走」这条反面判据兜住（跳走了立刻红）。
 *  · `setChannel(...)`：两屏各自能独立渲染（LoginFlow 首屏 / EmailPane），
 *    但「点那条链真的会换屏」只剩源码里那两次赋值可盯，见「两条入口都真接在 channel 上」。
 *  · `setCompleting(false)`（补绑屏那条退路）同理：屏能独立渲染（CompletionPane），
 *    接线只剩源码那一次赋值可盯。引言接的是不是活的 channel，也是同一类源码锚点。
 *
 * 【这一版新增的守卫对象】手机号是主路、邮箱是次级入口。
 * 它整个是**视觉层级**上的交付物——把两屏合回并排 Tab、或把次级链改成实心主按钮，
 * 后端一条判据都不会响，登录照样能用，只有用户重新开始困惑。
 *
 * 【这一版补的两处】都属于"删掉也全绿"的既有缺口：
 *  · 引言那一句原先钉死在 page.tsx 上，邮箱那屏顶上仍写着"手机号验证码登录"；
 *  · 补绑屏（need_email=true）整屏无人看守——两格进度、说明段、「返回上一步」删掉全绿。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ChannelStepProps = React.ComponentProps<typeof import('../ChannelStep')['ChannelStep']>;

/** 每次渲染把 ChannelStep 收到的 props 按 fieldLabel 存下来，好在测试里直接调它的回调 */
const captured: Record<string, ChannelStepProps> = {};
const push = vi.fn();
const writeToken = vi.fn();
const apiFetch = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/app/_ui/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/_ui/auth')>()),
  writeToken: (token: string) => writeToken(token),
}));
vi.mock('@/app/_ui/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/_ui/api')>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
// 真的 ChannelStep 照常渲染（判据要看真产物），只是顺手把 props 记下来
vi.mock('../ChannelStep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ChannelStep')>();
  return {
    ChannelStep: (props: ChannelStepProps) => {
      captured[props.fieldLabel] = props;
      return createElement(actual.ChannelStep, props);
    },
  };
});

const { ChannelIntro, CompletionPane, EmailChannel, EmailPane, LoginFlow } =
  await import('../LoginFlow');
// 整页实渲。它只到得了页面装出来的**默认那一态**（手机号），别的态得各自渲染
const LoginPage = (await import('../../page')).default;

const text = (html: string) => html.replace(/<[^>]+>/g, '');
const SOURCE = readFileSync(
  join(process.cwd(), 'src/app/login/_components/LoginFlow.tsx'),
  'utf8',
);

/**
 * 取含指定文字的那个按钮的 class 词表。
 * 找不到按钮、或它没有 class，都当场红——不会因为正则取空而假绿。
 */
function buttonClasses(html: string, label: string): string[] {
  const hit = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find((m) =>
    text(m[2]).includes(label),
  );
  expect(hit, `渲染产物里根本没有「${label}」这个按钮`).toBeTruthy();
  const cls = /class="([^"]*)"/.exec(hit![1]);
  expect(cls, `「${label}」没有 class，样式判据无从谈起`).toBeTruthy();
  return cls![1].split(/\s+/).filter(Boolean);
}

/** Tailwind 的 h-N / min-h-N 折成 px（1 单位 = 4px），取这个元素上最大的那条。 */
function tapHeightPx(classes: string[]): number {
  const px = classes.flatMap((c) => {
    const m = /^(?:min-)?h-(\d+)$/.exec(c);
    return m ? [Number(m[1]) * 4] : [];
  });
  return px.length ? Math.max(...px) : 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  // captured 不是 mock，clearAllMocks 清不掉它；不手动清，
  // 「这一屏**没有**某一格」这类判据就会被上一个测试留下的残留喂成假绿。
  for (const key of Object.keys(captured)) delete captured[key];
});

describe('登录第一屏', () => {
  const first = () => renderToStaticMarkup(<LoginFlow />);

  it('🔴 首屏直接就是手机号表单：没有 Tab 条，也没有并排摆着的邮箱表单', () => {
    // 量具自检：Tabs 组件还在仓里（设置页仍在用），所以"渲染产物里没有它"
    // 说的是这一屏不用它，而不是这个标记压根已经不存在了。
    expect(
      readFileSync(join(process.cwd(), 'src/components/shadcn/tabs.tsx'), 'utf8'),
      'Tabs 组件没了，这条判据失去了对象',
    ).toContain('data-slot="tabs-trigger"');

    const html = first();
    expect(html, 'Tab 条回来了 = 又要求每个进来的人先替自己选一次通道').not.toContain(
      'data-slot="tabs-trigger"',
    );
    expect(captured['手机号'], '首屏该直出手机号那一格').toBeDefined();
    expect(captured['邮箱'], '邮箱表单不该跟手机号并排摆在首屏').toBeUndefined();
  });

  it('🔴 邮箱是次级入口：轻量文字链，但触区仍有 44px', () => {
    const cls = buttonClasses(first(), '用邮箱登录');
    expect(cls, '次级入口不该长成实心按钮').toContain('bg-transparent');
    expect(cls, 'variant=primary 的实心底 = 跟主 CTA 抢眼').not.toContain('bg-primary');
    expect(cls, '铺满一行就跟主 CTA 同级了').not.toContain('w-full');
    expect(
      tapHeightPx(cls),
      '样子可以轻，点区不能跟着轻（DESIGN.md：触屏目标 ≥44px）',
    ).toBeGreaterThanOrEqual(44);
  });

  it('🔴 首屏一个字都不预告"还要再验邮箱"', () => {
    // 补绑是**新号注册那一次**才走的支路。预先摆在首屏上，
    // 等于让所有人先替那批人担一次心——「原来要验两样」正是这句造成的误解。
    const copy = text(renderToStaticMarkup(<LoginPage />));
    expect(copy, '渲染空了的话下面那串"都没有"全是假绿').toContain('手机号验证码登录');
    for (const w of ['绑邮箱', '邮箱验证', '多一步', '两步', '同时']) {
      expect(copy, `首屏又开始预告第二步了：「${w}」`).not.toContain(w);
    }
  });

  it('🔴 老用户这一屏没有两格进度条——登录是单因素，没有第二步可指', () => {
    const labels = ['手机验证', '邮箱验证'];
    // 量具自检：这两个词确实还写在源码里（在补绑那一步用），
    // 否则「渲染产物里找不到」就成了因为它压根不存在——守卫看着在守、其实什么也没守。
    for (const w of labels) expect(SOURCE, `源码里已经没有「${w}」，这条判据失去了对象`).toContain(w);
    for (const w of labels) expect(text(renderToStaticMarkup(<LoginFlow />))).not.toContain(w);
  });
});

/**
 * 引言那一句。它原先钉在 page.tsx（无状态服务端组件）上写死"手机号验证码登录"，
 * 点进邮箱那屏之后不跟着换：顶上一句和下面的表单说的是两码事。
 * 这类错位**不会让任何东西坏掉**——页面照常能登录，只有用户读到两个互相矛盾的说法。
 */
describe('引言跟着通道走', () => {
  const intro = (channel: 'phone' | 'email') =>
    text(renderToStaticMarkup(<ChannelIntro channel={channel} />));

  it('🔴 手机态：手机号验证码登录', () => {
    expect(intro('phone')).toContain('手机号验证码登录，大约半分钟。');
    expect(intro('phone'), '手机那屏读到的是邮箱的说法').not.toContain('邮箱验证码登录');
  });

  it('🔴 邮箱态：邮箱验证码登录', () => {
    expect(intro('email')).toContain('邮箱验证码登录，大约半分钟。');
    expect(
      intro('email'),
      '邮箱那屏顶上还写着"手机号验证码登录"，跟下面的邮箱表单对不上',
    ).not.toContain('手机号验证码登录');
  });

  it('🔴 首屏实渲就是手机那一句，且引言真接在 channel 上（不是死值）', () => {
    expect(
      text(renderToStaticMarkup(<LoginPage />)),
      '整页渲染里根本没有引言 = 上面两条测的是个没人用的组件',
    ).toContain('手机号验证码登录，大约半分钟。');
    // 渲染判据够不着"换了通道真的会换句子"这一处（node 环境驱动不了 channel）。
    // 把它写死成 <ChannelIntro channel="phone" /> 时，上面两条照样全绿，只有这里会响。
    expect(SOURCE, '引言写死了通道，换屏也不会跟着变').toContain(
      '<ChannelIntro channel={channel} />',
    );
  });
});

describe('点开那条次级入口之后', () => {
  const pane = () =>
    renderToStaticMarkup(
      <EmailPane email="laoyuan@example.com" onEmailChange={() => {}} agreed onBack={() => {}} />,
    );

  it('🔴 邮箱那一屏：邮箱表单 + 顶上一行回手机号', () => {
    const html = pane();
    expect(captured['邮箱'], '点进来该看见邮箱那一格').toBeDefined();
    expect(captured['手机号'], '换了通道就不该还摆着手机号表单').toBeUndefined();
    // 少了这一行，误点进来的人就被关在邮箱这屏里出不去——而那是一处静默失效
    const back = buttonClasses(html, '用手机号登录');
    expect(tapHeightPx(back), '返回也得是 44px 触区').toBeGreaterThanOrEqual(44);
  });

  it('🔴 两条入口都真接在 channel 上，不是摆设', () => {
    // 渲染判据够不着这一处：node 环境点不动，也驱动不了 LoginFlow 自己的 useState。
    // 接线被拆掉（onClick 变成空函数 / 整个删掉）时，源码里这两次赋值是唯一会响的地方。
    expect(SOURCE, '首屏那条链没接去邮箱').toContain("setChannel('email')");
    expect(SOURCE, '邮箱那屏没有回手机号的路').toContain("setChannel('phone')");
  });
});

describe('手机验完之后的去向', () => {
  const phoneStep = () => {
    renderToStaticMarkup(<LoginFlow />);
    return captured['手机号'];
  };

  it('🔴 need_email=false（老用户）：一步进站，不再问邮箱', async () => {
    apiFetch.mockResolvedValueOnce({ token: 'tok-lao', need_email: false });
    await phoneStep().onVerify('123456');

    expect(apiFetch).toHaveBeenCalledWith('/auth/sms/verify', expect.objectContaining({ auth: false }));
    expect(writeToken).toHaveBeenCalledWith('tok-lao');
    expect(push, '老用户验完手机就该进站，不该再被拦一步').toHaveBeenCalledWith('/welcome');
  });

  it('🔴 need_email=true（新号注册）：不进站，停在补绑邮箱那一步', async () => {
    apiFetch.mockResolvedValueOnce({ token: 'tok-xin', need_email: true });
    await phoneStep().onVerify('123456');

    expect(writeToken).toHaveBeenCalledWith('tok-xin');
    // 邮箱是换手机号后找回账号的唯一落点，这一步不能被跳过：一跳走就等于绕过了它
    expect(push, 'need_email=true 还直接进站 = 注册没走完就放人进来').not.toHaveBeenCalled();
  });
});

/**
 * 补绑邮箱那一屏（need_email=true，新号注册那一次才走到）。
 *
 * 【为什么补这一组】这一屏此前整个没人看守：复审时把两格进度、那段说明、
 * 「返回上一步」各删一次，vitest / tsc / build 三样全绿——`completing` 在 node 环境里
 * 驱动不了，判据根本渲染不到这一屏。三样东西的失效形态都是静默的：删掉页面照常能用，
 * 只有走到这一步的新用户不知道自己在哪、凭什么还要交一个邮箱、以及怎么退回去。
 * 抽成能独立渲染的组件（照 EmailPane 的做法）之后，下面三条各钉一样。
 */
describe('补绑邮箱那一屏（新号注册那一次）', () => {
  const html = () =>
    renderToStaticMarkup(
      <CompletionPane email="xin@example.com" onEmailChange={() => {}} agreed onBack={() => {}} />,
    );

  it('🔴 两格进度还在：手机验证（已完成）→ 邮箱验证（当前这一格）', () => {
    const copy = text(html());
    expect(copy, '删了进度条，走到这一步的人不知道自己在哪、还剩几步').toContain('手机验证');
    expect(copy, '删了进度条，走到这一步的人不知道自己在哪、还剩几步').toContain('邮箱验证');
    expect([...html().matchAll(/<li\b/g)].length, '两格，不多不少').toBe(2);
    expect(copy, '第一格没打勾 = 看着像刚验过的手机白验了').toContain('✓');
  });

  it('🔴 那段说明还在：凭什么还要一个邮箱，以及只这一次', () => {
    const copy = text(html());
    expect(copy, '删了说明，新号注册就成了"莫名其妙又被要一样东西"').toContain('还差一个邮箱');
    expect(copy, '「只这一次」没了，看着就像从此每次登录都要验两样').toContain('只这一次');
  });

  it('🔴 退路还在：「返回上一步」，44px 触区，且真接回 completing', () => {
    // buttonClasses 找不到这个按钮当场红——"删掉那条链"正是这个形态
    const cls = buttonClasses(html(), '返回上一步');
    expect(
      tapHeightPx(cls),
      '退路也得是 44px 触区（DESIGN.md：触屏目标 ≥44px）',
    ).toBeGreaterThanOrEqual(44);
    // 渲染判据够不着接线（node 环境点不动）：拆掉时源码里这次赋值是唯一会响的地方
    expect(SOURCE, '「返回上一步」没接回 completing，点了没反应').toContain('setCompleting(false)');
  });
});

describe('邮箱那一格', () => {
  const render = (completing: boolean) => {
    const html = renderToStaticMarkup(
      <EmailChannel
        completing={completing}
        email="laoyuan@example.com"
        onEmailChange={() => {}}
        agreed
      />,
    );
    return { html, props: captured['邮箱'] };
  };

  it('🔴 登录形态：两个请求都不带 token——邮箱是独立入口，不是手机验完的第二因子', async () => {
    const { props } = render(false);

    apiFetch.mockResolvedValueOnce({ ttl_seconds: 300, retry_after: 60 });
    await props.onSend();
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/auth/email/send',
      expect.objectContaining({ auth: false }),
    );

    apiFetch.mockResolvedValueOnce({ token: 'tok-mail' });
    await props.onVerify('123456');
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/auth/email/verify',
      expect.objectContaining({ auth: false }),
    );
    expect(writeToken).toHaveBeenCalledWith('tok-mail');
    expect(push).toHaveBeenCalledWith('/welcome');
  });

  it('🔴 补绑形态：两个请求都带 token——要说清楚是"给哪个号绑"', async () => {
    const { props } = render(true);

    apiFetch.mockResolvedValueOnce({ ttl_seconds: 300, retry_after: 60 });
    await props.onSend();
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/auth/email/send',
      expect.objectContaining({ auth: true }),
    );

    apiFetch.mockResolvedValueOnce({ token: 'tok-bang' });
    await props.onVerify('123456');
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/auth/email/verify',
      expect.objectContaining({ auth: true }),
    );
  });

  /**
   * 后端对「这个邮箱注册过没有」一个字都不说（否则接口就是注册状态探针，
   * 见 lib/auth 的「邮箱通道不是注册状态探针」那组）。代价是打错字的人拿不到错误码，
   * 所以那份解释必须常驻在页面上——它是这条隐私决定的**配套**，不是可有可无的文案。
   * 但它也只能说到「该怎么办」为止：多说一句"这个邮箱有没有账号"，
   * 后端守住的东西就从文案上漏出去了。
   */
  it('🔴 登录形态常驻那句解释：接口不说的页面替真人说，接口不说的也不替它说', () => {
    const { html } = render(false);
    const copy = text(html);
    expect(copy).toContain('验证码发到这个邮箱'); // 码去了哪
    expect(copy).toContain('先用手机号登录'); // 没收到能怎么办
    for (const w of ['注册过', '已注册', '未注册']) {
      expect(copy, `这句话把"这个邮箱有没有账号"说出去了：「${w}」`).not.toContain(w);
    }
  });
});
