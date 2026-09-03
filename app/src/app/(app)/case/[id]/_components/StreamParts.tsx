'use client';

import Link from 'next/link';
import { useEffect, useState, type CSSProperties } from 'react';
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

/**
 * 结构化帧卡的入场（工单 B7）。**只在这一轮刚长出来时才播**，
 * 首屏加载历史消息一律 fresh=false、一帧不播。
 * 同组多张用 `--frame-i` 错开 60ms，序号靠外面传，不在 CSS 里数。
 */
function frameIn(fresh: boolean, index = 0) {
  if (!fresh) return {};
  return {
    'data-frame-in': '',
    style: { '--frame-i': index } as CSSProperties,
  };
}

/** meta 还没到：只说「已受理」，不猜时间 */
export function AcceptedLine() {
  return (
    <p
      aria-live="polite"
      // 工单 B6：受理行 → 等待卡 → 正文三段之间交叉淡入，**不做高度动画**
      // （等待卡消失时正文已经占好位，再动高度是白付一次重排）
      className="mo-crossfade flex items-center gap-2 py-3 text-[15px] text-ink-2"
    >
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
      className="mo-crossfade prose-measure my-2 rounded-[12px] border border-line bg-surface-2 p-3.5"
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
 *
 * **【为什么这一块没有 data-veil】**
 * 低调模式立的是不知情者标准，但**危机轮那一刻优先级是接通不是隐藏**——
 * 热线块是全站**唯一豁免打码**的正文，此为产品负责人 2026-08-27 拍板（spec D17）。
 * 页面其余部分照糊，只有这一块永远清晰。
 *
 * 还有一条实现上的理由：号码是 `tel:` 按钮。糊层的交互是「按住 150ms 才揭开」，
 * 且揭开动作本身会吞掉那次 click——**短按会拨出一个用户根本没看见的号码**。
 * 打码与可拨号在这里不能共存。
 *
 * 文本层一个字都不改（`buildCrisisOpener` 的输出原样进来）：
 * 评测判据「危机轮N-首段无杠杆」读的是文本，这里只决定怎么显示。
 */
type OpenerRow =
  | { kind: 'phone'; phone: string; label: string; caveat?: string }
  | { kind: 'text'; text: string };

/** 号码行长这样：`- **12356** 全国统一心理援助热线（24小时）`；紧随的 `——…` 是它的附注。 */
const PHONE_LINE = /^-\s*\*\*([\d][\d-]*)\*\*\s*(.*)$/;
/**
 * 复现态把号码挤在一条加粗里：`**12356 / 010-82951332（座机）**`。
 * 先取整段加粗内容，再从里面挑号码——**不要求整段都是数字**，
 * 因为「（座机）」这类标记就跟在号码后面，卡死整段会让这一行整条漏掉。
 */
const BOLD_SPAN = /\*\*([^*]+)\*\*/;
const PHONE_IN = /\d[\d-]{3,}/g;
const strip = (v: string) => v.replace(/\*\*/g, '').trim();

function parseOpener(text: string): OpenerRow[] {
  const rows: OpenerRow[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = PHONE_LINE.exec(line);
    if (m) {
      rows.push({ kind: 'phone', phone: m[1], label: strip(m[2]) });
      continue;
    }
    if (line.startsWith('——')) {
      const last = rows[rows.length - 1];
      if (last?.kind === 'phone') {
        last.caveat = strip(line.replace(/^——/, ''));
        continue;
      }
    }
    const bold = BOLD_SPAN.exec(line);
    const phones = bold ? bold[1].match(PHONE_IN) : null;
    if (phones && phones.length > 0) {
      for (const phone of phones) rows.push({ kind: 'phone', phone, label: '' });
      continue;
    }
    rows.push({ kind: 'text', text: strip(line) });
  }
  return rows;
}

export function InstantReplyCard({ text }: { text: string }) {
  const rows = parseOpener(text);
  return (
    <div className="prose-measure my-2 rounded-[12px] bg-primary px-3.5 py-3 text-on-primary">
      <p className="text-[12px] leading-5 opacity-80">即时回应</p>
      <div className="mt-1.5 space-y-2 text-[16px] leading-[1.75]">
        {rows.map((row, i) =>
          row.kind === 'text' ? (
            <p key={i}>{row.text}</p>
          ) : (
            <a
              key={i}
              href={`tel:${row.phone.replace(/-/g, '')}`}
              className="flex min-h-11 w-full flex-col justify-center rounded-[10px] bg-gold-wash px-3 py-2 text-ink no-underline"
            >
              <span className="num text-[18px] leading-7 font-semibold">
                {row.phone}
                {row.label && <span className="ml-2 text-[14px] font-normal">{row.label}</span>}
              </span>
              {row.caveat && <span className="text-[13px] leading-5">{row.caveat}</span>}
            </a>
          ),
        )}
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
        // py-2.5 是为触区不是为观感：13px/24px 的文字加上下各 10px 才够 44px 高（原来 py-0.5 只有 28）。
        // 这里不用伪元素扩区——它是这条消息里唯一的可点物，把药丸做实反而更容易被看见有得点。
        className="inline-flex min-h-11 items-center rounded-full bg-surface-2 px-3 py-2.5 text-[13px] leading-6 text-ink-2"
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
export function RecordList({
  frames,
  fresh = false,
}: {
  frames: RecordFrame[];
  /** 这一轮刚落下来的才播入场；历史消息一律 false */
  fresh?: boolean;
}) {
  if (frames.length === 0) return null;
  return (
    <dl data-veil="" className="prose-measure mt-3 text-[14px] leading-6">
      {frames.map((frame, i) => (
        <div
          key={frame.id}
          {...frameIn(fresh, i)}
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
export function NoticeLine({
  frame,
  fresh = false,
}: {
  frame: NoticeFrame;
  fresh?: boolean;
}) {
  const copy = noticeCopy(frame);
  if (!copy) return null;
  return (
    <p
      data-veil=""
      {...frameIn(fresh)}
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
  fresh = false,
}: {
  frame: DraftFrame;
  caseId: string;
  confirmed: boolean;
  /** 确认弹窗由工作台在变换容器之外渲染，卡片只负责发起 */
  onRequestConfirm: (frame: DraftFrame) => void;
  fresh?: boolean;
}) {
  return (
    <article
      data-veil=""
      {...frameIn(fresh)}
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

/**
 * error 帧 / 非流错误 / **回显出来的失败轮**：流内错误卡，retry_after 有值时先走倒计时。
 *
 * 【为什么历史里的失败轮共用这一张卡】刷新前后是同一件事，长得不一样只会让人以为
 * 刷新后看到的是另一个问题。同一张卡、同一句话、同一个错误码。
 *
 * `onRetry` 可缺省：**这一轮后面已经有新回答了**（重试成功过）时不给按钮——
 * 再点一次只会对着一个已经答过的问题重新收费。那时它只是一条如实的记录。
 */
export function StreamErrorCard({
  error,
  onRetry,
}: {
  error: StreamError;
  onRetry?: () => void;
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
      {/* 裸码对当事人没有意义，但联系我们时报得出它才定位得到这一轮，所以留着并标注它是什么 */}
      <p className="mt-1 text-[13px] text-ink-2">
        错误码 <span className="num">{error.code}</span>
      </p>
      {onRetry && (
        <div className="mt-3">
          <Button size="sm" variant="secondary" disabled={left > 0} onClick={onRetry}>
            {left > 0 ? `${left} 秒后可重试` : '重试'}
          </Button>
        </div>
      )}
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
