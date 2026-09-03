'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { demoCase } from '@/app/_mock/demo';
import type {
  ActionFrame,
  DraftFrame,
  MetaFrame,
  NoticeFrame,
  RecordFrame,
  StreamFrame,
} from './frames';
import { createHttpTransport, readToken } from './httpTransport';
import { createMockTransport } from './mockTransport';
import {
  NeedsDemoFallbackError,
  SessionExpiredError,
  type ChatTransport,
} from './transport';

export type StreamPhase = 'idle' | 'connecting' | 'waiting' | 'streaming' | 'error';

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

type Action = { type: 'start' } | { type: 'reset' } | { type: 'frame'; frame: StreamFrame };

export function reduce(state: State, action: Action): State {
  if (action.type === 'start') return { ...INITIAL, phase: 'connecting' };
  if (action.type === 'reset') return INITIAL;

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
      return {
        ...state,
        phase: 'error',
        error: {
          code: frame.code,
          message: frame.message,
          retryAfter: frame.retry_after,
          messageId: frame.message_id,
          balance: frame.balance,
        },
      };
    default:
      return state;
  }
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
}: {
  caseId: string;
  onSettled: (turn: SettledTurn) => void;
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

  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(
    async (message: string, retryOf?: string) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      // 重试走 retryOf（正文由服务端从库里取），别拿空串把上一句问话冲掉
      if (message) lastMessage.current = message;
      lastFailedId.current = undefined;
      dispatch({ type: 'start' });

      const turn = emptyTurn();
      const req = { caseId, message, signal: controller.signal, retryOf };

      const consume = async (transport: ChatTransport) => {
        for await (const frame of transport.send(req)) {
          dispatch({ type: 'frame', frame });
          switch (frame.type) {
            case 'meta':
              turn.meta = frame;
              turn.messageId = frame.message_id;
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
  const stop = useCallback(() => abort.current?.abort(), []);

  return {
    ...state,
    busy:
      state.phase === 'connecting' ||
      state.phase === 'waiting' ||
      state.phase === 'streaming',
    demoFallback,
    send,
    retry,
    retryFailed,
    stop,
  };
}
