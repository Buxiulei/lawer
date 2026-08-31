'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { mockCompanyGraph } from '@/app/_mock/company-graph';
import { apiFetch, humanError } from '@/app/_ui/api';
import { readToken, useSignedIn } from '@/app/_ui/auth';
import type { CompanyGraph } from '@/lib/graph/contract';
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/alert';
import { Button } from '@/components/shadcn/button';
import { Skeleton } from '@/components/shadcn/skeleton';
import { CompanyGraphView } from './CompanyGraphView';

/**
 * 图谱取数。CompanyGraphView 的签名一个字没动——它照旧吃 `CompanyGraph | null`，
 * 换的只是这个 null 从哪来：以前恒为 mock，现在是真接口查不到。
 *
 * 【只有 demo 走演示图】跟证据库同一条规矩（EvidenceLibrary 里那句注释）：
 * 真实案件登录失效给「重新登录」，**绝不回落到演示图谱**——
 * 在真案件下摆一张别人的股权图，比空白危险得多：用户会照着它决定告谁。
 */
export function CompanyGraphLoader({ caseId }: { caseId: string }) {
  const signedIn = useSignedIn();
  const isDemo = caseId === 'demo';

  const [graph, setGraph] = useState<CompanyGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needSignIn, setNeedSignIn] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setNeedSignIn(false);
    if (isDemo) {
      setGraph(mockCompanyGraph);
      setLoading(false);
      return;
    }
    // 直接读 token 而不是用 signedIn：水合那一帧 hook 还可能是 null
    if (!readToken()) {
      setGraph(null);
      setNeedSignIn(true);
      setLoading(false);
      return;
    }
    try {
      const res = await apiFetch<{ graph: CompanyGraph | null }>(
        `/cases/${encodeURIComponent(caseId)}/company-graph`,
      );
      setGraph(res.graph);
    } catch (err) {
      setLoadError(humanError(err));
    } finally {
      setLoading(false);
    }
  }, [caseId, isDemo]);

  // signedIn 变化也要重来：401 会就地清掉 token，这里跟着切到「重新登录」
  useEffect(() => {
    void load();
  }, [load, signedIn]);

  if (loading) {
    return (
      <div className="pt-1">
        {/* 骨架挂 data-veil：低调模式下它是这一屏唯一的形状，不糊就成了指路牌 */}
        <div data-veil="" className="flex flex-col gap-3 py-3">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (needSignIn) {
    return (
      <div className="pt-1">
        <Alert>
          {/* 只在本机压根没有 token 时置起，说"失效"会让从没登录过的人以为自己弄坏了什么 */}
          <AlertTitle data-veil="">登录后才能看到这个案件里的公司关系。</AlertTitle>
          <Button size="sm" className="mt-3" asChild>
            <Link href="/login">去登录</Link>
          </Button>
        </Alert>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="pt-1">
        <Alert>
          <AlertTitle data-veil="">{loadError}</AlertTitle>
          <AlertDescription data-veil="" className="mt-1">
            已经查到的关系还在，只是这次没读出来。
          </AlertDescription>
          <Button size="sm" className="mt-3" onClick={() => void load()}>
            重新加载
          </Button>
        </Alert>
      </div>
    );
  }

  return <CompanyGraphView graph={graph} />;
}
