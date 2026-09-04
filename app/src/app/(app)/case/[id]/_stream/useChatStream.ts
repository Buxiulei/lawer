'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { demoCase } from '@/app/_mock/demo';
import type {
  ActionFrame,
  DraftFrame,
  ErrorFrame,
  MetaFrame,
  NoticeFrame,
  RecordFrame,
  StreamFrame,
} from './frames';
import type { StreamedMessage } from '../_components/Messages';
import { fetchCaseMessages } from './caseHistory';
import { createHttpTransport, readToken } from './httpTransport';
import { createMockTransport } from './mockTransport';
import {
  findReconciledAnswer,
  reconcileVerdict,
  stalledError,
} from './reconcile';
import {
  NeedsDemoFallbackError,
  SessionExpiredError,
  type ChatTransport,
} from './transport';
import { createWatchdog, HEARTBEAT_MS, type Watchdog } from './watchdog';

/**
 * `reconnecting` = 看门狗判定连接静默死亡后，正在去库里把这一轮的答案取回来（对账）。
 * 它仍算「忙」（Composer 显示停止键、不接收发送），但**不再**算「会静默死亡的活跃态」——
 * 所以看门狗的 isActive 不含它，对账进行中不会被自己重复触发（见 watchdog.ts）。
 */
export type StreamPhase =
  | 'idle'
  | 'connecting'
  | 'waiting'
  | 'streaming'
  | 'reconnecting'
  | 'error';

export interface StreamError {
  code: string;
  message: string;
  /** 秒；有值时重试按钮要等倒计时走完 */
  retryAfter?: number;
  /**
   * 这一轮的失败**已经落成的那条 assistant 行**的 id（服务端 error 帧带回来的）。
   * 重试时把它发回去：服务端重发同一句问话，且不再插一条新的用户消息。
   * 缺席 = 这次失败没落成行（例如根本没连上），那时只能退回"照原文再发一次"。
   */
  messageId?: string;
  /** 公道值余额；只有 GONGDAO_EXHAUSTED 带。横幅照它说话，缺席时横幅不报数字 */
  balance?: number;
}

/** 一轮对话落定后交给页面的东西 */
export interface SettledTurn {
  messageId: string;
  meta: MetaFrame | null;
  text: string;
  /** text 前多少个字符来自 deterministic 首段；0 = 本轮没有。落档案的是全文 */
  deterministicChars: number;
  records: RecordFrame[];
  actions: ActionFrame[];
  drafts: DraftFrame[];
  notices: NoticeFrame[];
  /**
   * 本轮**实际**服务的型号（done 帧回显）。null = 没回显过——
   * 这时才退回 meta.model（我们请求的那个），两者不可混为一谈。
   */
  servedModel: string | null;
  /** 实际服务的型号与请求的不是同一个。判据来自服务端，前端不自己比字符串 */
  servedMismatch: boolean;
  /** 收到 done 帧才算完整；中途停止/断流为 false */
  complete: boolean;
}

interface State {
  phase: StreamPhase;
  meta: MetaFrame | null;
  text: string;
  /** deterministic 首段在 text 里占的前缀长度，供 UI 单独渲染「即时回应」 */
  deterministicChars: number;
  records: RecordFrame[];
  actions: ActionFrame[];
  drafts: DraftFrame[];
  notices: NoticeFrame[];
  error: StreamError | null;
  /** 等待起点（毫秒时间戳），ping 到达时按 waited_seconds 校准 */
  waitBaseAt: number | null;
}

export const INITIAL: State = {
  phase: 'idle',
  meta: null,
  text: '',
  deterministicChars: 0,
  records: [],
  actions: [],
  drafts: [],
  notices: [],
  error: null,
  waitBaseAt: null,
};

type Action =
  | { type: 'start' }
  | { type: 'reset' }
  | { type: 'reconnecting' }
  | { type: 'frame'; frame: StreamFrame };

