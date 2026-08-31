'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { mockDossier } from '@/app/_mock/company-dossier';
import { apiFetch, humanError } from '@/app/_ui/api';
import { readToken, useSignedIn } from '@/app/_ui/auth';
import type { DossierView, VenueSection } from '@/lib/dossier/contract';
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/alert';
import { Button } from '@/components/shadcn/button';
import { Skeleton } from '@/components/shadcn/skeleton';
import { DossierBody, DossierNotOrdered } from './DossierBody';

/**
 * 档案取数。
 *
 * 【只有 demo 走演示档案】跟证据库、图谱同一条规矩：真实案件登录失效给「重新登录」，
 * **绝不回落到演示数据**——在真案件下摆一份别人公司的统计，比空白危险得多。
 *
 * 【查不到 ≠ 出错，但它是一个 200】端点对「还没建档」返回
 * `{ status: 'none', dossier: null, orderPath }`，页面据此走招呼屏。
 *
 * 【为什么不再把 404 当成"还没建档"】这里原先把 `HTTP_404` 也算进"还没建档"，
 * 于是**端点根本不存在**的那段时间里，档案页对每一个真实案件都打着一个不存在的地址、
 * 显示着一屏体面的「还没建档」，而组件测试 mock 掉了网络层，全绿。
 * 现在 404 一律当故障出错误条——一个打不通的端点必须看得见。
 */
type DossierResponse =
  | { status: 'none'; dossier: null; orderPath: string }
  | { status: 'ready'; dossier: DossierView };

/**
 * 取完数之后这一屏是哪一种。
 *
 * 【为什么把它摊成一个值、还把取数与呈现分开导出】上面那条 404 的规矩此前**一条判据都够不着**：
 * 取数写在 useEffect 里，而 SSR 不跑 effect，于是把 `HTTP_404` 的吞噬加回去，
 * 整套判据仍然全绿——判据与它要判的东西并存。摊开之后，一次取数的三种结局
 * （引导态 / 档案体 / 报错）都能真的渲染出来验一遍。
 */
export type DossierScreen =
  | { kind: 'loading' }
  | { kind: 'needSignIn' }
  | { kind: 'notOrdered'; orderPath: string }
  | { kind: 'ready'; dossier: DossierView }
  | { kind: 'error'; message: string };

/**
 * 打一次端点 → 这一屏。
 *
 * 【catch 里没有"这些错误码算还没建档"的白名单，也不许有】那张白名单正是上面那段
 * 事故的形态：它把"端点打不通"翻译成"你还没买"，用户看到的是一屏体面的招呼页。
 * 只有端点自己用 200 说出来的 `status: 'none'` 才算还没建档。
 */
export async function loadDossierScreen(caseId: string): Promise<DossierScreen> {
  try {
    const res = await apiFetch<DossierResponse>(`/cases/${encodeURIComponent(caseId)}/dossier`);
    return res.status === 'none'
      ? { kind: 'notOrdered', orderPath: res.orderPath }
      : { kind: 'ready', dossier: res.dossier };
  } catch (err) {
    return { kind: 'error', message: humanError(err) };
  }
}

/** 五态各自的那一屏。**单独导出**是为了让判据够得着它（同 WatchTierPicker 的理由）。 */
export function DossierScreenView({
  caseId,
  screen,
  onRetry,
}: {
  caseId: string;
  screen: DossierScreen;
  onRetry: () => void;
}) {
  if (screen.kind === 'loading') {
    return (
      <div data-veil="" className="flex flex-col gap-3 pt-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (screen.kind === 'needSignIn') {
    return (
      <div className="pt-4">
        <Alert>
          <AlertTitle data-veil="">登录后才能看到这个案件的公司档案。</AlertTitle>
          <Button size="sm" className="mt-3" asChild>
            <Link href="/login">去登录</Link>
          </Button>
        </Alert>
      </div>
    );
  }

  if (screen.kind === 'error') {
    return (
      <div className="pt-4">
        <Alert>
          <AlertTitle data-veil="">{screen.message}</AlertTitle>
          <AlertDescription data-veil="" className="mt-1">
            已经查到的内容还在，只是这次没读出来。
          </AlertDescription>
          <Button size="sm" className="mt-3" onClick={onRetry}>
            重新加载
          </Button>
        </Alert>
      </div>
    );
  }

  if (screen.kind === 'notOrdered') return <DossierNotOrdered orderPath={screen.orderPath} />;

  return <DossierBody caseId={caseId} dossier={screen.dossier} />;
}

export function DossierLoader({
  caseId,
  demoVenue,
}: {
  caseId: string;
  /** demo 的仲裁地卡由服务端组件读知识库后传进来（loader 走文件系统，客户端拿不到） */
  demoVenue: VenueSection;
}) {
  const signedIn = useSignedIn();
  const isDemo = caseId === 'demo';

  const [screen, setScreen] = useState<DossierScreen>({ kind: 'loading' });

  const load = useCallback(async () => {
    setScreen({ kind: 'loading' });
    if (isDemo) {
      setScreen({ kind: 'ready', dossier: { ...mockDossier, venue: demoVenue } });
      return;
    }
    // 直接读 token 而不是用 signedIn：水合那一帧 hook 还可能是 null
    if (!readToken()) {
      setScreen({ kind: 'needSignIn' });
      return;
    }
    setScreen(await loadDossierScreen(caseId));
  }, [caseId, isDemo, demoVenue]);

  useEffect(() => {
    void load();
  }, [load, signedIn]);

  return <DossierScreenView caseId={caseId} screen={screen} onRetry={() => void load()} />;
}
