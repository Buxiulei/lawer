'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from './api';
import { useSignedIn } from './auth';
import { formatDateTime } from './format';

/**
 * 「这个人到底有没有把自己的 agent 接上」的**唯一来源**。
 *
 * 【为什么放 _ui 而不是设置页目录下】四个地方要问同一个问题：驾驶舱常驻行、
 * 账户页余额卡、对话页提示条、接入指南自己。判据各写一份必然分叉，
 * 而分叉的形态是「有的页面说你接上了、有的说你没接」，两边都看起来正常。
 *
 * 【connected 的判据是"这把钥匙真的被用过"，不是"这把钥匙存在"】
 * 生成了密钥却从没粘进去，跟没接是同一件事，不许在页面上长成同一个样子。
 * last_used_at 由 resolveIdentity（lib/auth/identity.ts）在**任何**用 api key 的请求上
 * 落一次，所以它就是"连进来过"的事实本身，不需要另立探针。
 *
 * 【没登录不发请求】没登录就没有钥匙可查，发一次只会拿回 401；
 * 而 apiFetch 的 401 会顺手清 token——demo 页上给未登录访客发这一枪毫无必要。
 */

export interface ConnectedAgent {
  /** 请求还在飞。首帧恒为 true（SSR 到不了 effect），别拿它当「没接」用 */
  loading: boolean;
  connected: boolean;
  /** 客户端自报名（MCP initialize 的 clientInfo.name）优先；没有就退到用户给钥匙起的名 */
  name: string;
  /** 名字是钥匙名而不是客户端自报名 —— 页面要说明白，不许让用户以为我们认出了他的助手 */
  nameIsKeyName: boolean;
  /** 最近一次连进来的时间，已格式化；没接上时是空串 */
  when: string;
}

/** GET /api/v1/keys 的行里，判「接没接上」用得到的那几列 */
export interface ApiKeyBrief {
  id: number;
  name: string;
  enabled: boolean;
  last_used_at: string | null;
  /** MCP 客户端自报的名字，走 REST 的客户端不报名字 → null，不编默认值 */
  client_name?: string | null;
}

const NOT_CONNECTED: ConnectedAgent = {
  loading: false,
  connected: false,
  name: '',
  nameIsKeyName: false,
  when: '',
};

/**
 * 接口给的时间是 ADR-002 的 canonical 格式（UTC，空格分隔），
 * 而 `new Date('2026-08-21 10:00:00')` 会被当成本地时间——补个 Z 再格式化，
 * 否则「最近一次」整整差 8 小时。（同 ApiKeysCard 的 toIso，那边是它自己那张表的私有细节。）
 */
function toIso(sqlUtc: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sqlUtc)
    ? `${sqlUtc.replace(' ', 'T')}Z`
    : sqlUtc;
}

/** 用过的、还启用着的钥匙里最近的那一把。一把都没有就是没接上。 */
export function pickConnected(keys: ApiKeyBrief[]): ConnectedAgent {
  const used = keys
    .filter((k) => k.enabled && k.last_used_at)
    .sort((a, b) => (b.last_used_at ?? '').localeCompare(a.last_used_at ?? ''));
  const top = used[0];
  if (!top) return NOT_CONNECTED;
  const reported = top.client_name?.trim();
  return {
    loading: false,
    connected: true,
    name: reported || top.name,
    nameIsKeyName: !reported,
    when: formatDateTime(toIso(top.last_used_at!)),
  };
}

export function useConnectedAgent(): ConnectedAgent {
  const signedIn = useSignedIn();
  const [state, setState] = useState<ConnectedAgent>({ ...NOT_CONNECTED, loading: true });

  useEffect(() => {
    if (!signedIn) {
      setState(NOT_CONNECTED);
      return;
    }
    let alive = true;
    apiFetch<{ keys: ApiKeyBrief[] }>('/keys').then(
      (body) => alive && setState(pickConnected(body.keys)),
      // 取不到就当没接：这条只用来决定"要不要多说一句话"，
      // 拿一句「接入状态没取到」占住常驻位，比不说更吵。
      () => alive && setState(NOT_CONNECTED),
    );
    return () => {
      alive = false;
    };
  }, [signedIn]);

  return state;
}
