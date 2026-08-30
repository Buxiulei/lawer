'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/shadcn/button';

const MAX_HEIGHT_PX = 168;

export const PLACEHOLDER = '说说现在的情况，或者问下一步该怎么做';

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

/**
 * 输入区：多行自适应 textarea + 发送。流式中发送键变停止。
 * 回车换行、Ctrl/⌘+Enter 发送——中文输入法下回车是选词，不能抢。
 */
export function Composer({
  streaming,
  onSend,
  onStop,
}: {
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) fitHeight(el, value);
  }, [value]);

  const send = () => {
    const text = value.trim();
    if (!text || streaming) return;
    onSend(text);
    setValue('');
  };

  // 背景与页面底同色、无顶部分割线（规格）：输入区不该在对话流上划一道横杠。
  // 底部偏移保留 56px——手机上那条是底部 Tab 导航，贴到 bottom-0 会被它盖住。
  return (
    <div className="sticky bottom-[calc(56px+env(safe-area-inset-bottom))] z-30 -mx-4 bg-bg px-4 pt-2 pb-3 lg:bottom-0 lg:mx-0 lg:px-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={PLACEHOLDER}
          aria-label="输入消息"
          className="min-h-11 flex-1 resize-none rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[16px] leading-7 text-ink placeholder:text-ink-2 focus:border-primary focus:outline-none"
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
            disabled={!value.trim()}
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
        回车换行，⌘/Ctrl + 回车发送
      </p>
    </div>
  );
}
