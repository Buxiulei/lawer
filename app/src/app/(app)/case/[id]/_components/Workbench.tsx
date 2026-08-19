'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActionItem, Message } from '@/app/_mock/types';
import {
  demoActions,
  demoCase,
  demoDeadlines,
  demoMessages,
} from '@/app/_mock/demo';
import { workbenchReplies, type ReplyScript } from '@/app/_mock/workbench';
import { formatDate } from '@/app/_ui/format';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Sheet } from '@/components/ui/Sheet';
import { DeadlineChip } from '@/components/case/DeadlineChip';
import { CasePanel } from './CasePanel';
import { Composer } from './Composer';
import {
  AssistantMessage,
  DateDivider,
  UserMessage,
  WaitingLine,
} from './Messages';
import { useMockStream } from './useMockStream';

/** 跟随滚动的容差：底部在视口这个范围内才继续跟着流式输出走 */
const FOLLOW_SLACK_PX = 220;

export function Workbench({ caseId }: { caseId: string }) {
  // mock 阶段只有 demo 案件有历史；其他 id 一律走空案件态。
  const seeded = caseId === demoCase.id;

  const [messages, setMessages] = useState<Message[]>(seeded ? demoMessages : []);
  const [actions, setActions] = useState<ActionItem[]>(seeded ? demoActions : []);
  const [replyIndex, setReplyIndex] = useState(0);
  /** 正在流式输出的那条脚本，等待文案要跟它走 */
  const [active, setActive] = useState<ReplyScript | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const { phase, text, start, stop } = useMockStream();

  const bottom = useRef<HTMLDivElement>(null);
  const follow = useRef(false);

  // 滚到文档末尾而不是锚点：末尾处输入区回到静态位置，最后一行不会被它压住
  const scrollToBottom = useCallback((smooth = true) => {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }, []);

  // 流式中只在用户还停在底部时跟随；一旦用户往回翻，这一轮就不再拽他
  useEffect(() => {
    if (!follow.current || !text) return;
    const rect = bottom.current?.getBoundingClientRect();
    if (rect && rect.top - window.innerHeight > FOLLOW_SLACK_PX) {
      follow.current = false;
      return;
    }
    scrollToBottom(false);
  }, [text, scrollToBottom]);

  const send = useCallback(
    (content: string) => {
      const script = workbenchReplies[replyIndex % workbenchReplies.length];
      const now = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        {
          id: `m_local_${prev.length}_${Date.now()}`,
          threadId: 'th_1',
          role: 'user',
          content,
          createdAt: now,
        },
      ]);
      setReplyIndex((i) => i + 1);
      setActive(script);
      follow.current = true;
      requestAnimationFrame(() => scrollToBottom());

      start(script.content, (partial) => {
        setActive(null);
        // 回复落定后行动卡才出现，再滚一次让「现在做什么」进视野
        if (follow.current) setTimeout(() => scrollToBottom(), 80);
        follow.current = false;
        if (!partial.trim()) return;
        const complete = partial.length >= script.content.length;
        setMessages((prev) => [
          ...prev,
          {
            id: `m_reply_${script.id}_${Date.now()}`,
            threadId: 'th_1',
            role: 'assistant',
            content: partial,
            createdAt: new Date().toISOString(),
            actionItemIds: complete ? script.actions.map((a) => a.id) : [],
            lawRefs: complete ? script.lawRefs : [],
          },
        ]);
        if (complete) setActions((prev) => [...prev, ...script.actions]);
      });
    },
    [replyIndex, start, scrollToBottom],
  );

  const toggleAction = useCallback((id: string, done: boolean) => {
    setActions((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: done ? '完成' : '待办' } : a)),
    );
  }, []);

  const actionsById = useMemo(
    () => new Map(actions.map((a) => [a.id, a])),
    [actions],
  );

  if (!seeded) {
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

  return (
    // AppShell 的 main 限宽 860px；工作台在 PC 需要双栏，这里向两侧扩展。
    <div className="lg:relative lg:left-1/2 lg:w-[min(1180px,calc(100vw-160px))] lg:-translate-x-1/2">
      <MobileBar onOpenPanel={() => setPanelOpen(true)} />

      <div className="lg:flex lg:items-start lg:gap-6">
        <div className="min-w-0 lg:flex-1">
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
                      actions={(m.actionItemIds ?? [])
                        .map((id) => actionsById.get(id))
                        .filter((a): a is ActionItem => Boolean(a))}
                      onToggleAction={toggleAction}
                    />
                  )}
                </div>
              );
            })}

            {phase === 'waiting' && active && <WaitingLine label={active.waiting} />}
            {phase === 'streaming' && (
              <AssistantMessage
                streaming
                message={{
                  id: 'streaming',
                  threadId: 'th_1',
                  role: 'assistant',
                  content: text,
                  createdAt: new Date().toISOString(),
                }}
                actions={[]}
                onToggleAction={toggleAction}
              />
            )}
          </div>

          <Composer streaming={phase !== 'idle'} onSend={send} onStop={stop} />
          {/* 锚点放在输入区之后：滚到底时最新一段正好落在输入区上方 */}
          <div ref={bottom} className="h-px" />
        </div>

        <aside className="hidden lg:sticky lg:top-[68px] lg:block lg:max-h-[calc(100dvh-88px)] lg:w-[360px] lg:shrink-0 lg:overflow-y-auto lg:pb-4">
          <h2 className="mb-2 px-1 text-[15px] font-semibold text-ink">案件档案</h2>
          <CasePanel caseId={caseId} actions={actions} />
        </aside>
      </div>

      <Sheet open={panelOpen} onClose={() => setPanelOpen(false)} title="案件档案">
        <CasePanel caseId={caseId} actions={actions} />
      </Sheet>
    </div>
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
