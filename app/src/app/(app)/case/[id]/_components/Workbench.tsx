'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActionItem } from '@/app/_mock/types';
import {
  demoActions,
  demoCase,
  demoDeadlines,
  demoMessages,
} from '@/app/_mock/demo';
import { mockLawRefs } from '@/app/_mock/workbench';
import { formatDate } from '@/app/_ui/format';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Sheet } from '@/components/ui/Sheet';
import { DeadlineChip } from '@/components/case/DeadlineChip';
import { toActionItem, type DraftFrame } from '../_stream/frames';
import { readToken } from '../_stream/httpTransport';
import { useChatStream, type SettledTurn } from '../_stream/useChatStream';
import { CasePanel } from './CasePanel';
import { Composer } from './Composer';
import {
  AssistantMessage,
  DateDivider,
  UserMessage,
  type StreamedMessage,
} from './Messages';
import {
  AcceptedLine,
  DemoDataBanner,
  DraftConfirmDialog,
  StreamErrorCard,
  WaitingCard,
} from './StreamParts';

/** 跟随滚动的容差：底部在视口这个范围内才继续跟着流式输出走 */
const FOLLOW_SLACK_PX = 220;

export function Workbench({ caseId }: { caseId: string }) {
  // demo 案件有历史、走演示数据；其他 id 只有登录后才有对话可谈。
  const seeded = caseId === demoCase.id;
  const [signedIn, setSignedIn] = useState(false);

  const [messages, setMessages] = useState<StreamedMessage[]>(
    seeded ? demoMessages : [],
  );
  const [actions, setActions] = useState<ActionItem[]>(seeded ? demoActions : []);
  const [confirmedDrafts, setConfirmedDrafts] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [askingDraft, setAskingDraft] = useState<DraftFrame | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const bottom = useRef<HTMLDivElement>(null);
  const follow = useRef(false);

  useEffect(() => setSignedIn(Boolean(readToken())), []);

  // 滚到文档末尾而不是锚点：末尾处输入区回到静态位置，最后一行不会被它压住
  const scrollToBottom = useCallback((smooth = true) => {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }, []);

  /** 内容自己长高时（等待卡追加安抚文案）跟一下，前提是用户没往回翻 */
  const keepAtBottom = useCallback(() => {
    if (follow.current) scrollToBottom();
  }, [scrollToBottom]);

  /** 等待久了的去处：滚到最近一组行动卡 */
  const jumpToActions = useCallback(() => {
    const groups = document.querySelectorAll('[data-action-group]');
    const last = groups[groups.length - 1];
    if (!last) return;
    follow.current = false;
    last.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const settle = useCallback(
    (turn: SettledTurn) => {
      const items = turn.actions.map((frame) => toActionItem(frame, caseId));
      setMessages((prev) => [
        ...prev,
        {
          id: turn.messageId || `m_local_${Date.now()}`,
          threadId: turn.meta?.thread_id ?? 'th_1',
          role: 'assistant',
          content: turn.text,
          model: turn.meta?.model,
          createdAt: new Date().toISOString(),
          actionItemIds: items.map((a) => a.id),
          // 法条卡不在九帧契约里，mock 期间按 message_id 回填
          lawRefs: mockLawRefs(turn.messageId),
          records: turn.records,
          notices: turn.notices,
          drafts: turn.drafts,
          degraded: turn.meta?.degraded,
        },
      ]);
      if (items.length) setActions((prev) => [...prev, ...items]);
      // 回复落定后行动卡才出现，再滚一次让「现在做什么」进视野
      if (follow.current) setTimeout(() => scrollToBottom(), 80);
      follow.current = false;
    },
    [caseId, scrollToBottom],
  );

  const stream = useChatStream({ caseId, onSettled: settle });

  // 流式中只在用户还停在底部时跟随；一旦用户往回翻，这一轮就不再拽他
  useEffect(() => {
    if (!follow.current || !stream.text) return;
    const rect = bottom.current?.getBoundingClientRect();
    if (rect && rect.top - window.innerHeight > FOLLOW_SLACK_PX) {
      follow.current = false;
      return;
    }
    scrollToBottom(false);
  }, [stream.text, scrollToBottom]);

  const send = useCallback(
    (content: string) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `m_local_${prev.length}_${Date.now()}`,
          threadId: 'th_1',
          role: 'user',
          content,
          createdAt: new Date().toISOString(),
        },
      ]);
      follow.current = true;
      requestAnimationFrame(() => scrollToBottom());
      stream.send(content);
    },
    [scrollToBottom, stream],
  );

  const retry = useCallback(() => {
    follow.current = true;
    stream.retry();
  }, [stream]);

  const toggleAction = useCallback((id: string, done: boolean) => {
    setActions((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: done ? '完成' : '待办' } : a)),
    );
  }, []);

  const confirmDraft = useCallback((id: string) => {
    setConfirmedDrafts((prev) => new Set(prev).add(id));
    setAskingDraft(null);
  }, []);

  const actionsById = useMemo(
    () => new Map(actions.map((a) => [a.id, a])),
    [actions],
  );

  if (!seeded && !signedIn) {
    return (
      <div className="pt-8">
        <EmptyState
          title="这个案件还没有对话记录"
          description="先做一次首诊：把被裁的经过、工资和司龄讲清楚。首诊结束后这里会有时间线、诉求初算金额，以及接下来 7 天要做的事。"
          action={
            <Link
              href="/intake"
              className="inline-flex h-12 items-center justify-center rounded-[10px] bg-primary px-5 text-[16px] font-medium text-white transition-opacity duration-150 ease-out hover:opacity-90"
            >
              去做首诊
            </Link>
          }
        />
      </div>
    );
  }

  /** 流里正在长出来的那条回复 */
  const live: StreamedMessage = {
    id: 'streaming',
    threadId: stream.meta?.thread_id ?? 'th_1',
    role: 'assistant',
    content: stream.text,
    createdAt: new Date().toISOString(),
    records: stream.records,
    notices: stream.notices,
    drafts: stream.drafts,
    degraded: stream.meta?.degraded,
  };

  return (
    <>
      {/* AppShell 的 main 限宽 860px；工作台在 PC 需要双栏，这里向两侧扩展。 */}
      <div className="lg:relative lg:left-1/2 lg:w-[min(1180px,calc(100vw-160px))] lg:-translate-x-1/2">
        {seeded && <MobileBar onOpenPanel={() => setPanelOpen(true)} />}

        <div className="lg:flex lg:items-start lg:gap-6">
          <div className="min-w-0 lg:flex-1">
            {stream.demoFallback && <DemoDataBanner />}

            <div className="flex flex-col">
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const newDay =
                  !prev || formatDate(prev.createdAt) !== formatDate(m.createdAt);
                return (
                  <div key={m.id}>
                    {newDay && <DateDivider iso={m.createdAt} />}
                    {m.role === 'user' ? (
                      <UserMessage message={m} />
                    ) : (
                      <AssistantMessage
                        message={m}
                        caseId={caseId}
                        confirmedDrafts={confirmedDrafts}
                        onRequestConfirmDraft={setAskingDraft}
                        actions={(m.actionItemIds ?? [])
                          .map((id) => actionsById.get(id))
                          .filter((a): a is ActionItem => Boolean(a))}
                        onToggleAction={toggleAction}
                      />
                    )}
                  </div>
                );
              })}

              {stream.phase === 'connecting' && <AcceptedLine />}

              {stream.phase === 'waiting' && stream.waitBaseAt !== null && (
                <WaitingCard
                  baseAt={stream.waitBaseAt}
                  model={stream.meta?.model ?? null}
                  onJumpToActions={actions.length > 0 ? jumpToActions : undefined}
                  onLongWait={keepAtBottom}
                />
              )}

              {(stream.phase === 'streaming' ||
                (stream.phase === 'error' && stream.text)) && (
                <AssistantMessage
                  streaming={stream.phase === 'streaming'}
                  message={live}
                  caseId={caseId}
                  confirmedDrafts={confirmedDrafts}
                  onRequestConfirmDraft={setAskingDraft}
                  actions={[]}
                  onToggleAction={toggleAction}
                />
              )}

              {stream.error && <StreamErrorCard error={stream.error} onRetry={retry} />}
            </div>

            <Composer streaming={stream.busy} onSend={send} onStop={stream.stop} />
            {/* 锚点放在输入区之后：滚到底时最新一段正好落在输入区上方 */}
            <div ref={bottom} className="h-px" />
          </div>

          {seeded && (
            <aside className="hidden lg:sticky lg:top-[68px] lg:block lg:max-h-[calc(100dvh-88px)] lg:w-[360px] lg:shrink-0 lg:overflow-y-auto lg:pb-4">
              <h2 className="mb-2 px-1 text-[15px] font-semibold text-ink">案件档案</h2>
              <CasePanel caseId={caseId} actions={actions} />
            </aside>
          )}
        </div>

        <Sheet open={panelOpen} onClose={() => setPanelOpen(false)} title="案件档案">
          <CasePanel caseId={caseId} actions={actions} />
        </Sheet>
      </div>

      {/* 变换容器会成为 fixed 的参照系，确认弹窗必须挂在它外面 */}
      <DraftConfirmDialog
        draft={askingDraft}
        onCancel={() => setAskingDraft(null)}
        onConfirm={confirmDraft}
      />
    </>
  );
}

/** 移动端：档案入口 + 最近截止日，PC 上档案常驻右栏，这条不出现 */
function MobileBar({ onOpenPanel }: { onOpenPanel: () => void }) {
  const nearest = [...demoDeadlines].sort((a, b) =>
    a.dueAt.localeCompare(b.dueAt),
  )[0];

  return (
    <div className="sticky top-14 z-30 -mx-4 mb-1 flex items-center gap-2 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur-sm lg:hidden">
      <Badge tone="primary">{demoCase.stage}</Badge>
      {nearest && <DeadlineChip dueAt={nearest.dueAt} />}
      <button
        type="button"
        onClick={onOpenPanel}
        className="ml-auto flex h-11 shrink-0 items-center rounded-[10px] border border-line bg-surface px-3 text-[14px] text-ink transition-colors duration-150 ease-out active:bg-surface-2"
      >
        案件档案
      </button>
    </div>
  );
}
