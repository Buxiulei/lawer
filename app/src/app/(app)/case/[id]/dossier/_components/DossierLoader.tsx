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

  const [dossier, setDossier] = useState<DossierView | null>(null);
  /** 「还没建档」时去哪儿下单，由端点给；请求没打通之前先用本案的默认入口。 */
  const [orderPath, setOrderPath] = useState(`/case/${encodeURIComponent(caseId)}/dossier/order`);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needSignIn, setNeedSignIn] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setNeedSignIn(false);
    if (isDemo) {
      setDossier({ ...mockDossier, venue: demoVenue });
      setLoading(false);
      return;
    }
    // 直接读 token 而不是用 signedIn：水合那一帧 hook 还可能是 null
    if (!readToken()) {
      setDossier(null);
      setNeedSignIn(true);
      setLoading(false);
      return;
    }
    try {
      const res = await apiFetch<DossierResponse>(`/cases/${encodeURIComponent(caseId)}/dossier`);
      if (res.status === 'none') {
        setDossier(null); // 还没建档，不是故障
        setOrderPath(res.orderPath);
      } else {
        setDossier(res.dossier);
      }
    } catch (err) {
      setLoadError(humanError(err));
    } finally {
      setLoading(false);
    }
  }, [caseId, isDemo, demoVenue]);

  useEffect(() => {
    void load();
  }, [load, signedIn]);

  if (loading) {
    return (
      <div data-veil="" className="flex flex-col gap-3 pt-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (needSignIn) {
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

  if (loadError) {
    return (
      <div className="pt-4">
        <Alert>
          <AlertTitle data-veil="">{loadError}</AlertTitle>
          <AlertDescription data-veil="" className="mt-1">
            已经查到的内容还在，只是这次没读出来。
          </AlertDescription>
          <Button size="sm" className="mt-3" onClick={() => void load()}>
            重新加载
          </Button>
        </Alert>
      </div>
    );
  }

  if (!dossier) return <DossierNotOrdered orderPath={orderPath} />;

  return <DossierBody caseId={caseId} dossier={dossier} />;
}
