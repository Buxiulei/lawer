'use client';

import Link from 'next/link';
import { useSignedIn } from '@/app/_ui/auth';
import { useMyCaseHref } from '@/app/_ui/currentCase';

/**
 * 落地页那颗主 CTA。**只有它认登录态**——落地页本身不跳转（见 _ui/bootstrap 里
 * 那段删掉的首屏脚本的墓志铭）。
 *
 * 【首帧会闪一下未登录态，这是有意接受的代价】服务端渲染阶段读不到 localStorage，
 * useAuthToken 首帧恒为 null（_ui/auth 写明了），所以登录用户会先看到「开始我的案件」
 * 半帧，水合后变成「进入我的案件」。上一版为了消这半帧闪烁改用首屏同步跳转脚本，
 * 结果把整张主页从登录用户眼前拿走了——按住这条：**不许为这半帧再引入任何跳转**。
 *
 * 去处不自己拼：调 useMyCaseHref，与壳层导航、演示横幅同一个答案
 * （未登录 → /login；已登录未解析 → /case 解析页；已解析 → /case/{id}）。
 */
export function PrimaryCta() {
  const signedIn = useSignedIn();
  const href = useMyCaseHref();

  return (
    <Link
      href={href}
      className="block w-full rounded-[6px] bg-primary px-8 py-[15px] text-center text-[17px] font-semibold text-on-primary shadow-[0_3px_0_var(--primary-ink)] transition-colors hover:bg-primary-ink sm:w-auto"
    >
      {signedIn ? '进入我的案件' : '开始我的案件'}
    </Link>
  );
}
