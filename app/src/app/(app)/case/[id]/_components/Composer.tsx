'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/shadcn/button';
import { StickyBottomBar } from '@/components/shell/StickyBottomBar';

const MAX_HEIGHT_PX = 168;

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
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const send = () => {
    const text = value.trim();
    if (!text || streaming) return;
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
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="说说现在的情况，或者问下一步该怎么做"
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
    </StickyBottomBar>
  );
}
