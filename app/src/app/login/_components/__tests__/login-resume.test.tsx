/**
 * 登录半程被打断之后（F5 / 退回来）还在不在原地，以及按钮为什么是灰的。
 *
 * 【立这组的由头】三个小白连着两次撞上同一处：
 *  · 在验证码那一格按 F5 → **静默退回手机号那一格**。短信已经发出去了，眼前却没有能填码的格子；
 *    照着直觉立刻重发，撞上后端限流「发送太频繁，60 秒后再试」，只能干等。
 *    补绑邮箱那一步同样：token 已经写进 localStorage 了，人却被打回登录第一格。
 *  · 手机号少打一位时，唯一的提示是「先勾选下方的说明，再发送验证码」——
 *    照着勾了，按钮还是灰的。唯一那句话把人指到了错的地方。
 *
 * 【判据只用 renderToStaticMarkup】测试环境是 node，没有 DOM（仓库既有套路）。
 * 半程恢复必须发生在**首帧的渲染里**才验得到，这跟产品要求正好是同一件事：
 * 挪进 useEffect 就得先渲染一帧手机号格再跳回来，而"闪一下"跟"掉回去"在用户眼里没区别。
 * 够不着的一处如实记下：**写**半程记录靠 useEffect（node 环境不跑），
 * 所以这里钉的是「写入口只有一个」这条源码锚点 + 存取本身的往返判据。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ChannelStepProps = React.ComponentProps<typeof import('../ChannelStep')['ChannelStep']>;

const captured: Record<string, ChannelStepProps> = {};
const push = vi.fn();
const apiFetch = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
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

const { ChannelStep } = await import('../ChannelStep');
const { EmailChannel, LoginFlow } = await import('../LoginFlow');
const { LOGIN_STEP_KEY, loadLoginStep, saveLoginStep } = await import('../loginStep');
type LoginStep = Awaited<ReturnType<typeof loadLoginStep>>;

const LOGIN = join(process.cwd(), 'src/app/login/_components');
const CHANNEL_STEP_SRC = readFileSync(join(LOGIN, 'ChannelStep.tsx'), 'utf8');
const LOGIN_FLOW_SRC = readFileSync(join(LOGIN, 'LoginFlow.tsx'), 'utf8');

const text = (html: string) =>
  html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '');
const countOf = (src: string, needle: string) => src.split(needle).length - 1;

/** localStorage 关浏览器还在，sessionStorage 关标签页就没——两个都建，好让"存错地方"验得出来 */
function installStorage() {
  const local = new Map<string, string>();
  let session = new Map<string, string>();
  const face = (m: () => Map<string, string>) => ({
    getItem: (k: string) => m().get(k) ?? null,
    setItem: (k: string, v: string) => void m().set(k, v),
    removeItem: (k: string) => void m().delete(k),
    clear: () => m().clear(),
  });
  vi.stubGlobal('localStorage', face(() => local));
  vi.stubGlobal('sessionStorage', face(() => session));
  /** 模拟另开一个标签页：sessionStorage 空的，localStorage 留着 */
  return () => {
    session = new Map();
  };
}

let reopenTab: () => void;

