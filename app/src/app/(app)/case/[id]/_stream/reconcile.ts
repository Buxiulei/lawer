'use client';

/**
 * 对账（reconcile）：看门狗叫醒之后，去库里把这一轮的答案取回来。
 *
 * 【它接的是哪半个病】(watchdog.ts 文件头)
 * 连接静默死亡时，服务端那一轮照样答完、照样落库，页面却永远不刷新。
 * 对账就是「连接丢了就去库里把答案取回来」：重取本案历史，若这一轮的回答已经在库里，
 * 当作 done 落定、渲染出来；若还没有（服务端可能还在答），过一个心跳窗口再取一次；
 * 两次都没有才落 STALLED 错误卡（带重试）。
 *
 * 【为什么锚点是 message_id】meta 帧带回来的 `message_id` 就是这一轮**那条 assistant 行**
 * 的库主键（服务端在开跑时就分配了它）。历史行的展示 id 是 `m_<主键>`（见 caseHistory.ts），
 * 所以拿 `m_${message_id}` 去历史里找那一行即可。没有 meta（连都没连上、答案还没落行）就没有锚点，
 * 那时一律按「还没有」处理——不去猜「最后一条 assistant」，那会把上一轮的旧答案错认成这一轮的。
 */

import type { ErrorFrame } from './frames';
import type { StreamedMessage } from '../_components/Messages';

/** 对账落 STALLED 错误卡时用的错误码。前端自造（不是服务端发的），与九帧里别的码不撞。 */
export const STALLED = 'STALLED';

/** 对账最多试几次：第一次没有就再等一个心跳窗口，第二次还没有才认栽。 */
export const RECONCILE_MAX_ATTEMPTS = 2;

/**
 * 这一轮的回答在库里了没有。**纯函数**，喂假历史即可验。
 *
 * 找到并返回那条 assistant 回答；没找到 / 还没答 / 是条失败轮，一律返回 null
 * （交给「再等一窗」或最终 STALLED）。失败轮返回 null 而不是当答案：它在历史里会被
 * 画成失败卡+重试（Workbench 的 failedCode 分支），不该被当成一条正常回答补进流里。
 */
export function findReconciledAnswer(
  messages: StreamedMessage[],
  messageId: string | null,
): StreamedMessage | null {
  if (!messageId) return null;
  const wanted = `m_${messageId}`;
  const row = messages.find((m) => m.id === wanted);
  if (!row) return null;
  if (row.role !== 'assistant') return null;
  if (row.failedCode) return null;
  if (!row.content.trim()) return null;
  return row;
}

export type ReconcileVerdict =
  /** 库里有这一轮的回答：当 done 落定，把它补进流里 */
  | { kind: 'recovered'; message: StreamedMessage }
  /** 还没有：保持等待、下一个心跳窗口再对账一次 */
  | { kind: 'pending' }
  /** 试满了还没有：落 STALLED 错误卡 */
  | { kind: 'stalled' };

/**
 * 一次对账的裁决。**纯函数**：给它「找没找到」和「这是第几次（1 起）」，它决定落定 / 再等 / 认栽。
 * 抽出来是为了让「第二次才认栽」这条判据能直接验，不必真等两个心跳。
 */
export function reconcileVerdict(
  answer: StreamedMessage | null,
  attempt: number,
  maxAttempts: number = RECONCILE_MAX_ATTEMPTS,
): ReconcileVerdict {
  if (answer) return { kind: 'recovered', message: answer };
  if (attempt >= maxAttempts) return { kind: 'stalled' };
  return { kind: 'pending' };
}

/**
 * STALLED 错误帧。三段式：连接断了 / 回答可能已经生成 / 点重试或刷新。
 * 带上 message_id（有 meta 时）→ 重试走 retry_of，服务端重发同一句问话、不重复插用户消息；
 * 缺席（连都没连上）→ 重试退回照原文再发一次（useChatStream 的 retry 自己判）。
 */
export function stalledError(messageId: string | null): ErrorFrame {
  return {
    type: 'error',
    code: STALLED,
    message:
      '连接断了，这一轮没能收完。回答可能已经生成了，刷新页面就能看到；也可以点下面重试，重新问一次。',
    ...(messageId ? { message_id: messageId } : {}),
  };
}
