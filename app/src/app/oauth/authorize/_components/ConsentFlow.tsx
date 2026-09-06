'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { readToken } from '@/app/_ui/auth';
import { rememberLoginRedirect } from '@/app/_ui/loginRedirect';
import { Button } from '@/components/shadcn/button';
import { Card, CardContent } from '@/components/shadcn/card';
import { Skeleton } from '@/components/shadcn/skeleton';

/**
 * 同意页。整条 OAuth 链上**唯一由用户本人做决定**的一屏。
 *
 * 【为什么参数从 window.location 读，不从 props】这一页要在浏览器里判断有没有登录态
 * （token 在 localStorage 里，服务端渲染时读不到），本来就只能在客户端跑；
 * 顺手在同一处读查询串，就不必再为 useSearchParams 加一层 Suspense。
 *
 * 【为什么不在这里判参数合不合法】redirect_uri 白名单、PKCE、client_id 是否注册过，
 * 全部由服务端判（GET /api/oauth/authorize）。页面自己判一遍的形态是：两处规则悄悄分叉，
 * 而页面那一份是攻击者可以绕过去的——他直接 POST 就行。这里只负责显示与转达。
 */

interface AuthorizeInfo {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  scopes: string[];
}

const SCOPE_LABEL: Record<string, string> = {
  'case:read': '读你的案件档案与证据清单',
  'case:write': '写档案、记录时间线、登记证据与起草文书',
};

/** 未登录时的落点。登录成功后 LoginFlow 会把人送回本页（见 _ui/loginRedirect）。 */
const LOGIN_HREF = '/login';

export function ConsentFlow() {
  const router = useRouter();
  const [search, setSearch] = useState<string | null>(null);
  const [info, setInfo] = useState<AuthorizeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    const query = window.location.search;
    // 没登录：把这一页记下来，登完再回来把授权走完，而不是让人登完站在首页猜刚才成没成
    if (!readToken()) {
      rememberLoginRedirect(window.location.pathname + query);
      router.replace(LOGIN_HREF);
      return;
    }
    setSearch(query);
    fetch(`/api/oauth/authorize${query}`, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | (AuthorizeInfo & { error?: string; error_description?: string })
          | null;
        if (!res.ok || !body || body.error) {
          // 服务端的 error_description 已经是三段式人话，页面不再自己写一份
          setError(body?.error_description ?? '这次授权请求没有通过校验，请回到客户端重新发起。');
          return;
        }
        setInfo(body);
      })
      .catch(() => {
        setError(
          '没能连上服务器核对这次授权请求。可能是网络断了，也可能是我们这边暂时不可用。' +
            '稍后刷新本页重试；在此之前不会有任何权限被授予出去。',
        );
      });
  }, [router]);

  const approve = useCallback(async () => {
    if (!info || search === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const params = new URLSearchParams(search);
      const res = await fetch('/api/oauth/authorize', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${readToken() ?? ''}`,
        },
        body: JSON.stringify(Object.fromEntries(params.entries())),
      });
      const body = (await res.json().catch(() => null)) as
        | { redirect_to?: string; error_description?: string }
        | null;
      if (!res.ok || !body?.redirect_to) {
        setError(body?.error_description ?? '这一步没成功，回到客户端重新发起一次授权。');
        setSubmitting(false);
        return;
      }
      // 跳转地址由服务端按白名单拼好（见 route.ts），页面只负责跳
      window.location.replace(body.redirect_to);
    } catch {
      setError('没能把同意结果送出去，检查一下网络再试。还没有任何权限被授予出去。');
      setSubmitting(false);
    }
  }, [info, search]);

  if (declined) {
    return (
      <Card>
        <CardContent className="py-5">
          <p className="text-[15px] leading-7 text-ink">已拒绝这次授权，没有任何权限被交出去。</p>
          <p className="mt-2 text-[14px] leading-6 text-ink-2">
            这一页可以直接关掉；回到客户端那边会显示连接未完成。改主意了随时可以再点一次「添加连接器」。
          </p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-5">
          <p className="text-[15px] leading-7 text-ink">这次授权没有继续。</p>
          <p className="mt-2 text-[14px] leading-6 text-ink-2">{error}</p>
        </CardContent>
      </Card>
    );
  }

  if (!info) return <Skeleton className="h-40 w-full" />;

  return (
    <Card>
      <CardContent className="py-5">
        <p className="text-[15px] leading-7 text-ink">
          <span className="font-semibold">{info.client_name}</span> 想接入你在土八鼠的案件档案。
        </p>
        <p className="mt-1 text-[13px] leading-6 text-ink-2">
          这个名字是客户端自己报的，不是我们核实过的身份。不认识就别同意。
        </p>

        <p className="mt-4 text-[14px] font-semibold text-ink">同意后它可以：</p>
        <ul className="mt-1.5 space-y-1">
          {info.scopes.map((scope) => (
            <li key={scope} className="text-[14px] leading-6 text-ink-2">
              · {SCOPE_LABEL[scope] ?? scope}
            </li>
          ))}
        </ul>

        <p className="mt-4 text-[13px] leading-6 text-ink-2">
          授权后会在「设置 → API key」里多出一条记录，随时可以吊销；吊销之后它立刻失去全部权限。
        </p>
        <p className="num mt-1 break-all text-[12px] leading-5 text-ink-2">
          授权完成后会跳回 {info.redirect_uri}
        </p>

        <div className="mt-5 flex flex-col gap-2">
          <Button className="w-full" disabled={submitting} onClick={() => void approve()}>
            {submitting ? '正在完成授权…' : '同意并接入'}
          </Button>
          <Button
            className="w-full"
            variant="secondary"
            disabled={submitting}
            onClick={() => setDeclined(true)}
          >
            拒绝
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
