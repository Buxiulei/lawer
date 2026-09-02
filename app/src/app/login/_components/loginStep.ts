/**
 * 登录走到哪一步：停在哪条通道的哪一格、码发给了谁、什么时候能重发。
 *
 * 【为什么要存下来】验证码那一格只活在组件内存里。刷新一下（或从别处退回来），
 * 内存没了，人被静默退回手机号那一格——**而短信已经发出去了**：
 * 眼前没有能填码的格子，想重发又撞上后端 60 秒限流（「发送太频繁，60 秒后再试」），
 * 只能干等。补绑邮箱那一步更糟：token 已经写进 localStorage 了，人却被打回登录第一格。
 *
 * 【为什么是 sessionStorage 不是 localStorage】它跟着**这一个标签页**走，关掉即清。
 * 记录里带着上一个人的手机号：换成 localStorage，同一台电脑上的下一个人打开登录页，
 * 会接着别人的半程往下走，还能看见那个号的掩码。
 * 判据见 __tests__/login-resume.test.tsx「半程记录存在哪儿」。
 */

export const LOGIN_STEP_KEY = 'lawer.login.step';

/** 三条路各自的半程：手机号登录 / 邮箱登录 / 新号补绑邮箱 */
export type LoginChannel = 'phone' | 'email' | 'completion';

const CHANNELS: readonly string[] = ['phone', 'email', 'completion'];

export interface LoginStep {
  channel: LoginChannel;
  /** 'entry' = 还在填手机号/邮箱那一格；'code' = 码已发出，停在验证码那一格 */
  step: 'entry' | 'code';
  /** 那一格里填的手机号或邮箱原文：回来要原样填回去，验证码格还要拿它显示掩码 */
  target: string;
  /**
   * 可以重发的**时刻**（epoch ms）。
   * 存截止时刻而不是剩余秒数：剩余秒数一刷新就从头再数，等于把限流窗口凭空拉长一倍。
   * 注意它说的是「重发冷却」，不是验证码本身的有效期（那个由后端管）。
   */
  expiresAt: number;
}

/**
 * 读半程记录。**认形状不认版本号**：标签页可以一直开着跨过一次发版，
 * 那时旧记录会撞上新代码；形状对不上就当没有，回到第一格重新来——
 * 总好过按一个渲染不出来的态把人卡住。
 */
export function loadLoginStep(): LoginStep | null {
  try {
    const raw = sessionStorage.getItem(LOGIN_STEP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LoginStep>;
    if (!CHANNELS.includes(parsed.channel as string)) return null;
    if (parsed.step !== 'entry' && parsed.step !== 'code') return null;
    return {
      channel: parsed.channel as LoginChannel,
      step: parsed.step,
      target: typeof parsed.target === 'string' ? parsed.target : '',
      expiresAt:
        typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)
          ? parsed.expiresAt
          : 0,
    };
  } catch {
    // 服务端渲染阶段根本没有 sessionStorage，隐私模式下读也会抛：两种都按"没有半程"处理
    return null;
  }
}

export function saveLoginStep(state: LoginStep): void {
  try {
    sessionStorage.setItem(LOGIN_STEP_KEY, JSON.stringify(state));
  } catch {
    // 存不下不阻断本次登录：只是刷新之后接不上
  }
}

export function clearLoginStep(): void {
  try {
    sessionStorage.removeItem(LOGIN_STEP_KEY);
  } catch {
    // 同上
  }
}
