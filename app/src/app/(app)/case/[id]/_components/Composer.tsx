'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/shadcn/button';
import { StickyBottomBar } from '@/components/shell/StickyBottomBar';

const MAX_HEIGHT_PX = 168;

export const PLACEHOLDER = '说说现在的情况，或者问下一步该怎么做';

/** 键位提示。它必须与 `shouldSendOnEnter` 说同一句话——文案和行为分家就是在教错用法。 */
export const KEY_HINT = '回车发送，Shift + 回车换行';

/** 量高只需要这三样；抽成结构类型是为了测试能塞一个假 textarea 进来。 */
interface Measurable {
  placeholder: string;
  readonly scrollHeight: number;
  style: { height: string };
}

/**
 * 按内容量高。**读 scrollHeight 之前先摘掉占位符**——
 * 占位符在 393px 下要折两行，算进去空态就是 76px（单行应有 ~50px），
 * 用户打第一个字时会看见一次莫名其妙的回缩跳动。
 * 有内容时占位符本来就不渲染，不用动。
 */
export function fitHeight(el: Measurable, value: string): void {
  const placeholder = el.placeholder;
  if (!value) el.placeholder = '';
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  if (!value) el.placeholder = placeholder;
}

/** 按键事件里做这个判断需要的字段。抽成结构类型是为了让测试能直接喂假事件。 */
export interface EnterKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** 输入法正在组词（React 从 nativeEvent 上取） */
  isComposing: boolean;
  /** 组词中的历史兜底：部分 Safari/iOS 版本此时 isComposing 为 false，只有 keyCode 是 229 */
  keyCode?: number;
}

/**
 * 这一下回车该不该发送。
 *
 * 【为什么是回车发送而不是 ⌘/Ctrl+回车】用户在这里打的是一句话不是一封信，
 * 而"打完一句话按回车"是不需要学的；要按住修饰键才发得出去，等于每一轮都要先学一遍。
 *
 * 【输入法必须让路】中文输入法里回车是**选词**。组词途中抢走它，用户就打不出汉字了——
 * 而这个产品的每一个用户都在打汉字。所以 `isComposing`（含 keyCode 229 的老兜底）优先于一切。
 */
export function shouldSendOnEnter(e: EnterKeyEvent): boolean {
  if (e.key !== 'Enter') return false;
  if (e.isComposing || e.keyCode === 229) return false;
  // Shift+回车 = 换行（要写多段情况的人用这个）；⌘/Ctrl+回车仍然发送，老习惯不打断
  if (e.shiftKey) return false;
  return true;
}

/**
 * 输入区：多行自适应 textarea + 发送。流式中发送键变停止。
 * 回车发送、Shift+回车换行——中文输入法组词中的回车是选词，不能抢。
 */
export function Composer({
  streaming,
  onSend,
  onStop,
  /**
   * 停用输入（当前唯一的来源：公道值余额用尽，见 GongdaoExhaustedBanner）。
   * 为什么要**真的禁掉**而不是只挂一条提示：能打字、能点发送、每次都被同一句话弹回来，
   * 是一种「产品坏了」的体验；禁掉之后出路只剩横幅上那两个入口，那正是唯一能走的路。
   * 占位符一并换成 disabledPlaceholder，好让「为什么打不了字」就写在打字的地方。
   */
  disabled = false,
  /** 停用时输入框里的那句说明。 */
  disabledPlaceholder,
}: {
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  disabled?: boolean;
  disabledPlaceholder?: string;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) fitHeight(el, value);
  }, [value]);

  const send = () => {
    const text = value.trim();
    if (!text || streaming || disabled) return;
    onSend(text);
    setValue('');
  };

  // 背景与页面底同色、无顶部分割线（规格）：输入区不该在对话流上划一道横杠。
  // 位置与「我有多高」交给 StickyBottomBar：手机上要让开底部 Tab，
  // 而悬浮的低调钮/提示条要让开这条，两边都读同一个 --bottom-bar-h。
  return (
    <StickyBottomBar className="-mx-4 bg-bg px-4 pt-2 pb-3 lg:mx-0 lg:px-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (
              shouldSendOnEnter({
                key: e.key,
                shiftKey: e.shiftKey,
                metaKey: e.metaKey,
                ctrlKey: e.ctrlKey,
                isComposing: e.nativeEvent.isComposing,
                keyCode: e.nativeEvent.keyCode,
              })
            ) {
              e.preventDefault();
              send();
            }
          }}
          disabled={disabled}
          placeholder={disabled ? (disabledPlaceholder ?? PLACEHOLDER) : PLACEHOLDER}
          aria-label="输入消息"
          className="min-h-11 flex-1 resize-none rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[16px] leading-7 text-ink placeholder:text-ink-2 focus:border-focus-ring focus:outline-none"
        />

        {streaming ? (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={onStop}
            aria-label="停止输出"
            className="text-ink-2"
          >
            <span aria-hidden className="size-3.5 rounded-[3px] bg-current" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            onClick={send}
            disabled={disabled || !value.trim()}
            aria-label="发送"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M4.5 19.5L20 12 4.5 4.5l2.6 7.5-2.6 7.5z" />
              <path d="M7.1 12H20" />
            </svg>
          </Button>
        )}
      </div>
      <p className="mt-1.5 hidden text-[13px] text-ink-2 lg:block">
        {KEY_HINT}
      </p>
    </StickyBottomBar>
  );
}
