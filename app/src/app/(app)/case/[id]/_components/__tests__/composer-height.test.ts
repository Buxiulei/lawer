/**
 * Composer 空态高度（P-08）。
 *
 * 占位符「说说现在的情况，或者问下一步该怎么做」在 393px 宽下要折两行，
 * 而量高直接读 `el.scrollHeight`——**把占位符的折行也算进了输入框的高**：
 * 空态实测 76px，单行应有 ~50px。用户敲下第一个字时会看见一次莫名的回缩跳动。
 *
 * 这里用一个假 textarea：它的 scrollHeight 随 placeholder 在不在而变，
 * 正好复刻真实浏览器的行为。量高的那一刻占位符还挂着，就量回 76。
 */
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER, fitHeight } from '../Composer';

const SINGLE_LINE = 50;
const WITH_FOLDED_PLACEHOLDER = 76;

function fakeTextarea(text: string) {
  return {
    placeholder: PLACEHOLDER,
    /** 有内容就按内容算；空的时候，占位符还在就折两行 */
    get scrollHeight(): number {
      if (text) return SINGLE_LINE;
      return this.placeholder ? WITH_FOLDED_PLACEHOLDER : SINGLE_LINE;
    },
    style: { height: '' },
  };
}

describe('空态量高', () => {
  it('不把占位符的折行算进去', () => {
    const el = fakeTextarea('');
    fitHeight(el, '');
    expect(el.style.height).toBe(`${SINGLE_LINE}px`);
  });

  it('量完把占位符放回去——用户还得看见那句提示', () => {
    const el = fakeTextarea('');
    fitHeight(el, '');
    expect(el.placeholder).toBe(PLACEHOLDER);
  });

  it('有内容时不动占位符（本来就不渲染），高度照内容算', () => {
    const el = fakeTextarea('我被裁了');
    fitHeight(el, '我被裁了');
    expect(el.style.height).toBe(`${SINGLE_LINE}px`);
    expect(el.placeholder).toBe(PLACEHOLDER);
  });

  it('长内容顶到上限就停住，不无限长', () => {
    const el = { placeholder: PLACEHOLDER, scrollHeight: 9999, style: { height: '' } };
    fitHeight(el, '很长很长的一段');
    expect(el.style.height).toBe('168px');
  });
});
