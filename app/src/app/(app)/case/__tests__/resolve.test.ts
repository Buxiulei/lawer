/**
 * 「打开我的案件」的四种去处。
 *
 * 病灶原样：全站只有 demo 一个去处，于是名下躺着 20 条时间线的用户
 * 也被送进演示案件，横幅写着「这是演示案件」。**页面看起来完全正常**——
 * 没有报错、没有空白，只是那不是他的案件。这组的每一条都在钉死"什么时候才准去 demo"。
 */
import { describe, expect, it } from 'vitest';
import { destinationFor, latestOf } from '../_components/resolve';

const CASE = (id: number, title = '我的案件') => ({ id, title });

describe('登录 + 名下有案件', () => {
  const dest = destinationFor({ kind: 'cases', cases: [CASE(2)] });

  it('去他自己的那个案件', () => {
    expect(dest.href).toBe('/case/2');
  });

  // 变异核：把解析改回 demo 兜底，这条立刻红
  it('绝不去演示案件', () => {
    expect(dest.href).not.toContain('demo');
  });

  it('多个案件取最新那个（接口按 id 倒序）', () => {
    expect(latestOf([CASE(7), CASE(3)])?.id).toBe(7);
    expect(destinationFor({ kind: 'cases', cases: [CASE(7), CASE(3)] }).href).toBe('/case/7');
  });
});

describe('登录 + 名下没有案件', () => {
  const dest = destinationFor({ kind: 'cases', cases: [] });

  it('这时才允许去演示案件——他确实没有别的可看', () => {
    expect(dest.href).toBe('/case/demo');
  });

  it('并且要说明这是演示，不能默默换一份数据给他', () => {
    expect(dest.notice).toContain('演示');
  });
});

describe('未登录', () => {
  it('去登录页，不去演示案件', () => {
    const dest = destinationFor({ kind: 'signed-out' });
    expect(dest.href).toBe('/login');
    expect(dest.href).not.toContain('demo');
  });

  it('凭据失效同理，且要说清是失效不是没登录过', () => {
    const dest = destinationFor({ kind: 'unauthorized' });
    expect(dest.href).toBe('/login');
    expect(dest.notice).toContain('失效');
  });
});

/**
 * 变异核：这一支若回落到 demo，页面会渲染出一份**看起来完全正常**的演示案件，
 * 用户没有任何信号知道自己看的不是自己的东西。宁可停下来说不知道。
 */
describe('没查成（网络断了 / 后端挂了）', () => {
  const dest = destinationFor({ kind: 'failed' });

  it('不跳转——"没查到"不等于"没有"', () => {
    expect(dest.href).toBeNull();
  });

  it('尤其不许跳去演示案件', () => {
    expect(dest.href).not.toBe('/case/demo');
  });

  it('要说人话，不是甩一句加载失败', () => {
    expect(dest.notice).toContain('案件');
  });
});

describe('四种输入形态都给了答案', () => {
  // 正对照：漏一种形态时 switch 会走空，这条把"每种都有 notice"钉住
  it.each([
    { kind: 'signed-out' as const },
    { kind: 'unauthorized' as const },
    { kind: 'cases' as const, cases: [] },
    { kind: 'failed' as const },
  ])('$kind 有可展示的说明', (outcome) => {
    expect(destinationFor(outcome).notice.length).toBeGreaterThan(0);
  });
});
