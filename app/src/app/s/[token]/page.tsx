// app/src/app/s/[token]/page.tsx
// 免登录只读页（设计稿 §2 E share_create 的落地面）。无需登录、不套 AppShell：
// 站在这条路上的是一个没有账号的人，任何"先登录"的动作都会把他挡在外面。
//
// 【只渲染，不给下载】材料类分享只展示元数据与证明目的，文件字节不经本页
// （理由见 lib/shares.ts 文件头 ②）。文书类展示正文原文，不含那段「发出前必读」尾注。
//
// 状态与 REST 同一份判定（lib/shares.readShare）：那边回 410 的两种情形，
// 这里就是那两块「已失效」的文案，两处不会分叉。
import type { Metadata } from 'next';

import { TubashuMark } from '@/components/shell/TubashuMark';
import { getDb } from '@/lib/db/client';
import { readShare } from '@/lib/shares';

export const metadata: Metadata = { title: '分享内容' };

// 链接可能在任何一刻被撤销：缓存住等于撤销失效。
export const dynamic = 'force-dynamic';

function Unavailable({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <h2 className="text-[16px] font-semibold text-ink">{heading}</h2>
      <p className="prose-measure mt-2 text-[14px] leading-7 text-ink-2">{body}</p>
    </div>
  );
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = readShare(getDb(), decodeURIComponent(token ?? ''));

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[760px] flex-col px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-b border-line pb-5">
        <div className="flex items-center gap-2.5">
          <TubashuMark size={24} className="size-6" />
          <span className="text-[15px] font-semibold text-ink">土八鼠</span>
        </div>
        <h1 className="mt-4 text-[20px] font-semibold text-ink sm:text-[22px]">
          {result.state === 'ok' ? result.view.title : '分享内容'}
        </h1>
      </header>

      <main className="flex-1 pt-6">
        {result.state === 'not_found' && (
          <Unavailable
            heading="没有这条分享链接"
            body="请核对地址是否完整（末尾一段是 32 位字符），或找分享给你的人重新发一条。"
          />
        )}
        {result.state === 'expired' && (
          <Unavailable
            heading="这条分享链接已到期"
            body={
              `有效期截止到 ${result.expires_at}（UTC），内容不再展示。` +
              '分享链接都有有效期：它不带任何凭据，谁拿到谁能看，长期有效等于把内容公开发出去了。' +
              '还需要看的话，请找分享给你的人再发一条。'
            }
          />
        )}
        {result.state === 'revoked' && (
          <Unavailable
            heading="这条分享链接已被收回"
            body="分享给你这条链接的人已经把它收回了，内容不再展示。如仍需查看，请直接联系对方。"
          />
        )}

        {result.state === 'ok' && result.view.body !== null && (
          // whitespace-pre-wrap：正文是纯文本，换行与空行就是作者排的样子，不许被折没
          <article className="prose-measure whitespace-pre-wrap text-[15px] leading-8 text-ink">
            {result.view.body}
          </article>
        )}

        {result.state === 'ok' && result.view.meta !== null && (
          <dl className="grid gap-3 rounded-lg border border-line bg-surface p-5">
            {Object.entries(result.view.meta).map(([label, value]) => (
              <div key={label} className="grid gap-1 sm:grid-cols-[7rem_1fr] sm:gap-3">
                <dt className="text-[13px] text-ink-2">{label}</dt>
                <dd className="num text-[14px] break-all text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </main>

      <footer className="mt-10 border-t border-line pt-5 text-[13px] leading-6 text-ink-2">
        <p className="prose-measure">
          本页是当事人主动分享的只读内容，到期或被收回后即不再展示。
          {result.state === 'ok' && `本条有效期至 ${result.view.expires_at}（UTC）。`}
          材料类分享只列出条目说明，不提供文件本身。
        </p>
      </footer>
    </div>
  );
}
