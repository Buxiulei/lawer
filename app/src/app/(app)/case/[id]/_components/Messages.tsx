'use client';

import type { ActionItem, Message } from '@/app/_mock/types';
import { formatDate } from '@/app/_ui/format';
import { ActionCard } from '@/components/case/ActionCard';
import { LawRefCard } from '@/components/case/LawRefCard';
import { MaskedText, RichText } from './RichText';

/** 日期分隔：跨天时插一条细线，案件对话往往横跨几周。 */
export function DateDivider({ iso }: { iso: string }) {
  return (
    <div className="my-5 flex items-center gap-3" role="separator">
      <span className="h-px flex-1 bg-line" />
      <span className="num text-[13px] text-ink-2">{formatDate(iso)}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

export function UserMessage({ message }: { message: Message }) {
  return (
    <div className="flex justify-end py-2">
      <p className="max-w-[85%] rounded-[12px] bg-surface-2 px-3.5 py-2.5 text-[16px] leading-[1.75] text-ink lg:max-w-[75%]">
        <MaskedText text={message.content} />
      </p>
    </div>
  );
}

/**
 * AI 消息：文档式无气泡。正文 → 「现在做什么」行动卡组 → 法条依据。
 * 行动卡置顶于正文之后、法条之前——行动优先于解释（DESIGN.md RISK 2）。
 */
export function AssistantMessage({
  message,
  actions,
  onToggleAction,
  streaming = false,
}: {
  message: Message;
  actions: ActionItem[];
  onToggleAction: (id: string, done: boolean) => void;
  streaming?: boolean;
}) {
  // 流式中末尾可能停在半个 ** 上，先剪掉避免星号一闪
  const body = streaming ? message.content.replace(/\*{1,2}$/, '') : message.content;
  const laws = message.lawRefs ?? [];

  return (
    <article className="py-2">
      <RichText text={body} />
      {streaming && <StreamCaret />}

      {actions.length > 0 && (
        <section className="mt-4 animate-[fade-in_200ms_ease-out]">
          <h3 className="mb-2 flex items-baseline gap-2">
            <span className="text-[15px] font-semibold text-ink">现在做什么</span>
            <span className="num text-[13px] text-ink-2">
              {actions.filter((a) => a.status === '完成').length}/{actions.length}
            </span>
          </h3>
          <div className="prose-measure flex flex-col gap-2">
            {actions.map((item) => (
              <ActionCard key={item.id} item={item} onToggle={onToggleAction} />
            ))}
          </div>
        </section>
      )}

      {laws.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-2 text-[13px] text-ink-2">依据</h3>
          <div className="prose-measure flex flex-col gap-2">
            {laws.map((law) => (
              <LawRefCard key={law.cite} law={law} />
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

/** 流式光标：唯一允许的打字动效（DESIGN.md 动效） */
function StreamCaret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] bg-primary"
      style={{ animation: 'skeleton-pulse 1.1s ease-in-out infinite' }}
    />
  );
}

/** 等待首个 chunk：确定性文案，不写「AI 思考中」 */
export function WaitingLine({ label }: { label: string }) {
  return (
    <p
      aria-live="polite"
      className="flex items-center gap-2 py-3 text-[15px] text-ink-2"
    >
      <span
        aria-hidden
        className="size-2 rounded-full bg-primary"
        style={{ animation: 'skeleton-pulse 1.2s ease-in-out infinite' }}
      />
      {label}
    </p>
  );
}