export function reduce(state: State, action: Action): State {
  if (action.type === 'start') return { ...INITIAL, phase: 'connecting' };
  if (action.type === 'reset') return INITIAL;
  // 看门狗触发：离开 streaming/waiting/connecting，但保住已经流出来的正文与 meta
  // （对账若把答案补上，那段正文随 reset 让位给库里的整段；对账落 STALLED 则 error 卡接手）。
  if (action.type === 'reconnecting') return { ...state, phase: 'reconnecting' };

  const frame = action.frame;
  switch (frame.type) {
    case 'meta':
      return { ...state, meta: frame, phase: 'waiting', waitBaseAt: Date.now() };
    case 'ping':
      // 心跳只校准计时基准，不是错误、也不改阶段
      return { ...state, waitBaseAt: Date.now() - frame.waited_seconds * 1000 };
    case 'delta':
      // 确定性首段只是先接住人，模型还没开口：追加文本但留在等待态，
      // waitBaseAt 不清、ping 继续校准，等待卡照旧跳秒。
      if (frame.deterministic) {
        return {
          ...state,
          text: state.text + frame.text,
          deterministicChars: state.deterministicChars + frame.text.length,
        };
      }
      return {
        ...state,
        phase: 'streaming',
        waitBaseAt: null,
        text: state.text + frame.text,
      };
    case 'record':
      return { ...state, records: [...state.records, frame] };
    case 'action':
      return { ...state, actions: [...state.actions, frame] };
    case 'draft':
      return { ...state, drafts: [...state.drafts, frame] };
    case 'notice':
      return { ...state, notices: [...state.notices, frame] };
    case 'error':
      return { ...state, phase: 'error', error: toStreamError(frame) };
    default:
      return state;
  }
}

/**
 * error 帧 → StreamError 的**唯一一份**换算。状态机与 onFailed 回调都走它：
 * 各抄一遍的下场是其中一处漏抄一个字段（balance 就漏过一次），而漏抄的那一处照样不报错。
 */
function toStreamError(frame: ErrorFrame): StreamError {
  return {
    code: frame.code,
    message: frame.message,
    retryAfter: frame.retry_after,
    messageId: frame.message_id,
    balance: frame.balance,
  };
}

function emptyTurn(): SettledTurn {
  return {
    messageId: '',
    meta: null,
    text: '',
    deterministicChars: 0,
    records: [],
    actions: [],
    drafts: [],
    notices: [],
    servedModel: null,
    servedMismatch: false,
    complete: false,
  };
}

/**
 * 一轮对话的收帧与状态机。组件只看 phase/text/…，不关心背后是 mock 还是真端点。
 * demo 案件恒走演示数据；其余案件**没登录**才回落演示数据并挂横幅。
 * 登录态失效（原本有 token 的 401）不在此列：那一支交给案件路由 layout 上的闸门，
 * 回落演示等于把别人的案情当他的答案端出去（F-202 复核 MF-1）。
 */
