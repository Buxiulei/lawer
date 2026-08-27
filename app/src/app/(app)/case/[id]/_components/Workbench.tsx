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
import { Badge } from '@/components/shadcn/badge';
import { EmptyState } from '@/components/shadcn/empty-state';
import { AppSheet } from '@/components/shadcn/app-sheet';
import { Button } from '@/components/shadcn/button';
import { DeadlineChip } from '@/components/case/DeadlineChip';
import { useRegisterCasePanel } from '@/components/shell/casePanel';
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

  // 顶栏那个「案件档案」按钮由壳层渲染，这里把开抽屉的动作交给它
  const openPanel = useCallback(() => setPanelOpen(true), []);
  useRegisterCasePanel(seeded ? openPanel : null);

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
          deterministicChars: turn.deterministicChars,
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
            <Button asChild>
              <Link href="/intake">去做首诊</Link>
            </Button>
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
    deterministicChars: stream.deterministicChars,
    createdAt: new Date().toISOString(),
    records: stream.records,
    notices: stream.notices,
    drafts: stream.drafts,
    degraded: stream.meta?.degraded,
  };

  return (
    <>
      {/* data-wide 让 AppShell 的 main 把限宽抬到 1280；双栏在 xl 起排开，
          再窄就只剩对话流，档案走顶栏按钮的抽屉。 */}
      <div data-wide>
        {seeded && <CaseStatusBar />}

        <div className="xl:flex xl:items-start xl:gap-6">
          {/* 断点：<md 满宽单列；md–lg 居中限宽（**这是 768 与 393 版式不同的可量证据**：
              同一段文字的左边界 x 会从 16px 变成 (视口-672)/2）；xl 起是双栏左列。 */}
          <div className="min-w-0 md:mx-auto md:max-w-2xl xl:mx-0 xl:max-w-4xl xl:flex-1">
            {stream.demoFallback && <DemoDataBanner />}

            <div className="flex flex-col gap-5 md:gap-7">
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

              {/* 等待态也可能已有文本（deterministic 首段），这时消息排在等待卡上方 */}
              {(stream.text || stream.phase === 'streaming') && (
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

              {stream.phase === 'waiting' && stream.waitBaseAt !== null && (
                <WaitingCard
                  baseAt={stream.waitBaseAt}
                  model={stream.meta?.model ?? null}
                  onJumpToActions={actions.length > 0 ? jumpToActions : undefined}
                  onLongWait={keepAtBottom}
                />
              )}

              {stream.error && <StreamErrorCard error={stream.error} onRetry={retry} />}
            </div>

            <Composer streaming={stream.busy} onSend={send} onStop={stream.stop} />
            {/* 锚点放在输入区之后：滚到底时最新一段正好落在输入区上方 */}
            <div ref={bottom} className="h-px" />
          </div>

          {seeded && (
            <aside className="hidden xl:sticky xl:top-[68px] xl:block xl:max-h-[calc(100dvh-88px)] xl:w-[360px] xl:shrink-0 xl:overflow-y-auto xl:pb-4">
              <h2 className="mb-2 px-1 text-[15px] font-semibold text-ink">案件档案</h2>
              <CasePanel caseId={caseId} actions={actions} />
            </aside>
          )}
        </div>

        <AppSheet open={panelOpen} onClose={() => setPanelOpen(false)} title="案件档案">
          <CasePanel caseId={caseId} actions={actions} />
        </AppSheet>
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

/**
 * 阶段 + 最近截止日。双栏排开（xl）之后这两条在右栏档案里都有，就不再重复。
 * 档案入口本身已经上移到壳层顶栏。
 */
function CaseStatusBar() {
  const nearest = [...demoDeadlines].sort((a, b) =>
    a.dueAt.localeCompare(b.dueAt),
  )[0];

  return (
    <section className="mb-4 overflow-hidden rounded-[12px] xl:hidden">
      {/* 分量 4：金色填色顶栏 + 白底内容、**无外框**。
          没有外框是刻意的——行动卡才是「实边框 + 填色顶栏」那一档，
          期限只有顶栏，两者在灰度下也分得开（验收第 2、3 条）。
          金色不用红：红只留给风险条款与不可逆操作。

          **顶栏用淡金 --gold-wash 而不是规格写的深金 --gold**：实测 --ink(#2b1f1a)
          压在深金(#8a7340)上只有 **3.68:1**，14px 正文过不了 4.5；换淡金(#f5e6c8)是
          **13.59:1**。深色模式下同理（淡金档 #2e2717 配浅色 ink 是 12.4:1，
          而深金 #c9a75b 配浅 ink 只有 1.6:1，更糟）。
          顺带的好处：淡金底比行动卡的勃艮第实底轻，**分量 4 在 5 之下这件事因此更明显**。 */}
      <h2 className="bg-gold-wash px-3.5 py-1.5 text-[14px] font-semibold text-ink">
        当前阶段与最近期限
      </h2>
      <div className="flex flex-wrap items-center gap-2 bg-surface px-3.5 py-2.5">
        {/* data-veil 不挂在外层：filter 会拽走 fixed 子孙。
            Badge 又不透传 props，只好在它外面包一层 inline-flex */}
        <span data-veil="" className="inline-flex">
          <Badge tone="primary">{demoCase.stage}</Badge>
        </span>
        {nearest && <DeadlineChip dueAt={nearest.dueAt} showDate />}
      </div>
    </section>
  );
}