beforeEach(() => {
  reopenTab = installStorage();
  vi.clearAllMocks();
  // captured 不是 mock，clearAllMocks 清不掉；不手动清，"这一屏没有某一格"会被上一个测试喂成假绿
  for (const key of Object.keys(captured)) delete captured[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const flow = () => renderToStaticMarkup(<LoginFlow />);

describe('刷新之后还停在原来那一格', () => {
  it('🔴 量具自检：没有半程记录时（第一次进来）照旧是手机号那一格', () => {
    expect(flow(), '首屏都不是手机号格的话，下面那串"不该掉回手机号格"全是假绿').toContain(
      '11 位手机号',
    );
  });

  it('🔴 码已发出：首帧就是验证码格，不是手机号格', () => {
    saveLoginStep({
      channel: 'phone',
      step: 'code',
      target: '13800001111',
      expiresAt: Date.now() + 45_000,
    });

    const html = flow();
    expect(text(html), '掉回手机号格 = 短信已经发出去了，眼前却没有能填码的格子').toContain(
      '输入 6 位验证码',
    );
    expect(text(html), '码发给了谁也得说清楚，否则不知道该看哪个手机').toContain(
      '已发送至 138****1111',
    );
    expect(html, '手机号那一格还在 = 人被退回去了，重发还要再等 60 秒').not.toContain(
      '11 位手机号',
    );
  });

  it('🔴 倒计时按截止时刻续算，不是回来重新数 60 秒', () => {
    saveLoginStep({
      channel: 'phone',
      step: 'code',
      target: '13800001111',
      expiresAt: Date.now() + 45_000,
    });

    // 存剩余秒数（或干脆重置成 OTP_RESEND_SECONDS）的话这里是 60——
    // 那等于刷一次页面就把限流窗口凭空拉长一倍，用户白等
    expect(text(flow())).toMatch(/4[45] 秒后可重发/);
  });

  it('🔴 截止时刻已经过去：立刻就能重发，不再摆一个假的倒计时', () => {
    saveLoginStep({
      channel: 'phone',
      step: 'code',
      target: '13800001111',
      expiresAt: Date.now() - 5_000,
    });

    const copy = text(flow());
    expect(copy).toContain('重新发送');
    expect(copy, '过期的截止时刻算出了负数倒计时').not.toMatch(/秒后可重发/);
  });

  it('🔴 补绑邮箱那一步：刷新后仍停在补绑，不被打回登录第一格', () => {
    saveLoginStep({ channel: 'completion', step: 'entry', target: '', expiresAt: 0 });

    const html = flow();
    const copy = text(html);
    expect(copy, '两格进度没了 = 不知道自己在哪一步').toContain('手机验证');
    expect(copy).toContain('邮箱验证');
    expect(copy, '那段说明没了 = 莫名其妙又被要一样东西').toContain('还差一个邮箱');
    expect(html, 'token 已经在手上了，人却被打回登录第一格重来一遍').not.toContain(
      '11 位手机号',
    );
  });

  it('🔴 补绑那一步的码也发出去了：验证码格 + 两格进度都还在', () => {
    saveLoginStep({
      channel: 'completion',
      step: 'code',
      target: 'xin@example.com',
      expiresAt: Date.now() + 30_000,
    });

    const copy = text(flow());
    expect(copy).toContain('输入 6 位验证码');
    expect(copy).toContain('已发送至 xi*@example.com');
    expect(copy, '回到补绑的码格却丢了进度条，等于不知道这是登录的哪一步').toContain('手机验证');
  });

  it('🔴 邮箱通道也一样接得上（次级入口进来的那条路）', () => {
    saveLoginStep({
      channel: 'email',
      step: 'code',
      target: 'laoyuan@example.com',
      expiresAt: Date.now() + 30_000,
    });

    const copy = text(flow());
    expect(copy).toContain('已发送至 la*****@example.com');
    expect(copy, '邮箱那条路刷新后掉回手机号主路 = 换了个人的账号在登录').not.toContain(
      '手机号验证码登录',
    );
  });
});

describe('半程记录存在哪儿', () => {
  const sample: NonNullable<LoginStep> = {
    channel: 'phone',
    step: 'code',
    target: '13800001111',
    expiresAt: 1_800_000_000_000,
  };

  it('🔴 存 sessionStorage 不是 localStorage：关掉标签页就该没', () => {
    saveLoginStep(sample);
    expect(loadLoginStep(), '存进去读不出来').toEqual(sample);
    expect(
      localStorage.getItem(LOGIN_STEP_KEY),
      '存进了 localStorage = 同一台电脑上的下一个人打开登录页，接着上一个人的半程走，还看得见他的号',
    ).toBeNull();

    reopenTab();
    expect(loadLoginStep(), '另开一个标签页还接得上别人的半程').toBeNull();
  });

  it('🔴 形状不认识就当没有：标签页跨过一次发版，旧记录不该把人卡住', () => {
    sessionStorage.setItem(LOGIN_STEP_KEY, JSON.stringify({ channel: 'sms', step: 'code' }));
    expect(loadLoginStep(), '认不出的通道名被当成了有效半程').toBeNull();

    sessionStorage.setItem(LOGIN_STEP_KEY, '这不是 JSON');
    expect(loadLoginStep(), '坏掉的记录该当没有，不该把渲染整个抛掉').toBeNull();
  });
});

describe('进站之前要擦掉半程记录', () => {
  it('🔴 手机号验完进站那一刻就擦了', async () => {
    saveLoginStep({
      channel: 'phone',
      step: 'code',
      target: '13800001111',
      expiresAt: Date.now() + 30_000,
    });
    flow();

    apiFetch.mockResolvedValueOnce({ token: 'tok-lao', need_email: false });
    await captured['手机号'].onVerify('123456');

    expect(push).toHaveBeenCalledWith('/welcome');
    expect(
      sessionStorage.getItem(LOGIN_STEP_KEY),
      '没擦 = 下次打开登录页被丢回上一回的验证码格，而那个码早过期了',
    ).toBeNull();
  });

  it('🔴 邮箱那条路验完也一样擦（出口有两个，不能只擦一个）', async () => {
    saveLoginStep({
      channel: 'email',
      step: 'code',
      target: 'laoyuan@example.com',
      expiresAt: Date.now() + 30_000,
    });
    renderToStaticMarkup(
      <EmailChannel
        completing={false}
        email="laoyuan@example.com"
        onEmailChange={() => {}}
        agreed
      />,
    );

    apiFetch.mockResolvedValueOnce({ token: 'tok-mail' });
    await captured['邮箱'].onVerify('123456');

    expect(push).toHaveBeenCalledWith('/welcome');
    expect(sessionStorage.getItem(LOGIN_STEP_KEY)).toBeNull();
  });

  it('🔴 写入口只有一处、出口只有一处', () => {
    // 渲染判据够不着「写」（靠 useEffect，node 环境不跑）。分散写几处的现象是
    // 刷新之后回到**上一个**状态，没有任何报错——所以这里钉的是"只有一处"。
    expect(countOf(CHANNEL_STEP_SRC, 'saveLoginStep('), '半程记录冒出了第二个写入口').toBe(1);
    expect(countOf(LOGIN_FLOW_SRC, 'clearLoginStep()'), '擦记录不该有第二处').toBe(1);
    expect(countOf(LOGIN_FLOW_SRC, 'router.push(AFTER_LOGIN)'), '进站不该有第二处').toBe(1);
  });
});

/**
 * 按钮为什么是灰的。
 *
 * 原先只有一句「先勾选下方的说明，再发送验证码」：手机号少打一位的人照着勾了，
 * 按钮还是灰的，于是**唯一那句提示反而把人指到了错的地方**。
 * 两个原因各说各的，都不满足就两条都说。
 */
describe('按钮是灰的时候，把两个原因都说出来', () => {
  const HINT_NUMBER = '手机号是 11 位数字，再核对一下';
  const HINT_GATE = '先勾选下方的说明，再发送验证码。';

  /**
   * 「发送验证码」那个按钮是不是灰的。
   * 只认真正的 disabled 属性：按钮的 class 里本来就带着 `disabled:pointer-events-none`
   * 这类 Tailwind 变体，拿"产物里出现过 disabled 这个词"当判据永远是真。
   */
  const sendDisabled = (html: string) => {
    const tag = /<button\b[^>]*>[^<]*发送验证码<\/button>/.exec(html);
    expect(tag, '渲染产物里根本没有「发送验证码」这个按钮').toBeTruthy();
    return /\sdisabled=""/.test(tag![0]);
  };

  const step = (over: Partial<ChannelStepProps>) =>
    renderToStaticMarkup(
      <ChannelStep
        fieldLabel="手机号"
        fieldHint="用于接收验证码和开庭前的期限提醒，不会对外展示。"
        placeholder="11 位手机号"
        inputType="tel"
        inputMode="numeric"
        autoComplete="tel"
        value="138"
        onValueChange={() => {}}
        valid={false}
        invalidHint={HINT_NUMBER}
        maskedTarget=""
        codeHint="收不到就等验证码倒计时结束后重发一次。"
        gateOk={false}
        gateHint={HINT_GATE}
        ctaLabel="验证并登录"
        persistAs="phone"
        onSend={async () => 60}
        onVerify={async () => {}}
        {...over}
      />,
    );

  it('🔴 号码不对 + 没勾：两条都说', () => {
    const html = step({});
    expect(sendDisabled(html), '两条都不满足，按钮却是能点的').toBe(true);
    expect(text(html)).toContain(HINT_NUMBER);
    expect(text(html)).toContain(HINT_GATE);
  });

  it('🔴 号码不对 + 已经勾了：只说号码，别再让人去勾一个已经勾上的框', () => {
    const copy = text(step({ gateOk: true }));
    expect(copy, '勾也勾了、字也打了，按钮还是灰的，一个字的解释都没有').toContain(HINT_NUMBER);
    expect(copy, '框已经勾上了还催人去勾').not.toContain(HINT_GATE);
  });

  it('🔴 号码没问题 + 没勾：只说勾选', () => {
    const copy = text(step({ valid: true, value: '13800001111' }));
    expect(copy).toContain(HINT_GATE);
    expect(copy, '号码本来就对，凭空说它不对').not.toContain(HINT_NUMBER);
  });

  it('🔴 空格子不催：还没开始填，不该先挨一句"号码不对"', () => {
    const copy = text(step({ value: '' }));
    expect(copy).toContain(HINT_GATE);
    expect(copy, '刚进页面什么都没填就被说号码不对').not.toContain(HINT_NUMBER);
  });

  it('🔴 两条都满足时一句都不说，按钮也不灰（量具自检）', () => {
    const html = step({ valid: true, value: '13800001111', gateOk: true });
    expect(text(html)).not.toContain(HINT_NUMBER);
    expect(text(html)).not.toContain(HINT_GATE);
    expect(
      sendDisabled(html),
      '什么都对了按钮还是灰的——那上面两条判据测的是个永远点不动的按钮',
    ).toBe(false);
  });
});
