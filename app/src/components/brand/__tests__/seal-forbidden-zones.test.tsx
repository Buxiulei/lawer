/**
 * 落章的两条禁区，与 `Mascot` 那组同源。
 *
 * 章上写着「土八鼠印」四个字——**比卡通形象还直白**：
 * 打糊层挡的是「看清内容」，挡不住旁人一眼认出这台手机上装着某个特定的东西。
 * 这正是 D17「组合泄密」口径的动效版。
 *
 * 第三条判据在轨道上：**章不在的时候不能留下一个洞**。
 * 里程碑达成的静止判据是那一格底下由「进行中」换成日期，那行字任何模式下都在。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { discreet: false, reduce: false };
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: state.discreet, toggle: () => {} }),
}));
vi.mock('@/app/_ui/motion', async (orig) => ({
  ...(await orig<typeof import('@/app/_ui/motion')>()),
  useReducedMotion: () => state.reduce,
}));
// 轨道会挂 useGSAP，SSR 下不跑；编排本身另有 milestone-advance-plan 的测试盯着
vi.mock('@/hooks/useMilestoneAdvance', () => ({ useMilestoneAdvance: () => {} }));

const { Seal } = await import('../Seal');
const { MilestoneTrack } = await import(
  '@/app/(app)/case/[id]/_components/MilestoneTrack'
);
const { FULL_JOURNEY } = await import('@/app/(app)/case/[id]/_components/milestones');

const ATTAINED = [{ milestone: '协商' as const, happenedAt: '2026-07-24T00:00:00Z' }];
const track = () =>
  renderToStaticMarkup(<MilestoneTrack track={FULL_JOURNEY} attainments={ATTAINED} />);

beforeEach(() => {
  state.discreet = false;
  state.reduce = false;
});

describe('落章的禁区', () => {
  it('两个开关都关着：章在，而且是装饰件（不进无障碍树、不拦指针）', () => {
    const out = renderToStaticMarkup(<Seal />);
    expect(out).toContain('data-seal');
    expect(out).toContain('aria-hidden');
    expect(out).toContain('pointer-events-none');
  });

  it('低调模式开：DOM 里连节点都不该有', () => {
    state.discreet = true;
    expect(renderToStaticMarkup(<Seal />)).toBe('');
  });

  it('减弱动效开：整条不建，不是播 0.01ms', () => {
    state.reduce = true;
    expect(renderToStaticMarkup(<Seal />)).toBe('');
  });

  /**
   * 章的初始 opacity 写在 inline 上。没有它，章挂载到 gsap 接手之间会有一帧
   * 「一枚不转不缩、全不透明的红章突然出现」——而那一帧正好是要防的泄密面。
   */
  it('章一挂载就是不可见的，等编排来推它', () => {
    expect(renderToStaticMarkup(<Seal />)).toMatch(/opacity:\s*0\b/);
  });
});

describe('章不在时轨道不留洞', () => {
  it('低调模式下没有章，但四态判据那行字一个不少', () => {
    state.discreet = true;
    const out = track();
    expect(out).not.toContain('data-seal');
    // 「进行中」与已完成那格的日期是静止判据，跟动效无关
    expect(out).toContain('进行中');
    expect(out).toContain('07/24');
  });

  it('减弱动效下同样：没有章，判据仍在', () => {
    state.reduce = true;
    const out = track();
    expect(out).not.toContain('data-seal');
    expect(out).toContain('进行中');
    expect(out).toContain('07/24');
  });

  it('两个开关都关着时章才在，且编排要找的锚点都在（线、点各自带下标）', () => {
    const out = track();
    expect(out).toContain('data-seal');
    // 「协商」已完成 ⇒ 进行中落在第 1 格，编排要动的是这两个
    expect(out).toContain('data-mo-line="1"');
    expect(out).toContain('data-mo-dot="1"');
    // 呼吸环只挂在进行中那一格
    expect(out.match(/mo-breath/g)?.length).toBe(1);
  });
});
