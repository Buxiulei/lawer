'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { mockDossier } from '@/app/_mock/company-dossier';
import { ApiError, apiFetch, humanError } from '@/app/_ui/api';
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
 * 【查不到 ≠ 出错】接口给 null、或者档案还没建（404），都走"还没建档"那一屏，
 * 那是一个正常状态，不是故障。只有真读失败才出错误条。
 */
const NOT_ORDERED_CODES = new Set(['HTTP_404', 'DOSSIER_NOT_FOUND']);

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
      const res = await apiFetch<{ dossier: DossierView | null }>(
        `/cases/${encodeURIComponent(caseId)}/dossier`,
      );
      setDossier(res.dossier);
    } catch (err) {
      if (err instanceof ApiError && NOT_ORDERED_CODES.has(err.errorCode)) {
        setDossier(null); // 还没建档，不是故障
      } else {
        setLoadError(humanError(err));
      }
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

  if (!dossier) return <DossierNotOrdered caseId={caseId} />;

  return <DossierBody caseId={caseId} dossier={dossier} />;
}
