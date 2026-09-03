'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActionItem, LawRef } from '@/app/_mock/types';
import {
  demoActions,
  demoCase,
  demoMessages,
} from '@/app/_mock/demo';
import { mockLawRefs } from '@/app/_mock/workbench';
import { useDiscreet } from '@/app/_ui/discreet';
import { formatDate } from '@/app/_ui/format';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { scrollBehavior, useReducedMotion } from '@/app/_ui/motion';
import { EmptyState } from '@/components/shadcn/empty-state';
import { AppSheet } from '@/components/shadcn/app-sheet';
import { Button } from '@/components/shadcn/button';
import { SkeletonList } from '@/components/shadcn/skeleton';
import { useRegisterCasePanel } from '@/components/shell/casePanel';
import {
  useCaseWorkspace,
  useDossierPortal,
  useViewerPortal,
} from '../_workspace/CaseWorkspaceProvider';
import {
  lawCiteId,
  prefersReducedMotion,
  useCitationBridge,
} from './citations';
import { GONGDAO_EXHAUSTED, toActionItem, type DraftFrame } from '../_stream/frames';
import { ByoAgentNotice } from './ByoAgentNotice';
import { readToken } from '../_stream/httpTransport';
import { useCaseHistory } from '../_stream/useCaseHistory';
import { useChatStream, type SettledTurn } from '../_stream/useChatStream';
import { CasePanel } from './CasePanel';
import { CaseStatusBar } from './CaseStatusBar';
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
  GongdaoExhaustedBanner,
  StreamErrorCard,
  WaitingCard,
} from './StreamParts';

/** 跟随滚动的容差：底部在视口这个范围内才继续跟着流式输出走 */
const FOLLOW_SLACK_PX = 220;

