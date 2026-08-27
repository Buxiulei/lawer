'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';
import {
  formatWaited,
  noticeCopy,
  recordLabel,
  waitingHeadline,
  type DraftFrame,
  type NoticeFrame,
  type RecordFrame,
} from '../_stream/frames';
import type { StreamError } from '../_stream/useChatStream';

/** 超过这个秒数，等待卡多给一句安抚和一个去处 */
const LONG_WAIT_SECONDS = 60;

/** meta 还没到：只说「已受理」，不猜时间 */
export function AcceptedLine() {
  return (
    <p aria-live="polite" className="flex items-center gap-2 py-3 text-[15px] text-ink-2">
      <span
        aria-hidden
        className="size-2 rounded-full bg-primary"
        style={{ animation: 'skeleton-pulse 1.2s ease-in-out infinite' }}
      />
      已收到，正在受理…
    </p>
  );
}

/**
 * 等待卡：meta 已到、首字未到。推理模型首字前思考三四分钟是正常的，
 * 这里绝不空屏、绝不把心跳当错误。秒数由 ping 校准、本地计时器补平滑。
 */
export function WaitingCard({
  baseAt,
  model,
  onJumpToActions,
  onLongWait,
}: {
  baseAt: number;
  model: string | null;
  onJumpToActions?: () => void;
  /** 卡片长高的那一刻通知一次，好让页面跟着往下走 */
  onLongWait?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.floor((now - baseAt) / 1000));
  const long = seconds >= LONG_WAIT_SECONDS;

  useEffect(() => {
    if (long) onLongWait?.();
  }, [long, onLongWait]);

  return (
    <div
      aria-live="polite"
      className="prose-measure my-2 rounded-[12px] border border-line bg-surface-2 p-3.5"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] text-ink">
        <span
          aria-hidden
          className="size-2 rounded-full bg-primary"
          style={{ animation: 'skeleton-pulse 1.2s ease-in-out infinite' }}
        />
        {waitingHeadline(model)}
        <span className="text-ink-2">·</span>
        <span className="num text-ink-2">{formatWaited(seconds)}</span>
      </p>

      {long && (
        <div className="mt-2 border-t border-line pt-2">
          <p className="text-[14px] leading-6 text-ink-2">
            这一步在逐条核对你的档案和北京口径，有时要三四分钟。页面没有卡住，也不用重发。
          </p>
          {onJumpToActions && (
            <button
              type="button"
              onClick={onJumpToActions}
              className="mt-1 min-h-11 text-[14px] text-primary-ink underline underline-offset-4"
            >
              先看看当前的行动卡
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * deterministic 首段：服务端在调模型前毫秒级下发的接住式安抚 + 求助热线。
 * 单独成卡，与模型正文分开——这几句不是模型说的，也不该被当成分析结论。
 * 文案原样渲染（不走 markdown、不打码），热线号码必须一眼可读。
 */
export function InstantReplyCard({ text }: { text: string }) {
  const lines = text.split('\n').filter((line) => line.trim());
  return (
    <div
      data-veil=""
      className="prose-measure my-2 rounded-[12px] bg-primary px-3.5 py-3 text-on-primary"
    >
      <p className="text-[12px] leading-5 opacity-80">即时回应</p>
      <div className="mt-1.5 space-y-1.5 text-[16px] leading-[1.75]">
        {lines.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>
    </div>
  );
}

/** 降级徽标：冷静措辞，不用警报色 */
export function DegradedBadge() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        aria-expanded={open}
        className="inline-flex items-center rounded-full bg-surface-2 px-2.5 py-0.5 text-[13px] leading-6 text-ink-2"
      >
        已切换备用模型
      </button>
      {open && (
        <span className="absolute top-full left-0 z-40 mt-1 w-[240px] rounded-[10px] border border-line bg-surface p-2.5 text-[13px] leading-6 text-ink-2 shadow-soft">
          主力模型暂不可用，本轮由备用模型完成，结论口径不变。
        </span>
      )}
    </span>
  );
}

/**
 * record 帧组：**分量 1**，借 GOV.UK Summary List。
 *
 * 「这句话落到档案哪儿了」是回执不是内容，**不给外框**——
 * 键（落点）加粗、值（摘要）常规，行间一条 1px 底线，仅此而已。
 * 此前是一排 primary-wash 的圆角 chip，色重、又和行动卡撞同一个色相。
 */
export function RecordList({ frames }: { frames: RecordFrame[] }) {
  if (frames.length === 0) return null;
  return (
    <dl data-veil="" className="prose-measure mt-3 text-[14px] leading-6">
      {frames.map((frame) => (
        <div
          key={frame.id}
          className="flex gap-3 border-b border-line py-1.5 last:border-b-0"
        >
          <dt className="w-[4.5em] shrink-0 font-semibold text-ink">
            {recordLabel(frame.tool)}
          </dt>
          <dd className="min-w-0 flex-1 text-ink-2">{frame.summary}</dd>
        </div>
      ))}
    </dl>
  );
}

/** notice 帧：冷静提示行。词表里标为静默的 code（多数是系统治理信号）不渲染。 */
export function NoticeLine({ frame }: { frame: NoticeFrame }) {
  const copy = noticeCopy(frame);
  if (!copy) return null;
  return (
    <p
      data-veil=""
      className="prose-measure flex gap-2 border-l-2 border-line pl-3 text-[14px] leading-6 text-ink-2"
    >
      {copy}
    </p>
  );
}

/**
 * draft 帧：只给「查看草稿」和「确认口径无误」。
 * 没有「直接发出」——发不发、什么时候发，永远是用户自己在文书页按的。
 */
export function DraftCard({
  frame,
  caseId,
  confirmed,
  onRequestConfirm,
}: {
  frame: DraftFrame;
  caseId: string;
  confirmed: boolean;
  /** 确认弹窗由工作台在变换容器之外渲染，卡片只负责发起 */
  onRequestConfirm: (frame: DraftFrame) => void;
}) {
  return (
    <article
      data-veil=""
      className="prose-measure overflow-hidden rounded-[12px] border border-line bg-surface"
    >
      {/* 分量 3：细外框 + 灰底标题栏（GOV.UK Summary Card）。
          比行动卡轻两档：没有实边框、没有填色顶栏，标题栏只是灰底。 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-3.5 py-2">
        <Badge tone="primary">{frame.kind}</Badge>
        <span className="num text-[13px] text-ink-2">v{frame.version}</span>
        {confirmed && <Badge tone="success">口径已确认</Badge>}
        <span className="ml-auto flex items-center gap-1">
          <Button asChild size="sm" variant="ghost">
            <Link href={`/case/${caseId}/drafts/${frame.id}`}>查看</Link>
          </Button>
          {!confirmed && (
            <Button size="sm" variant="ghost" onClick={() => onRequestConfirm(frame)}>
              确认口径
            </Button>
          )}
        </span>
      </div>

      <div className="px-3.5 py-3">
        <h3 className="text-[16px] leading-7 font-semibold text-ink">{frame.title}</h3>
        <p className="mt-1 text-[13px] leading-6 text-ink-2">
          确认只是记下你认可这份措辞，发送要你自己在文书页做。
        </p>
      </div>
    </article>
  );
}

/** 草稿确认弹窗。Radix 会 portal 到 body，不受工作台那层布局容器影响。 */
export function DraftConfirmDialog({
  draft,
  onCancel,
  onConfirm,
}: {
  draft: DraftFrame | null;
  onCancel: () => void;
  onConfirm: (id: string) => void;
}) {
  return (
    <ConfirmDialog
      open={Boolean(draft)}
      tone="primary"
      title="确认这份草稿的口径"
      description="确认后仍需你在文书页手动发送，本产品不会替你发出任何东西。发之前可以再改，改完版本号会往上走。"
      confirmLabel="确认口径无误"
      onCancel={onCancel}
      onConfirm={() => draft && onConfirm(draft.id)}
    />
  );
}

/** error 帧 / 非流错误：流内错误卡，retry_after 有值时先走倒计时 */
export function StreamErrorCard({
  error,
  onRetry,
}: {
  error: StreamError;
  onRetry: () => void;
}) {
  const [left, setLeft] = useState(error.retryAfter ?? 0);

  useEffect(() => {
    setLeft(error.retryAfter ?? 0);
    if (!error.retryAfter) return;
    const timer = setInterval(() => {
      setLeft((v) => (v <= 1 ? 0 : v - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [error]);

  return (
    <div
      role="status"
      className="prose-measure my-2 rounded-[12px] border border-line bg-surface-2 p-3.5"
    >
      <p className="text-[14px] font-medium text-amber-ink">这一轮没说完</p>
      <p className="mt-1 text-[15px] leading-7 text-ink">{error.message}</p>
      <p className="num mt-1 text-[13px] text-ink-2">{error.code}</p>
      <div className="mt-3">
        <Button size="sm" variant="secondary" disabled={left > 0} onClick={onRetry}>
          {left > 0 ? `${left} 秒后可重试` : '重试'}
        </Button>
      </div>
    </div>
  );
}

/** 没有登录态时的兜底说明：让人知道看到的不是自己的档案 */
export function DemoDataBanner() {
  return (
    <p className="mb-2 rounded-[10px] bg-surface-2 px-3 py-2 text-[14px] leading-6 text-ink-2">
      当前为演示数据，登录后接入真实档案。
    </p>
  );
}
