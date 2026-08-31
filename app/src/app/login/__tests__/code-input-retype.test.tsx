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

/** 逐格的 maxlength（那一格没写就是 null）。React 19 原样吐 camelCase，所以不区分大小写。 */
const caps = (): (number | null)[] =>
  [...MARKUP.matchAll(/<input\b[^>]*>/gi)].map((tag) => {
    const m = tag[0].match(/maxlength="(\d+)"/i);
    return m ? Number(m[1]) : null;
  });

/** 进格（换一格）是否全选。事件处理器不进 markup，只能从源码读。 */
const selectsOnFocus = () => /onFocus=\{[^}]*\.select\(\)/.test(SRC);

/**
 * focusAt 里那一句显式 select。
 * **它跟 onFocus 那句不是一回事**：focus() 打到已经聚焦的那一格时 onFocus 不再触发
 * （末格尤其——focusAt(6) 被夹回第 6 格），那时候只有 focusAt 自己这句 select 管用。
 */
const FOCUS_AT = SRC.match(/const focusAt = \([\s\S]*?\n {2}\};/)?.[0] ?? '';
const focusAtSelects = () => /\.select\(\)/.test(FOCUS_AT);

/**
 * 浏览器侧的模型：往一格里敲一位会发生什么。
 * - 里面的旧字符被选中 → 新字符**替换**它，onChange 拿到一位；
 * - 没选中但 maxLength 满了 → 浏览器直接拒收，事件根本不发（返回 null）；
 * - 没选中也没满 → DOM 值瞬时变**两位**，这正是原来那个"被当成粘贴"的触发点。
 */
function rawFromTyping(
  existing: string,
  typed: string,
  selected: boolean,
  cap: number | null,
): string | null {
  if (selected) return typed;
  const merged = existing + typed;
  if (cap !== null && merged.length > cap) return null;
  return merged;
}

/** 从第 0 格起逐格重打整段，回最终整串。每敲完一格焦点就换下一格，onFocus 会触发。 */
function retype(start: string, typed: string): string {
  let value = start;
  for (let i = 0; i < typed.length; i += 1) {
    const raw = rawFromTyping(value[i] ?? '', typed[i], selectsOnFocus(), caps()[i]);
    if (raw === null) continue; // 浏览器把这一下丢了：整串不变，末尾自然缺位
    // 逐格重打是键入，不是粘贴——inputType 不会是 insertFromPaste
    const edit = applyInput(value, i, raw, false);
    if (edit) value = edit.value;
  }
  return value;
}

/**
 * 浏览器把整串一次塞进第 1 格（iOS 从短信自动填充、或用户在第 1 格粘贴）。
 * **maxLength 是硬闸**：塞不下的部分浏览器自己截掉，onChange 根本看不到。
 */
function rawFromAutofill(code: string, cap: number | null): string {
  return cap === null ? code : code.slice(0, cap);
}

describe('输错后原地重打整段', () => {
  it('先 000000 再逐格重打 135790，终值就是 135790', () => {
    expect(retype('000000', '135790')).toBe('135790');
  });

  it('空着从头打也一样', () => {
    expect(retype('', '135790')).toBe('135790');
  });

  /**
   * 第 1 格那条「多位一次进来 ⇒ 整串铺开」例外的**下边界**。
   *
   * 上面两条逐格重打的用例从 `000000`／空串起步，第 1 格铺开时被截掉的正好是待重打的位，
   * 所以把 applyInput 里的 `digits.length > 1` 放宽成 `> 0`，那两条照样全绿——
   * 而用户只想改第 1 格一位时，后面五位会被整段抹掉，界面零提示。
   * 这条钉的就是那一位：**一位就是一位，不许走整串那条路。**
   */
  it('第 1 格改一位，后面五位不许被抹掉', () => {
    expect(applyInput('135790', 0, '2', false)).toEqual({ value: '235790', focus: 1 });
  });

  it('第 2–6 格 maxLength=1——全选万一没生效，也不许让 DOM 值变两位', () => {
    expect(caps()).toHaveLength(6);
    expect(caps().slice(1)).toEqual([1, 1, 1, 1, 1]);
  });

  it('进格全选，新字符是替换不是追加', () => {
    expect(selectsOnFocus()).toBe(true);
  });
});

