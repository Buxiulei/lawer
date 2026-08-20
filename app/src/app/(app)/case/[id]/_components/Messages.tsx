'use client';

import type { ActionItem, Message } from '@/app/_mock/types';
import { formatDate } from '@/app/_ui/format';
import { ActionCard } from '@/components/case/ActionCard';
import { LawRefCard } from '@/components/case/LawRefCard';
import type { DraftFrame, NoticeFrame, RecordFrame } from '../_stream/frames';
import { MaskedText, RichText } from './RichText';
import {
  DegradedBadge,
  DraftCard,
  InstantReplyCard,
  NoticeLine,
  RecordChip,
} from './StreamParts';

/**
 * 一条 AI 消息在流里落定后的形状：正文之外还带这一轮的结构化产出。
 * 九帧契约里没有法条帧，lawRefs 目前只有 mock 会填。
 */
export interface StreamedMessage extends Message {
  records?: RecordFrame[];
  drafts?: DraftFrame[];
  notices?: NoticeFrame[];
  /** meta.degraded：本轮由备用模型完成 */
  degraded?: boolean;
  /** content 前多少个字符来自 deterministic 首段，单独渲染成「即时回应」卡 */
  deterministicChars?: number;
}

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
  caseId,
  confirmedDrafts,
  onRequestConfirmDraft,
  streaming = false,
}: {
  message: StreamedMessage;
  actions: ActionItem[];
  onToggleAction: (id: string, done: boolean) => void;
  caseId: string;
  confirmedDrafts: ReadonlySet<string>;
  onRequestConfirmDraft: (frame: DraftFrame) => void;
  streaming?: boolean;
}) {
  // deterministic 首段和模型正文共用一段文本，按前缀长度切开分别渲染
  const headChars = message.deterministicChars ?? 0;
  const head = message.content.slice(0, headChars);
  const rest = message.content.slice(headChars);
  // 流式中末尾可能停在半个 ** 上，先剪掉避免星号一闪
  const body = streaming ? rest.replace(/\*{1,2}$/, '') : rest;
  const laws = message.lawRefs ?? [];
  const records = message.records ?? [];
  const notices = message.notices ?? [];
  const drafts = message.drafts ?? [];

  return (
    <article className="py-2">
      {message.degraded && (
        <div className="mb-1.5">
          <DegradedBadge />
        </div>
      )}

      {head && <InstantReplyCard text={head} />}

      {body && <RichText text={body} />}
      {streaming && <StreamCaret />}

      {records.length > 0 && (
        <div className="prose-measure mt-3 flex flex-wrap gap-1.5">
          {records.map((record) => (
            <RecordChip key={record.id} frame={record} />
          ))}
        </div>
      )}

      {notices.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {notices.map((notice, i) => (
            <NoticeLine key={`${notice.code}-${i}`} frame={notice} />
          ))}
        </div>
      )}

      {actions.length > 0 && (
        <section data-action-group className="mt-4 animate-[fade-in_200ms_ease-out]">
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

      {drafts.length > 0 && (
        <section className="mt-4 flex flex-col gap-2">
          {drafts.map((draft) => (
            <DraftCard
              key={draft.id}
              frame={draft}
              caseId={caseId}
              confirmed={confirmedDrafts.has(draft.id)}
              onRequestConfirm={onRequestConfirmDraft}
            />
          ))}
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
