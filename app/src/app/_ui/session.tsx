'use client';

/**
 * 登录态失效之后**唯一**的那条出路：清掉不作数的 token → 去登录（带着回跳路径）。
 *
 * 【立这个模块的由头（F-202）】token 被改坏之后刷新 /case/5，页面读到 401，
 * 画的是「这一屏没取出来 … 点下面再试一次」——而那个「重试」拿的还是同一个坏 token，
 * 点一百次就是一百个 401。**整条案件路由上没有任何一个指向登录页的入口**。
 * 同一时刻 /account 是对的：它认出 UNAUTHORIZED，给的是一颗「去登录」。
 * 也就是说正确的出路早就写过一遍，只是写在别处，案件页这边各写各的重试。
 *
 * 所以出路收成一处，且**挂在案件路由的 layout 上**（见 (app)/case/[id]/layout.tsx），
 * 驾驶舱、问它、证据、文书、公司档案、关系图六个子页一次全覆盖：
 * 子页里一行 401 分支都不用有，也就没有"下一处忘了写"的地方。
 * 结构守卫见 __tests__/session-single-entry.test.tsx。
 *
 * 【为什么是「本机原本有 token」才算失效】从没登录过的人撞到 401，该说的是
 * 「请先登录」而不是「你的登录失效了」——后者会让他以为自己弄坏了什么
 * （同 _ui/api.ts 里 humanError 的那条分界，也同 settings 的 SignInHint）。
 * 那一支各子页本来就自己拦着（没 token 压根不发请求），不归这里。
 */

import Link from 'next/link';
import { useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@/components/shadcn/button';
import { EmptyState } from '@/components/shadcn/empty-state';
import { clearToken, useAuthToken } from './auth';

/* ── 「这次会话的登录态已经失效了」这件事本身 ───────────────── */

/**
 * 模块级一个布尔。**只由 _ui/api.ts 在 401（且本机原本有 token）时置起**，
 * 一次页面加载内有效——刷新之后重新从 false 开始，下一个 401 会再置一次。
 */
let expired = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** 401 且本机原本有 token 时由 apiFetch 调用。幂等。 */
export function markSessionExpired(): void {
  if (expired) return;
  expired = true;
  emit();
}

/** 纯读，给判据用（node 环境跑不了 hook） */
export function isSessionExpired(): boolean {
  return expired;
}

/** 只给测试与登录成功后复位用 */
export function resetSessionExpired(): void {
  if (!expired) return;
  expired = false;
  emit();
}

/**
 * 这一屏该不该让位给「去登录」。
 *
 * 【为什么还要看 token】旗子是一次页面加载内的记号，用户在另一个标签页重新登录之后
 * （storage 事件会把 token 推过来）这一屏应当自己让回去，而不是逼他再刷新一次。
 * 服务端渲染那一遍恒 false：useAuthToken 在服务端回 null，
 * 而模块级旗子在服务端进程里是跨请求共享的，拿它渲染就是把别人的失效态画给你看。
 */
export function useSessionExpired(): boolean {
  const flag = useSyncExternalStore(
    subscribe,
    () => expired,
    () => false,
  );
  const token = useAuthToken();
  return flag && token === null;
}

/* ── 出路 ──────────────────────────────────────────────── */

/**
 * 登录页地址，带上回跳路径。
 *
 * 【next 目前谁在消费】没有人：登录成功后的落点仍是 /welcome，
 * 这是 F-201 的经理裁决（主理人对自动跳转敏感，/welcome 保留），本单不动它。
 * 带上它有两个作用：地址栏能看出"我是从哪儿被踢出来的"，
 * 以及将来若要恢复回跳，参数已经在了、不用再改六个调用点。
 * ——这条不是执行者的裁定，是把裁决原样记在它落地的地方。
 */
export function loginHref(next: string): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

/**
 * 点「去登录」时先做的事：把不作数的 token 从本机抹掉。
 *
 * 【apiFetch 已经清过一次了，为什么还清】那一次清的是**收到 401 的那一刻**，
 * 而这一屏可能停留很久：期间任何一处把旧 token 又写回去（多标签页、还原的会话、
 * 手动改 localStorage），点下去就又带着一个坏 token 进登录页。
 * 出路上再清一次，代价是一行，收益是"点了它一定是干净地去登录"。
 */
export function forgetSession(): void {
  clearToken();
}

/**
 * 登录态失效那一屏。**不给「重试」**——重试拿的是同一个坏 token，
 * 这正是 F-202 里那个点不完的死循环。
 */
export function SessionExpiredScreen({ next }: { next: string }) {
  return (
    <div className="pt-6">
      <EmptyState
        title="登录状态已失效，请重新验证"
        // description 由 EmptyState 自带 data-veil：这句里有「案件」「材料」两个案情词
        description="你的案件和材料都还在，只是这台设备上的登录凭据不作数了。重新登录之后，从「我的案件」一步就回得来。"
        action={
          <Button asChild>
            <Link href={loginHref(next)} onClick={forgetSession}>
              去登录
            </Link>
          </Button>
        }
      />
    </div>
  );
}

/**
 * 闸门的渲染本身，抽成纯函数好逐态验（node 环境里 hook 驱动不了两态）。
 * 失效时**整块让位**：底下那些子页此刻能画出来的每一屏都是拿坏 token 换来的。
 */
export function sessionGateContent(
  expiredNow: boolean,
  next: string,
  children: ReactNode,
): ReactNode {
  return expiredNow ? <SessionExpiredScreen next={next} /> : children;
}

/** 挂在案件路由的 layout 上，一次覆盖全部子页 */
export function SessionGate({ next, children }: { next: string; children: ReactNode }) {
  return <>{sessionGateContent(useSessionExpired(), next, children)}</>;
}
