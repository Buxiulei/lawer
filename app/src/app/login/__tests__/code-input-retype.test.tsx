/**
 * 验证码输错后原地重打（A-09）。
 *
 * 用户最自然的动作是：报错了，不清空，点第 1 格从头打一遍。
 * 修之前这条路必错——先填 `000000` 再重打 `135790`，六格最终是 `0,1,3,5,7,9`：
 * 旧字符被顶到最前，本该输入的末位被静默吞掉，界面一个字的提示都没有。
 * 用户看到的是"我明明打对了，它一直说验证码错误"。
 *
 * **这条测试不喂"理想的 raw"**——那样修不修都是绿的。
 * 它按格子真实的两个属性（maxLength、进格全选）推出浏览器会交给 onChange 的值，
 * 再把那串值喂给真正的 reducer。属性从**渲染出来的 markup**和源码里读，不写死在测试里，
 * 所以属性一旦被撤掉，这里立刻红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { applyInput, CodeInput } from '../_components/CodeInput';

const SRC = readFileSync(join(process.cwd(), 'src/app/login/_components/CodeInput.tsx'), 'utf8');
const MARKUP = renderToStaticMarkup(
  <CodeInput value="000000" onChange={() => {}} />,
);

/** 每格的 maxlength（没有就是 null）。React 19 原样吐 camelCase，所以不区分大小写。 */
const maxLength = (): number | null => {
  const m = MARKUP.match(/maxlength="(\d+)"/i);
  return m ? Number(m[1]) : null;
};
/** 进格是否全选。事件处理器不进 markup，只能从源码读。 */
const selectsOnFocus = () => /onFocus=\{[^}]*\.select\(\)/.test(SRC);

/**
 * 浏览器侧的模型：格子里已经有字符时，再敲一位会发生什么。
 * - 进格全选 → 新字符**替换**旧的，onChange 拿到一位；
 * - 没全选但 maxLength=1 → 浏览器直接拒收，事件根本不发（返回 null）；
 * - 没全选也没 maxLength → DOM 值瞬时变**两位**，这正是原来那个"被当成粘贴"的触发点。
 */
function rawFromTyping(existing: string, typed: string): string | null {
  if (selectsOnFocus()) return typed;
  const merged = existing + typed;
  const cap = maxLength();
  if (cap !== null && merged.length > cap) return null;
  return merged;
}

/** 从第 0 格起逐格重打整段，回最终整串。 */
function retype(start: string, typed: string): string {
  let value = start;
  for (let i = 0; i < typed.length; i += 1) {
    const raw = rawFromTyping(value[i] ?? '', typed[i]);
    if (raw === null) continue; // 浏览器把这一下丢了：整串不变，末尾自然缺位
    // 逐格重打是键入，不是粘贴——inputType 不会是 insertFromPaste
    const edit = applyInput(value, i, raw, false);
    if (edit) value = edit.value;
  }
  return value;
}

describe('输错后原地重打整段', () => {
  it('先 000000 再逐格重打 135790，终值就是 135790', () => {
    expect(retype('000000', '135790')).toBe('135790');
  });

  it('空着从头打也一样', () => {
    expect(retype('', '135790')).toBe('135790');
  });

  it('每格 maxLength=1——全选万一没生效，也不许让 DOM 值变两位', () => {
    expect(maxLength()).toBe(1);
    expect(MARKUP.match(/maxlength="1"/gi)).toHaveLength(6);
  });

  it('进格全选，新字符是替换不是追加', () => {
    expect(selectsOnFocus()).toBe(true);
  });
});

describe('粘贴分支只认 inputType', () => {
  it('六位一次进来、标了 insertFromPaste，照旧整串填上', () => {
    expect(applyInput('', 0, '135790', true)).toEqual({ value: '135790', focus: 6 });
  });

  it('中间那格粘贴，从那格起接上', () => {
    expect(applyInput('12', 2, '3456', true)).toEqual({ value: '123456', focus: 6 });
  });

  /**
   * 这条是原 bug 的正脸：同样是"raw 有六位数字"，但没标 insertFromPaste。
   * 旧实现按位数猜，于是把它当粘贴、整串从 index 起前移；
   * 现在只取第一位放回这一格，别的位置一个都不动。
   */
  it('六位裸 raw 没标粘贴，不许整串前移', () => {
    // 旧实现会给 {value:'135790', focus:6}——把一次键入当成了粘贴
    expect(applyInput('000000', 0, '135790', false)).toEqual({ value: '100000', focus: 1 });
    expect(applyInput('999999', 3, '135790', false)).toEqual({ value: '999199', focus: 4 });
  });

  it('剪贴板那条路（onPaste）没被拆掉', () => {
    expect(SRC).toContain('onPaste={handlePaste}');
    expect(SRC).toContain('clipboardData');
  });

  it('非数字一律忽略，不清空已输入的', () => {
    expect(applyInput('1234', 4, 'a', false)).toBeNull();
  });
});
