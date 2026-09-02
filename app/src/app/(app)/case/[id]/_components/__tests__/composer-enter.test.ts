/**
 * 输入框的回车键（F-12）。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * 真机小白实测：打完字按回车，什么也没发生——回车在这里是换行，发送要按 ⌘/Ctrl + 回车。
 * 用户在这里打的是**一句话**不是一封信，而"打完一句话按回车"是不需要学的；
 * 要按住修饰键才发得出去，等于每一轮都要先学一遍，且没人会去读那行灰色小字。
 *
 * 【唯一不能抢的那一下】中文输入法组词途中的回车是**选词**。抢了它，用户就打不出汉字——
 * 而这个产品的每一个用户都在打汉字。所以 isComposing（含老 Safari 的 keyCode 229 兜底）
 * 排在一切规则之前。
 *
 * 【变异臂】
 *  · M-E1 去掉 isComposing 判断（组词中的回车也发送）⇒ 「输入法优先」那组红
 *  · M-E2 回车不发送（退回 ⌘/Ctrl+回车）⇒ 「回车就是发送」那组红
 *  · M-E3 Shift+回车也发送 ⇒ 「Shift 是换行」那条红
 *  · M-E4 提示文案与行为分家 ⇒ 「文案与行为说同一句话」那条红
 */
import { describe, expect, it } from 'vitest';

import { KEY_HINT, shouldSendOnEnter } from '../Composer';

/** 一个最朴素的回车：没按任何修饰键、输入法也没在组词 */
const plainEnter = { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false };

describe('一、回车就是发送', () => {
  it('光按回车 ⇒ 发送', () => {
    expect(shouldSendOnEnter(plainEnter)).toBe(true);
  });

  it('⌘/Ctrl + 回车仍然发送（老习惯不打断）', () => {
    expect(shouldSendOnEnter({ ...plainEnter, metaKey: true })).toBe(true);
    expect(shouldSendOnEnter({ ...plainEnter, ctrlKey: true })).toBe(true);
  });

  it('别的键一律不管（发送只认回车）', () => {
    for (const key of ['a', 'Escape', 'Tab', 'NumpadEnter', ' ']) {
      expect(shouldSendOnEnter({ ...plainEnter, key }), key).toBe(false);
    }
  });
});

describe('二、Shift + 回车是换行', () => {
  it('Shift + 回车 ⇒ 不发送，放行给 textarea 换行', () => {
    expect(shouldSendOnEnter({ ...plainEnter, shiftKey: true })).toBe(false);
  });

  it('Shift 压过修饰键组合：Shift+⌘+回车也还是换行', () => {
    expect(shouldSendOnEnter({ ...plainEnter, shiftKey: true, metaKey: true })).toBe(false);
  });
});

describe('★三、输入法优先：组词中的回车归输入法，一次都不许抢', () => {
  it('isComposing ⇒ 不发送', () => {
    expect(shouldSendOnEnter({ ...plainEnter, isComposing: true })).toBe(false);
  });

  it('老 Safari/iOS 组词时 isComposing 为 false、只有 keyCode 229 ⇒ 同样不发送', () => {
    expect(shouldSendOnEnter({ ...plainEnter, isComposing: false, keyCode: 229 })).toBe(false);
  });

  it('组词结束后的那一下（keyCode 13）照常发送', () => {
    expect(shouldSendOnEnter({ ...plainEnter, keyCode: 13 })).toBe(true);
  });
});

describe('四、提示文案与行为必须说同一句话', () => {
  it('文案写的是「回车发送，Shift + 回车换行」，与判定逐条对得上', () => {
    expect(KEY_HINT).toBe('回车发送，Shift + 回车换行');
    // 文案说回车发送 ⇔ 判定也说发送；文案说 Shift 换行 ⇔ 判定也说不发送
    expect(KEY_HINT.includes('回车发送')).toBe(shouldSendOnEnter(plainEnter));
    expect(KEY_HINT.includes('Shift + 回车换行')).toBe(!shouldSendOnEnter({ ...plainEnter, shiftKey: true }));
    // 旧文案（「回车换行，⌘/Ctrl + 回车发送」）一个字都不许留下
    expect(KEY_HINT.startsWith('回车换行')).toBe(false);
    expect(KEY_HINT).not.toContain('Ctrl');
  });
});
