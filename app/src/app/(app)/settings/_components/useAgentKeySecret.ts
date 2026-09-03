'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, humanError } from '@/app/_ui/api';
import { useSignedIn } from '@/app/_ui/auth';
import type { SetupUrls } from './agentSetup';

/**
 * 「话术里该填哪一把密钥的明文」的唯一来源。
 *
 * 接入卡（/settings 的 AgentSetupCard）与接入指南（/settings/agent 的 ConnectGuide）
 * 都要回答同一个问题：这个人现在手上那把 key 的明文是什么？两处各写一份取数逻辑的形态是
 * ——一处显示真密钥、另一处还在给占位符，而两处看起来都很正常。
 *
 * 【为什么不复用 _ui/useConnectedAgent.pickConnected】那边问的是「接没接上」，判据是
 * **这把钥匙真的被用过**（last_used_at 非空）；这边问的是「该把哪一把填进话术」，
 * 一把刚生成、从没被用过的钥匙正是最该填进去的那一把。两个问题的正确答案在
 * 「刚生成还没粘」这个状态下**恰好相反**，合并成一个 hook 必然要牺牲其中一边。
 *
 * 【挑哪一把】启用中的里面，用过的优先（按 last_used_at 倒序），都没用过就取
 * 列表第一条——GET /keys 按 id DESC 排，即最近创建的那把。
 * ⚠️ 这条挑选规则是本单的默认判断，裁决没有明说：一个人有多把从没用过的 key 时，
 * 「该把哪一把填进话术」不是显然的事。改规则请连着改这段注释。
 */

export interface KeyBrief {
  id: number;
  name: string;
  enabled: boolean;
  last_used_at: string | null;
  /** 这把能不能取回明文。存量旧密钥（签发时还没留密文）恒 false */
  viewable: boolean;
}

/** 有 key 时的三种去向，页面按 kind 分支，不靠 `key ? … : …` 猜 */
export type KeySecretState =
  /** 一把 key 都没有 —— 引导去生成 */
  | { kind: 'none' }
  /** 请求还在飞。首帧恒为它（SSR 到不了 effect） */
  | { kind: 'loading' }
  /** 没登录：密钥是账号的凭据，登录之后才有 */
  | { kind: 'signedOut' }
  /** 有 key，但它是拿不回明文的存量旧密钥 —— 出路是轮换 */
  | { kind: 'legacy'; id: number; name: string }
  /** 有 key，明文也拿到了 */
  | { kind: 'ready'; id: number; name: string; secret: string }
  /** 有 key，但这次没取到明文（服务端主密钥不可用、密文坏了、网络抖） */
  | { kind: 'error'; id: number; name: string; message: string };

export interface AgentKeySecret {
  state: KeySecretState;
  /** 轮换成 key。成功后就地把 state 换成新明文，不重新拉列表 */
  rotate: () => Promise<void>;
  rotating: boolean;
  /** 刚生成/刚轮换出一把新的：直接顶掉当前 state（省一次往返，也省一次闪烁） */
  adopt: (k: { id: number; name: string; key: string }) => void;
}

/** 启用中的里面挑一把：用过的优先，都没用过就取最近创建的（列表已按 id DESC） */
export function pickManageable(keys: KeyBrief[]): KeyBrief | null {
  const live = keys.filter((k) => k.enabled);
  if (live.length === 0) return null;
  const used = live
    .filter((k) => k.last_used_at)
    .sort((a, b) => (b.last_used_at ?? '').localeCompare(a.last_used_at ?? ''));
  return used[0] ?? live[0];
}

/** POST /keys 与 POST /keys/{id}/rotate 的成功响应形状（服务端 _issued.ts 一处拼装） */
export interface IssuedKey extends SetupUrls {
  id: number;
  name: string;
  key: string;
}

export function useAgentKeySecret(): AgentKeySecret {
  const signedIn = useSignedIn();
  const [state, setState] = useState<KeySecretState>({ kind: 'loading' });
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    if (!signedIn) {
      setState({ kind: 'signedOut' });
      return;
    }
    let alive = true;
    void (async () => {
      let row: KeyBrief | null;
      try {
        const body = await apiFetch<{ keys: KeyBrief[] }>('/keys');
        row = pickManageable(body.keys);
      } catch {
        // 列表都取不到就当没有：这一屏还有「生成一把」那条路走得通，
        // 摆一句「列表没取到」占住位置，比让他先去生成更没用。
        if (alive) setState({ kind: 'none' });
        return;
      }
      if (!alive) return;
      if (!row) return setState({ kind: 'none' });
      if (!row.viewable) return setState({ kind: 'legacy', id: row.id, name: row.name });

      try {
        const secret = await apiFetch<{ key: string }>(`/keys/${row.id}/secret`);
        if (alive) setState({ kind: 'ready', id: row.id, name: row.name, secret: secret.key });
      } catch (err) {
        // 服务端的自述型 message 原样端上来：它已经写清了「这把 key 本身没事」
        // 还是「只能轮换」，页面再包一层「出错了」等于把出路盖掉
        if (alive) setState({ kind: 'error', id: row.id, name: row.name, message: humanError(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [signedIn]);

  const adopt = useCallback((k: { id: number; name: string; key: string }) => {
    setState({ kind: 'ready', id: k.id, name: k.name, secret: k.key });
  }, []);

  const rotate = useCallback(async () => {
    if (!('id' in state)) return;
    setRotating(true);
    try {
      const body = await apiFetch<IssuedKey>(`/keys/${state.id}/rotate`, { method: 'POST' });
      setState({ kind: 'ready', id: body.id, name: body.name, secret: body.key });
    } catch (err) {
      setState({ kind: 'error', id: state.id, name: state.name, message: humanError(err) });
    } finally {
      setRotating(false);
    }
  }, [state]);

  return { state, rotate, rotating, adopt };
}
