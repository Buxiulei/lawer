'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@/components/shadcn/button';

/**
 * 卡片正文在未登录时的替代块。
 * 说的是「登录后可用」而不是「登录状态已失效」——从没登录过的人看到"失效"会以为自己弄坏了什么。
 */
export function SignInHint({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 rounded-[10px] border border-dashed border-line p-4">
      <p className="text-[15px] leading-7 text-ink">登录后可用</p>
      <p className="mt-1 text-[14px] leading-6 text-ink-2">{children}</p>
      <Button asChild size="sm" variant="secondary" className="mt-3">
        <Link href="/login">去登录</Link>
      </Button>
    </div>
  );
}
