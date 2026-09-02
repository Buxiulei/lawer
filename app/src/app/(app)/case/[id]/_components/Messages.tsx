'use client';

import { useEffect, useState } from 'react';
import type { ActionItem, Message } from '@/app/_mock/types';
import { cn } from '@/app/_ui/cn';
import { formatDate } from '@/app/_ui/format';
import { ActionGroup } from '@/components/case/ActionCard';
import { LawRefCard } from '@/components/case/LawRefCard';
import type { DraftFrame, NoticeFrame, RecordFrame } from '../_stream/frames';
import { servedModelLabel } from '../_stream/frames';
import { lawCiteId } from './citations';
import { MaskedText, RichText } from './RichText';
import {
  DegradedBadge,
  DraftCard,
  InstantReplyCard,
  NoticeLine,
  RecordList,
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
  /**
   * 厂商回显的**实际**服务型号（done 帧 / 历史行的 tokens_json.servedModel）。
   * 与 `model`（我们请求的那个）是两件事：中转请求 opus 完全可能由 sonnet 服务，
   * 拿请求值当"实际"标出去就是在撒谎，而这行小字的全部意义正是"实际"。
   */
  servedModel?: string | null;
  /** 实际与请求不是同一个型号。判据在服务端算好（记账那一处同源），前端不自己比串 */
  modelMismatch?: boolean;
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
    <div className="flex justify-end">
      <p
        data-veil=""
        className="max-w-[85%] rounded-[12px] bg-surface-2 px-3.5 py-2.5 text-[16px] leading-[1.75] text-ink lg:max-w-[75%]"
      >
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
  // 「这一轮实际是谁答的」。流式途中不标：型号要到 done 帧才回显，
  // 半路先标一个请求值、收完再换成实际值，等于当着用户的面改口。
  const modelName = streaming
    ? null
    : servedModelLabel({
        served: message.servedModel,
        requested: message.model,
        mismatch: message.modelMismatch,
      });
  const records = message.records ?? [];
  const notices = message.notices ?? [];
  const drafts = message.drafts ?? [];

  return (
    <article>
      {message.degraded && (
        <div className="mb-1.5">
          <DegradedBadge />
        </div>
      )}

      {head && <InstantReplyCard text={head} />}

      {body && <RichText text={body} />}
      {streaming && <StreamCaret text={message.content} />}

      {/* fresh 只在流式中为真：**首屏加载历史消息时不补播入场**。
          用户什么都没做却看见一片卡片飞进来，会以为刚才那一下点出了什么。 */}
      <RecordList frames={records} fresh={streaming} />

      {notices.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {notices.map((notice, i) => (
            <NoticeLine key={`${notice.code}-${i}`} frame={notice} fresh={streaming} />
          ))}
        </div>
      )}

      <ActionGroup items={actions} onToggle={onToggleAction} />

      {drafts.length > 0 && (
        <section className="mt-4 flex flex-col gap-2">
          {drafts.map((draft) => (
            <DraftCard
              key={draft.id}
              frame={draft}
              caseId={caseId}
              confirmed={confirmedDrafts.has(draft.id)}
              onRequestConfirm={onRequestConfirmDraft}
              fresh={streaming}
            />
          ))}
        </section>
      )}

      {laws.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-2 text-[13px] text-ink-2">依据</h3>
          <div className="prose-measure flex flex-col gap-2">
            {laws.map((law) => (
              // citeId：引用桥的对话端。同一条法条在多条消息里各引一次，id 一样，
              // 所以卷宗栏「本案依据」那一行一亮，这几处会一起亮——反向问题正是这么答的。
              <LawRefCard key={law.cite} law={law} citeId={lawCiteId(law.cite)} />
            ))}
          </div>
        </section>
      )}

      {/* 型号落款：极淡、极小，压在这一轮**所有产出的最下面**（含依据卡）。
          三态（实际 / 缺实际时退回请求 / 两个都没有就整行不出现）由 servedModelLabel 定。
          它是**可核对的事实**不是装饰：用户按型号付费，就有权知道这一轮实际拿到的是谁。 */}
      {modelName && (
        <p className="mt-3 text-[12px] leading-5 text-ink-2 opacity-60">{modelName}</p>
      )}
    </article>
  );
}

/** 超过这么久没有新字，就认为这一轮卡在思考里了 */
const STALL_MS = 1200;

/**
 * 流式光标：唯一允许的打字动效（DESIGN.md 动效）。
 *
 * 【工单 B6：光标两态，这是这一场景唯一真正新增的信息】
 * 在这之前「正在吐字」和「卡住了」长得一模一样——同一个 1.1s 的脉冲，
 * 用户只能靠盯着字数猜。现在超过 1.2 秒没有新字就换成更慢的呼吸。
 *
 * **不动 `useChatStream`**：只在这里观察 `text` 变化，插入点为零。
 *
 * 逐字/逐 token 淡入仍然否决：它把每个 token 变成一个带自身动画的 DOM 节点
 * （正是 remeasure-sse-mem 在查的那个面），而且中文一个 delta 常是整句，
 * 逐 delta 淡入会变成一段段「跳出来」，比直接追加更乱。
 */
function StreamCaret({ text }: { text: string }) {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    setStalled(false);
    const timer = window.setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(timer);
  }, [text]);

  return <CaretMark stalled={stalled} />;
}

/**
 * 光标本体。**两态的差别不只在动画上，也在颜色上**——
 * 减弱动效时全局规则会把两条 keyframes 都压掉，那时候
 * 「正在吐字（主色实心）」与「卡住了（ink-2 淡色）」**静止时仍然分得出来**。
 * 动效不制造新信息：这条是它的落地形态。
 */
export function CaretMark({ stalled }: { stalled: boolean }) {
  return (
    <span
      aria-hidden
      data-caret={stalled ? 'stalled' : 'live'}
      className={cn(
        'ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px]',
        stalled ? 'bg-ink-2' : 'bg-primary',
      )}
    />
  );
}
