'use client';

import { cn } from '@/app/_ui/cn';
import { Button } from '@/components/shadcn/button';
import { useToast } from '@/components/ui/Toast';

/** 配置片段展示：等宽字体、横向可滚，不换行折断命令。 */
export function CodeBlock({
  code,
  copyLabel = '复制',
  copiedMessage = '已复制',
  wrap = false,
  maxHeight,
}: {
  code: string;
  copyLabel?: string;
  copiedMessage?: string;
  /** 整段话术这类以文字为主的内容要折行，否则在手机上只能横着拖 */
  wrap?: boolean;
  /** 超过这个高度就竖向滚，别把整页撑长（如 'max-h-72'） */
  maxHeight?: string;
}) {
  const toast = useToast();

  const copy = () => {
    navigator.clipboard
      .writeText(code)
      .then(() => toast(copiedMessage, 'success', '已复制'))
      .catch(() => toast('复制没成功，长按选中手动复制', 'neutral', '操作未完成'));
  };

  return (
    <div>
      <pre
        className={cn(
          'overflow-x-auto rounded-[10px] bg-surface-2 px-3 py-2.5 font-mono text-[13px] leading-6 text-ink',
          wrap && 'whitespace-pre-wrap break-words',
          maxHeight && `${maxHeight} overflow-y-auto`,
        )}
      >
        <code>{code}</code>
      </pre>
      <div className="mt-2">
        <Button size="sm" variant="secondary" onClick={copy}>
          {copyLabel}
        </Button>
      </div>
    </div>
  );
}