/**
 * A-09 的另一半（manager 裁决：**自动填充不许被牺牲**）。
 * iOS 从短信里填验证码走 `autocomplete="one-time-code"`，六位一次塞进第 1 格，
 * 事件不标 insertFromPaste。第 1 格要是 maxLength=1，浏览器只留第一位，
 * 用户回到"自己看短信抄六位数"——这条路是绝大多数手机用户的默认路径。
 */
describe('iOS 短信自动填充：六位一次进第 1 格', () => {
  it('第 1 格 maxLength=6，不然浏览器先截成一位', () => {
    expect(caps()[0]).toBe(6);
  });

  it('第 1 格声明 one-time-code，不然 iOS 不会填', () => {
    expect(MARKUP).toMatch(/autocomplete="one-time-code"/i);
  });

  it('六位一次进来（没标 insertFromPaste），六格正确', () => {
    const raw = rawFromAutofill('135790', caps()[0]);
    expect(applyInput('', 0, raw, false)).toEqual({ value: '135790', focus: 6 });
  });

  it('已经填过一遍再自动填充，整串覆盖而不是接在后面', () => {
    const raw = rawFromAutofill('135790', caps()[0]);
    expect(applyInput('000000', 0, raw, false)).toEqual({ value: '135790', focus: 6 });
  });
});

/**
 * 末格重打：打错的最后一位，用户会直接在原地再敲一次。
 * 这时 applyInput 给的 focus 是 6，focusAt 夹回第 6 格——**焦点没换格，onFocus 不触发**，
 * 旧字符要靠 focusAt 里那句显式 select 才选得上。少了它，第 6 格 maxLength=1
 * 会让浏览器直接拒收第二次键入：用户敲了，屏幕上什么都没变，也没有任何提示。
 */
describe('最后一格连着重打', () => {
  it('focusAt 自己要 select，不能只靠 onFocus', () => {
    expect(FOCUS_AT).not.toBe('');
    expect(focusAtSelects()).toBe(true);
  });

  it('末位敲错再敲一次，改得动', () => {
    // 前五位已填好，光标在第 6 格；先敲了个 0
    const first = applyInput('13579', 5, '0', false);
    expect(first).toEqual({ value: '135790', focus: 6 });

    // focusAt(6) 夹回第 6 格 = 当前这一格，onFocus 不再触发，只剩 focusAt 里那句 select
    const raw = rawFromTyping('0', '8', focusAtSelects(), caps()[5]);
    expect(raw, '第二次键入被浏览器吞了').not.toBeNull();
    expect(applyInput('135790', 5, raw as string, false)).toEqual({
      value: '135798',
      focus: 6,
    });
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
   * 这条是原 bug 的正脸：同样是"raw 有多位数字"，但没标 insertFromPaste。
   * 旧实现在**每一格**都按位数猜，于是一次普通键入被当成粘贴、整串从 index 起前移。
   * 现在按位数走整串这条路只留给第 1 格（那里 maxLength=6，多位只可能来自自动填充/粘贴，
   * 见「iOS 短信自动填充」那一组）；第 2–6 格 maxLength=1，浏览器递不出多位。
   */
  it('第 2–6 格：多位裸 raw 没标粘贴，仍然不许整串前移', () => {
    // 旧实现会给 {value:'999135', focus:9}——把一次键入当成了粘贴
    expect(applyInput('999999', 3, '135790', false)).toEqual({ value: '999199', focus: 4 });
    expect(applyInput('999999', 5, '42', false)).toEqual({ value: '999994', focus: 6 });
  });

  it('剪贴板那条路（onPaste）没被拆掉', () => {
    expect(SRC).toContain('onPaste={handlePaste}');
    expect(SRC).toContain('clipboardData');
  });

  it('非数字一律忽略，不清空已输入的', () => {
    expect(applyInput('1234', 4, 'a', false)).toBeNull();
  });
});
