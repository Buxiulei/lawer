import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { discreet: false };
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: state.discreet, toggle: () => {} }),
}));

const { Mascot } = await import('../Mascot');

const SRC = join(process.cwd(), 'src');
const html = () => renderToStaticMarkup(<Mascot pose="watch" size={28} />);

beforeEach(() => {
  state.discreet = false;
});

describe('硬禁区③ 低调模式零品牌暴露', () => {
  it('低调模式关：吉祥物在', () => {
    expect(html()).toContain('<img');
  });

  it('低调模式开：DOM 里连节点都不该有', () => {
    state.discreet = true;
    // 不是「打糊」也不是「换灰图」——打糊挡的是看清内容，
    // 挡不住旁人一眼认出这是个卡通角色，而角色本身就是泄密面
    expect(html()).toBe('');
  });

  it('吉祥物一律不进无障碍树——它从不是信息的唯一载体', () => {
    const out = html();
    expect(out).toContain('alt=""');
    expect(out).toContain('aria-hidden');
  });

  it('五个姿势没有一个在低调模式下漏出来', () => {
    state.discreet = true;
    for (const pose of ['watch', 'nag', 'guard', 'cheer', 'guide'] as const) {
      expect(renderToStaticMarkup(<Mascot pose={pose} size={32} />)).toBe('');
    }
  });
});

describe('硬禁区② 危机轮零卡通', () => {
  // 组件不知道自己在哪一轮，这条自检不了，只能由本测试盯：
  // **危机相关的渲染文件里不许出现 Mascot**。
  const CRISIS_FILES = [
    'app/(app)/case/[id]/_components/StreamParts.tsx',
    'app/(app)/case/[id]/_components/Messages.tsx',
    'components/shell/PanicButton.tsx',
  ];

  it.each(CRISIS_FILES)('%s 不引用 Mascot', (rel) => {
    expect(readFileSync(join(SRC, rel), 'utf8')).not.toMatch(/\bMascot\b/);
  });

  // 清单空掉、或文件改了名，上面那组会静默变成「守着零个文件」——照样全绿。
  it('清单非空，且每个文件都真的存在', () => {
    expect(CRISIS_FILES.length).toBeGreaterThan(0);
    for (const rel of CRISIS_FILES) {
      expect(() => readFileSync(join(SRC, rel), 'utf8')).not.toThrow();
    }
  });
});