export function useChatStream({
  caseId,
  onSettled,
  onFailed,
  onRecovered,
  fetchHistory = fetchCaseMessages,
}: {
  caseId: string;
  onSettled: (turn: SettledTurn) => void;
  /**
   * 这一轮以 error 帧收场时叫一声（服务端给了错误码，与断网不是一回事）。
   * 页面据此收拾自己那份乐观回显——被余额闸拦下的那一轮服务端一个字都没落库，
   * 屏幕上那句问话得撤回去。错误本身照旧进 state.error，这个回调只报「发生了」。
   */
  onFailed?: (error: StreamError) => void;
  /**
   * 对账把一轮**丢了连接、但服务端已答完落库**的回答从库里取回来时叫一声，
   * 把那条 assistant 消息（已带 recovered 标记）交给页面补进流里。走单独一条路而不是
   * onSettled：这条消息来自历史行、字段齐全（含实际型号），不必再拼一个 SettledTurn。
   */
  onRecovered?: (message: StreamedMessage) => void;
  /** 对账取历史的数据层。默认就是历史那一套 fetchCaseMessages（不另起第二套）；注入仅供测试。 */
  fetchHistory?: (caseId: string) => Promise<StreamedMessage[]>;
}) {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  /** 真端点回落到演示数据：要在页面上说明白，不能让人以为看的是自己的档案 */
  const [demoFallback, setDemoFallback] = useState(false);

  const mock = useMemo(() => createMockTransport(), []);
  const http = useMemo(() => createHttpTransport(), []);
  const forceMock = caseId === demoCase.id;

  const abort = useRef<AbortController | null>(null);
  const lastMessage = useRef('');
  /**
   * 刚才那次失败**落成的那条 assistant 行**的 id（服务端 error 帧带回来的）。
   * 重试拿它当 retry_of：服务端据此重发同一句问话，且不再插一条新的用户消息。
   * undefined = 这次失败没落成行（连都没连上），那时只能退回"照原文再发一次"。
   */
  const lastFailedId = useRef<string | undefined>(undefined);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const failedRef = useRef(onFailed);
  failedRef.current = onFailed;
  const recoveredRef = useRef(onRecovered);
  recoveredRef.current = onRecovered;

  /** 本轮那条 assistant 行的库主键（meta 帧带回来）。对账拿它去历史里认领这一轮的回答。 */
  const metaMessageId = useRef<string | null>(null);
  /** 看门狗实例（挂载时建，卸载时拆）。收帧时 touch 它，把静默计时清零。 */
  const watchdog = useRef<Watchdog | null>(null);
  /** 对账「再等一窗」的定时器。 */
  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 对账试到第几次（reconcileVerdict 用它决定「再等」还是「认栽」）。 */
  const reconcileAttempt = useRef(0);
  /** 对账进行中：挡住看门狗与可见性同时来两下时的重入。 */
  const reconciling = useRef(false);

  const clearReconcileTimer = () => {
    if (reconcileTimer.current !== null) {
      clearTimeout(reconcileTimer.current);
      reconcileTimer.current = null;
    }
  };

  /**
   * 一次对账：重取本案历史，看这一轮的回答在库里了没有。
   *  · 有 ⇒ 当 done 落定，交给页面补进流里（末尾会标「连接中断过，已把回答补上」）；
   *  · 还没有、且没试满 ⇒ 保持 reconnecting，过一个心跳窗口再来一次；
   *  · 试满还没有 ⇒ 落 STALLED 错误卡（带重试，retry_of 用已知的 message_id）。
   * 取历史本身失败也按「还没有」处理——宁可多等一窗/最终给重试，也不把失败当成「没答」。
   */
  const reconcile = useCallback(async () => {
    // 被 stop() 或新一轮接管后，遗留的定时器回调可能还会打进来：这时别再动状态
    if (!reconciling.current) return;
    reconcileAttempt.current += 1;
    const attempt = reconcileAttempt.current;

    let answer: StreamedMessage | null = null;
    try {
      const rows = await fetchHistory(caseId);
      answer = findReconciledAnswer(rows, metaMessageId.current);
    } catch {
      answer = null;
    }

    // 取历史这一段 await 期间用户可能已经停止 / 又发了一句：那就交出去，别拿旧意图改状态
    if (!reconciling.current) return;

    const verdict = reconcileVerdict(answer, attempt);
    if (verdict.kind === 'pending') {
      reconcileTimer.current = setTimeout(() => void reconcile(), HEARTBEAT_MS);
      return;
    }

    // 终态：对账收工
    reconciling.current = false;
    reconcileAttempt.current = 0;
    clearReconcileTimer();

    if (verdict.kind === 'recovered') {
      recoveredRef.current?.({ ...verdict.message, recovered: true });
      dispatch({ type: 'reset' });
      return;
    }

    // stalled：错误卡进流（重试靠 message_id），并叫 onFailed 一声让页面把末尾带进视野
    lastFailedId.current = metaMessageId.current ?? undefined;
    const err = stalledError(metaMessageId.current);
    dispatch({ type: 'frame', frame: err });
    failedRef.current?.(toStreamError(err));
  }, [caseId, fetchHistory]);

  /**
   * 看门狗/可见性叫醒后进对账：掐掉可能还挂着的僵尸 fetch，phase 离开 streaming/waiting，
   * 进入 reconnecting，然后去库里取答案。已经在对账就不再重入。
   */
  const triggerReconcile = useCallback(() => {
    if (reconciling.current) return;
    reconciling.current = true;
    reconcileAttempt.current = 0;
    clearReconcileTimer();
    abort.current?.abort();
    dispatch({ type: 'reconnecting' });
    void reconcile();
  }, [reconcile]);

  // 看门狗只在这几态才该触发：真正「会静默死亡」的等答态。reconnecting/error/idle 不含在内，
  // 所以对账进行中、已落错误卡、或空闲时，看门狗都不会（再）触发。
  const isActiveRef = useRef(false);
  isActiveRef.current =
    state.phase === 'connecting' ||
    state.phase === 'waiting' ||
    state.phase === 'streaming';
  const triggerRef = useRef(triggerReconcile);
  triggerRef.current = triggerReconcile;

  useEffect(() => {
    const wd = createWatchdog({
      isActive: () => isActiveRef.current,
      onStall: () => triggerRef.current(),
      onReturnToVisible: () => triggerRef.current(),
    });
    watchdog.current = wd;
    return () => {
      wd.stop();
      watchdog.current = null;
      clearReconcileTimer();
    };
  }, []);

  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(
    async (message: string, retryOf?: string) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      // 重试走 retryOf（正文由服务端从库里取），别拿空串把上一句问话冲掉
      if (message) lastMessage.current = message;
      lastFailedId.current = undefined;
      // 新一轮开跑：清掉上一轮遗留的对账状态与锚点，看门狗计时也从此刻起算
      metaMessageId.current = null;
      reconciling.current = false;
      reconcileAttempt.current = 0;
      clearReconcileTimer();
      watchdog.current?.touch();
      dispatch({ type: 'start' });

      const turn = emptyTurn();
      const req = { caseId, message, signal: controller.signal, retryOf };

      const consume = async (transport: ChatTransport) => {
        for await (const frame of transport.send(req)) {
          // 已被看门狗/停止接管（abort 过）：迟到的缓冲帧别再拿去改状态，
          // 否则一帧 delta 就会把已经 reset/reconnecting 的 phase 又拽回 streaming。
          if (controller.signal.aborted) break;
          // 任意一帧（含 ping）都算「连接还活着」：给看门狗续命
          watchdog.current?.touch();
          dispatch({ type: 'frame', frame });
          switch (frame.type) {
            case 'meta':
              turn.meta = frame;
              turn.messageId = frame.message_id;
              metaMessageId.current = frame.message_id;
              break;
            case 'delta':
              turn.text += frame.text;
              if (frame.deterministic) turn.deterministicChars += frame.text.length;
              break;
            case 'record':
              turn.records.push(frame);
              break;
            case 'action':
              turn.actions.push(frame);
              break;
            case 'draft':
              turn.drafts.push(frame);
              break;
            case 'notice':
              turn.notices.push(frame);
              break;
            case 'usage':
              // 计费展示归 /account，本期只留痕。null 表示该桶无数据，不是 0
              console.debug('[chat-usage]', frame);
              break;
            case 'done':
              turn.complete = true;
              // 「这一轮实际是谁答的」只有这一帧知道（meta 那时还没开跑）
              turn.servedModel = frame.served_model ?? null;
              turn.servedMismatch = frame.served_mismatch === true;
              break;
            case 'error':
              // 这一轮的失败已经落成一条 assistant 行；记下它，重试要指名道姓
              lastFailedId.current = frame.message_id;
              failedRef.current?.(toStreamError(frame));
              return false;
          }
        }
        return true;
      };

      let ok = false;
      try {
        ok = await consume(forceMock ? mock : http);
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          // 闸门（case/[id]/layout 的 SessionGate）此刻已经接手整块屏幕：
          // 既不回落演示数据（那是别人的案情），也不留一张点不动的错误卡。
          dispatch({ type: 'reset' });
          return;
        }
        if (err instanceof NeedsDemoFallbackError) {
          setDemoFallback(true);
          try {
            ok = await consume(mock);
          } catch {
            ok = false;
          }
        } else if (!controller.signal.aborted) {
          console.warn('[chat-sse] 连接中断', err);
          dispatch({
            type: 'frame',
            frame: {
              type: 'error',
              code: 'NETWORK',
              message: '网络断了，刚才那段没能说完。',
            },
          });
        }
      }

      if (!ok) return; // 错误卡留在流里，等用户点重试
      if (turn.text.trim() || turn.records.length || turn.actions.length) {
        settledRef.current(turn);
      }
      dispatch({ type: 'reset' });
    },
    [caseId, forceMock, http, mock],
  );

  const send = useCallback((message: string) => void run(message), [run]);
  /**
   * 重试某一条**已经落库的失败轮**（刷新后从历史里点进来的那条，也包括本轮刚失败的那条）。
   * 走 retry_of 而不是"把原文再发一遍"：后者会在档案里插第二句一模一样的问话。
   */
  const retryFailed = useCallback((failedMessageId: string) => void run('', failedMessageId), [run]);
  const retry = useCallback(() => {
    // 失败已经落成行 ⇒ 按行重试（不重复插用户消息）；没落成行才退回照原文再发一次
    const failedId = lastFailedId.current;
    if (failedId) {
      void run('', failedId);
      return;
    }
    if (lastMessage.current) void run(lastMessage.current);
  }, [run]);
  /**
   * 停止这一轮。**不只是 abort**：单 abort 会让收帧循环走进「已中止」分支后原地返回，
   * phase 停在 streaming——Composer 于是永远锁在停止键上、发送键回不来（2026-09-04 症状之一）。
   * 所以停止要连对账一起收掉、并 reset 回 idle，把输入框交还给用户。
   */
  const stop = useCallback(() => {
    abort.current?.abort();
    reconciling.current = false;
    reconcileAttempt.current = 0;
    clearReconcileTimer();
    dispatch({ type: 'reset' });
  }, []);

  return {
    ...state,
    busy:
      state.phase === 'connecting' ||
      state.phase === 'waiting' ||
      state.phase === 'streaming' ||
      state.phase === 'reconnecting',
    demoFallback,
    send,
    retry,
    retryFailed,
    stop,
  };
}
