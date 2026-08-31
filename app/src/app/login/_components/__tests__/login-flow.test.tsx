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
 * 唯一够不着的一环：`setCompleting(true)` 这个 state 翻转本身。它翻不动就只能靠
 * 「need_email=true 时不跳走」这条反面判据兜住（跳走了立刻红），此处如实记下。
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

const { EmailChannel, LoginFlow } = await import('../LoginFlow');

const text = (html: string) => html.replace(/<[^>]+>/g, '');
const SOURCE = readFileSync(
  join(process.cwd(), 'src/app/login/_components/LoginFlow.tsx'),
  'utf8',
);

/** 取出所有 Tab 的文字。正则自己不作数——取空了下面的 toEqual 就红，不会假绿。 */
function tabLabels(html: string): string[] {
  return [...html.matchAll(/<(\w+)[^>]*data-slot="tabs-trigger"[^>]*>([\s\S]*?)<\/\1>/g)].map((m) =>
    text(m[2]).trim(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('登录第一屏', () => {
  it('🔴 手机与邮箱两个 Tab 都在，且就是这两个', () => {
    // 复审删掉的正是这一个：邮箱 Tab 没了，老用户就再也找不到「只用邮箱进」这条路。
    expect(tabLabels(renderToStaticMarkup(<LoginFlow />))).toEqual(['手机号', '邮箱']);
  });

  it('🔴 老用户这一屏没有两格进度条——登录是单因素，没有第二步可指', () => {
    const labels = ['手机验证', '邮箱验证'];
    // 量具自检：这两个词确实还写在源码里（在补绑那一步用），
    // 否则「渲染产物里找不到」就成了因为它压根不存在——守卫看着在守、其实什么也没守。
    for (const w of labels) expect(SOURCE, `源码里已经没有「${w}」，这条判据失去了对象`).toContain(w);
    for (const w of labels) expect(text(renderToStaticMarkup(<LoginFlow />))).not.toContain(w);
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
   */
  it('🔴 登录形态常驻那句解释：接口不说的，页面替真人说', () => {
    const { html } = render(false);
    const copy = text(html);
    expect(copy).toContain('没绑过的邮箱收不到码'); // 撞到的是什么
    expect(copy).toContain('手机号注册完成后那一步绑的'); // 为什么会撞到
    expect(copy).toContain('先用手机号登录一次绑上它'); // 现在能怎么办
  });
});
