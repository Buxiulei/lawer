import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { LampMark } from '@/components/shell/LampMark';
import { VerifyResult } from './_components/VerifyResult';
import { readVerification } from './_verification';

export const metadata: Metadata = { title: '存证验证' };

// 存证记录随固化进度变化，绝不能给缓存住：仲裁场上看到的必须是此刻的库里那一条。
export const dynamic = 'force-dynamic';

/** 服务端 fetch 要绝对地址；本页只查同源自己的 API，故按请求头拼回自己的 origin。 */
async function selfOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get('host');
  if (!host) return process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? 'http://127.0.0.1:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * 公开验证页：无需登录、不套 AppShell，任何人拿到存证编号都能自己核。
 *
 * ⚠ 判定规则见 _verification.ts 顶部的红线说明。要点：
 * 后端验签不通过也返回 200，故绝不许用 res.ok / 状态码当验证结果；
 * 而且当前这个接口**根本不做复核**（没有 overall_ok），
 * 所以本页只展示「存证记录」，一个字都不能说成「验证通过」。
 */
export default async function VerifyPage({
  params,
}: {
  params: Promise<{ no: string }>;
}) {
  const { no } = await params;

  let body: unknown = null;
  try {
    const res = await fetch(
      `${await selfOrigin()}/api/v1/verify/${encodeURIComponent(no)}`,
      { cache: 'no-store', headers: { Accept: 'application/json' } },
    );
    // 刻意不看 res.ok：裁决只认响应体，解析失败就是 null → 无法验证
    body = await res.json().catch(() => null);
  } catch {
    body = null;
  }

  const view = readVerification(body);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[760px] flex-col px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-b border-line pb-5">
        <div className="flex items-center gap-2.5">
          <LampMark className="size-6 text-primary" />
          <span className="text-[15px] font-semibold text-ink">土拨鼠劳动仲裁</span>
        </div>
        <h1 className="mt-4 text-[20px] font-semibold text-ink sm:text-[22px]">
          存证查询
        </h1>
        <p className="num mt-1 text-[15px] break-all text-ink-2">存证编号 {no}</p>
      </header>

      <main className="flex-1 pt-6">
        <VerifyResult no={no} view={view} />
      </main>

      <footer className="mt-10 border-t border-line pt-5 text-[13px] leading-6 text-ink-2">
        <p className="prose-measure">
          本页如实列出该编号在平台留存的存证记录与可信时间戳，不代替密码学复核。
          需要独立复核的，可凭编号向出具方索取原始文件与时间戳令牌，按页内指引自行验签。
        </p>
        <p className="mt-2">本页无需登录，供仲裁庭、用人单位或任何第三方核验。</p>
      </footer>
    </div>
  );
}
