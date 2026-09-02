'use client';

import { useCallback, useEffect, useState } from 'react';
import { humanError } from '@/app/_ui/api';
import { readToken } from '@/app/_ui/auth';
import type { StreamedMessage } from '../_components/Messages';
import { fetchCaseMessages } from './caseHistory';

/**
 * 打开页面时把这个案件聊过的话取回来。
 *
 * 【四态，不能合并】
 *  · `skipped` 不该取（演示案件走演示剧本 / 没登录，页面自有它的那一屏）
 *  · `loading` 正在取 → 骨架
 *  · `failed`  没取到 → 说清楚 + 重试
 *  · `ready`   取到了（可能确实是空的，那是新案）
 *
 * **`failed` 绝不能画成"没有对话"**：两者在屏幕上都是一片白，
 * 但把前者画成后者，等于对一个刚聊完两小时的人说"你还没开始"。
 * 他会重新讲一遍——那既是钱，也是又一次把被裁的经过复述一遍。
 */
export type HistoryPhase = 'skipped' | 'loading' | 'failed' | 'ready';

export interface CaseHistory {
  phase: HistoryPhase;
  /** 只在 failed 时非空，已经是可以直接显示的人话 */
  error: string | null;
  /** 只在 ready 时非空。**failed 时恒为 null**，不留一个空数组冒充"取到了且是空的" */
  messages: StreamedMessage[] | null;
  reload: () => void;
}

interface State {
  phase: HistoryPhase;
  error: string | null;
  messages: StreamedMessage[] | null;
}

const SKIPPED: State = { phase: 'skipped', error: null, messages: null };

export function useCaseHistory({
  caseId,
  enabled,
}: {
  caseId: string;
  enabled: boolean;
}): CaseHistory {
  // 首帧就是 loading（而不是先画一屏空对话再改口）：真实案件几乎都有历史，
  // 先给空的再补上，用户看到的是"我的记录闪了一下才回来"。
  const [state, setState] = useState<State>(() =>
    enabled ? { phase: 'loading', error: null, messages: null } : SKIPPED,
  );

  const load = useCallback(async () => {
    setState({ phase: 'loading', error: null, messages: null });
    try {
      setState({ phase: 'ready', error: null, messages: await fetchCaseMessages(caseId) });
    } catch (err) {
      setState({ phase: 'failed', error: humanError(err), messages: null });
    }
  }, [caseId]);

  useEffect(() => {
    if (!enabled) {
      setState(SKIPPED);
      return;
    }
    // readToken 读 localStorage，只能在 effect 里调（SSR 那一遍没有它）。
    // 没登录不是"取失败"：页面此时给的是「去做首诊」，不该再叠一张重试卡。
    if (!readToken()) {
      setState(SKIPPED);
      return;
    }
    void load();
  }, [enabled, load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  return { ...state, reload };
}