export function Workbench({ caseId }: { caseId: string }) {
  // demo 案件有历史、走演示数据；其他 id 只有登录后才有对话可谈。
  const seeded = caseId === demoCase.id;
  const [signedIn, setSignedIn] = useState(false);

  // 历史对话。**演示案件不请求**：它有自己的剧本，那些消息不在库里。
  const history = useCaseHistory({ caseId, enabled: !seeded });

  const [messages, setMessages] = useState<StreamedMessage[]>(
    seeded ? demoMessages : [],
  );

  /* 取回来的历史落进消息列表。放 effect 而不是拿 history.messages 直接当数据源，
     是因为这条列表随后还要被本轮的一问一答追加（send / settle），
     两个来源必须合流成同一个数组，否则新消息会在下一次 history 变化时被冲掉。 */
  useEffect(() => {
    if (history.messages) setMessages(history.messages);
  }, [history.messages]);
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

  /* 程序化滚动一律过 `scrollBehavior()`。
     `globals.css` 底部那条 `* { animation-duration: .01ms }` 兜底**管不到 JS**，
     而整屏平滑滚动正是前庭敏感者最难受的一类运动——这一处此前在减弱动效下照跑。 */
  const reduce = useReducedMotion();
  const { discreet } = useDiscreet();

  // 滚到文档末尾而不是锚点：末尾处输入区回到静态位置，最后一行不会被它压住
  const scrollToBottom = useCallback(
    (smooth = true) => {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: scrollBehavior(reduce, smooth),
      });
    },
    [reduce],
  );

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
    last.scrollIntoView({ behavior: scrollBehavior(reduce), block: 'center' });
  }, [reduce]);

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
          // model = 我们请求的（meta，开跑前就知道）；servedModel = 厂商实际派了谁（done 帧）。
          // 两个都留着：底下那行小字优先标实际的，缺实际时才退回请求的。
          model: turn.meta?.model,
          servedModel: turn.servedModel,
          modelMismatch: turn.servedMismatch,
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

  /**
   * 重试一条**回显出来的失败轮**（刷新之后从历史里点进来的那条）。
   * 走 retry_of 而不是把原文再发一遍：后者会在档案里插第二句一模一样的问话。
   * 重试成功后这一行仍留在原地（它是这一轮确实失败过的如实记录），新回答排在它后面。
   */
  const retryFailedTurn = useCallback(
    (messageId: string) => {
      follow.current = true;
      stream.retryFailed(messageId);
    },
    [stream],
  );

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

  const dossier = useDossierPortal(
    seeded ? (
      <>
        <h2 className="mb-2 px-1 text-[15px] font-semibold text-ink">案件档案</h2>
        <CasePanel caseId={caseId} actions={actions} />
      </>
    ) : null,
  );

  // ── 引用桥的查看器端（批B，设计 §四「签名件」）─────────────────
  // 对话里引过的法条按 id 建索引；点一条依据，第三栏开出它的逐字原件 + scrollIntoView。
  // 反向 hover / 高亮由文档级委托（citations.ts）无 state 地完成，不在这里。
  const lawSources = useMemo(() => {
    const map = new Map<string, LawRef>();
    for (const m of messages) {
      for (const law of m.lawRefs ?? []) {
        const id = lawCiteId(law.cite);
        if (!map.has(id)) map.set(id, law);
      }
    }
    return map;
  }, [messages]);

  const { openViewer, viewer } = useCaseWorkspace();
  const [viewed, setViewed] = useState<LawRef | null>(null);

  const onActivateCitation = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        const law = lawSources.get(id);
        if (!law) continue; // 证据行等没有原件可开的 id：略过，不误开一个空查看器
        openViewer({ title: law.cite });
        setViewed(law);
        return;
      }
    },
    [lawSources, openViewer],
  );
  useCitationBridge({ onActivate: onActivateCitation });

  // 查看器被关掉（Esc / 右上角 ✕，都在 shell 里）时把正文一并撤走，不留孤儿 portal
  useEffect(() => {
    if (!viewer) setViewed(null);
  }, [viewer]);

  const original = useViewerPortal(
    viewer && viewed ? <LawOriginal law={viewed} /> : null,
  );

  /* 取数中先出骨架，**不先画一屏空对话**：真实案件几乎都有历史，
     先给空的再补上，用户看到的是"我的记录闪了一下才回来"。
     输入框此刻也不出现——在历史落定之前发出去的话，会排在历史前面。

     【它必须排在「未登录」那一屏前面】登录态要等 effect 读完 localStorage 才知道
     （SSR 那一遍读不到），首帧 `signedIn` 恒为 false。放在后面的话，一个名下有整套
     记录的人打开页面，第一帧读到的是「这个案件还没有对话记录 / 去做首诊」——
     那句话正是这次要消灭的那一句，不该在自己的修法里再闪一次。
     骨架是中性的：它只说"在读"，没有对任何人下结论。 */
  if (history.phase === 'loading') {
    return (
      <div className="pt-4">
        <SkeletonList rows={4} />
      </div>
    );
  }

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

  /* 【没取到 ≠ 没聊过】这两屏在像素上都是"一片什么都没有"，
     但上面那一屏说的是"你还没开始"。对一个刚聊完两小时的人说这句话，
     他会从头再讲一遍——那既是钱，也是又一次把被裁的经过复述一遍。
     所以取数失败必须自己占一屏：说清楚发生了什么 + 给一个重试。 */
  if (history.phase === 'failed') {
    return (
      <div className="pt-8">
        <EmptyState
          title="这次没读到你的对话记录"
          description={`${history.error ?? ''}你聊过的内容都还在，只是这一次没取回来。点下面再试一次。`}
          action={<Button onClick={history.reload}>重试</Button>}
        />
      </div>
    );
  }

  /**
   * 这一轮是被余额闸拦下的（HTTP 402），不是普通失败。
   * 判据是服务端的错误码，前端不自己认字符串里的「余额」。
   */
  const exhausted = stream.error?.code === GONGDAO_EXHAUSTED;
  // 输入框里那句「为什么打不了字」也走中性词：低调模式下屏幕上不该出现产品原词。
  const composerHint = `${discreet ? NEUTRAL_WORD.credits : '公道值'}用完了，先去兑换或充值`;

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
      {/* 排开侧栏这件事已经归工作区（case/[id]/layout.tsx 的 WorkspaceGrid）：
          这里只交出「卷宗栏里放什么」，宽度到哪一档排开由容器查询决定。
          原来的 data-wide 与手写 xl 双栏一并退役。 */}
      {/* 真实案件也出这一条，读的是自己的 stage 与最近期限；取不到就整条不出现。
          此前是 `seeded &&`：藏起来的那一半，正是「我的案子走到哪一步」本身。 */}
      <CaseStatusBar caseId={caseId} demo={seeded} />

      {/* 正文收窄阈值 736：量的是**工作区可用宽度**不是视口（红线②）。
          768 视口下可用宽是 753（减掉 15px 滚动条），落在 736 之上 →
          与改造前 `md:max-w-2xl` 生效的那一档逐像素相同；720 视口下是 705，
          两边都不收窄，也一致。393 恒在阈值之下。
          **这仍是 768 与 393 版式不同的可量证据**：同一段文字的左边界 x
          会从 16px 变成 (可用宽-672)/2。 */}
      <div className="min-w-0 @min-[736px]/work:mx-auto @min-[736px]/work:max-w-2xl">
        {/* 已接入自己 agent 的人才看得到；没接入时它自己返回 null。
            放在正文收窄容器内，左边界与消息对齐——它是说给这一栏听的一句话。 */}
        <ByoAgentNotice />
        {stream.demoFallback && <DemoDataBanner />}

        <div className="flex flex-col gap-5 md:gap-7">
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const newDay =
              !prev || formatDate(prev.createdAt) !== formatDate(m.createdAt);
            /* 【失败轮：横幅 + 重试，刷新后原样还在】(naive-qa-2 F-203)
               这一行的 content 是那段三段式失败文案，不是回答——当回答画出去，
               "模型连不上"读起来就成了律师在回答问题。
               工单原文是「渲染出横幅与重试」，没有限定哪一条 ⇒ **每一条失败轮都给重试**，
               包括后面已经有新回答的那些（重试走 retry_of，新回答排在末尾，这一行留在原地）。
               若要把重试收窄成"只给最后一条"（避免对已答过的问题重复收费），
               那是一条产品裁决，得先进台账、再改这里——不在注释里自行裁定。 */
            if (m.failedCode) {
              return (
                <div key={m.id}>
                  {newDay && <DateDivider iso={m.createdAt} />}
                  <StreamErrorCard
                    error={{ code: m.failedCode, message: m.content }}
                    onRetry={
                      m.failedMessageId ? () => retryFailedTurn(m.failedMessageId!) : undefined
                    }
                  />
                </div>
              );
            }
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

          {/* 余额用尽自成一屏内容：那不是「这一轮没说完」，重试再多次也不会有回答，
              出路在兑换 / 充值两个入口上。所以换横幅、且不给重试按钮。 */}
          {stream.error &&
            (exhausted ? (
              <GongdaoExhaustedBanner balance={stream.error.balance} />
            ) : (
              <StreamErrorCard error={stream.error} onRetry={retry} />
            ))}
        </div>

        {/* 余额用尽时输入框禁用：能打字、点发送、每次被同一句话弹回来，读起来像产品坏了。
            余额一恢复（去 /account 兑换或充值后回来，这一屏重挂）输入框跟着回来。 */}
        <Composer
          streaming={stream.busy}
          onSend={send}
          onStop={stream.stop}
          disabled={exhausted}
          disabledPlaceholder={composerHint}
        />
        {/* 锚点放在输入区之后：滚到底时最新一段正好落在输入区上方 */}
        <div ref={bottom} className="h-px" />
      </div>

      {/* 档案投送到卷宗栏。用 portal 而不是把节点交给上层：这段内容留在
          Workbench 自己的 React 树里，actions 变了照常更新，SSE 一点都不知情。 */}
      {dossier}
      {/* 逐字原件投送到查看器（第三栏）。同理走 portal：正文留在本树里，
          开合只由 shell 的 data-viewer 决定，宽度不够那一档 CSS 自己收起。 */}
      {original}

      <AppSheet open={panelOpen} onClose={() => setPanelOpen(false)} title="案件档案">
        <CasePanel caseId={caseId} actions={actions} />
      </AppSheet>

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
 * 查看器里的逐字原件（引用桥的第三栏）。标题（条号）由 shell 的 ViewerPane 渲染，
 * 这里只出结论 + 逐字原文。挂载/切换时 scrollIntoView，把刚开的原件带进视野
 * （窄桌面档查看器可能在折叠边缘）。
 *
 * 结论一句里带着案情（「你在朝阳上班，递朝阳」），所以整块进糊层；
 * 逐字法条是公开法律、本可不糊，但和结论同处一块，一并糊了更省心。
 */
function LawOriginal({ law }: { law: LawRef }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, []);
  return (
    <div ref={ref} data-veil="" className="prose-measure">
      <p className="text-[15px] leading-7 text-ink">{law.conclusion}</p>
      <blockquote className="mt-3 border-l-2 border-line pl-3 text-[15px] leading-7 text-ink-2">
        {law.fullText}
      </blockquote>
    </div>
  );
}
