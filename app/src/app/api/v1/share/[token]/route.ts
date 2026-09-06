// app/src/app/api/v1/share/[token]/route.ts
// 免登录读一条分享链接（设计稿 §2 E share_create）。**刻意不挂任何鉴权**：
// 这条地址存在的全部意义就是让没有账号的人（家人、对方、要看一眼的人）能打开它。
//
// 【三种不可用状态分开回，不合并成一个 404】
//   404 SHARE_NOT_FOUND —— 没有这条链接（含标的行已经不在了）
//   410 SHARE_EXPIRED   —— 有过，到期了。**必须是 410 不是 404**：410 说的是「这里曾经有东西，
//                          现在没了」，拿到链接的人据此去找分享给他的人再要一条；
//                          回 404 他只会怀疑自己复制错了，然后反复刷新。
//   410 SHARE_REVOKED   —— 分享人主动收回了。同样是 410，但话不同：再要一条也未必给。
// 归属探测在这里不构成风险：token 是 128 bit 全随机，猜不出来；而对着一条**手里有的**链接
// 说清它是过期还是被收回，是这条路上唯一要做对的事。
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/db/client';
import { readShare } from '@/lib/shares';

// 链接可能在任何一刻被撤销：缓存住等于撤销失效。
export const dynamic = 'force-dynamic';

function err(status: number, errorCode: string, message: string): NextResponse {
  return NextResponse.json({ ok: false, error_code: errorCode, message }, { status });
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = readShare(getDb(), decodeURIComponent(token ?? ''));

  if (result.state === 'not_found') {
    return err(
      404,
      'SHARE_NOT_FOUND',
      '没有这条分享链接。请核对地址是否完整（末尾一段是 32 位字符），或找分享给你的人重新发一条。',
    );
  }
  if (result.state === 'expired') {
    return err(
      410,
      'SHARE_EXPIRED',
      `这条分享链接已于 ${result.expires_at}（UTC）到期，内容不再展示。` +
        '分享链接都有有效期：它不带任何凭据，谁拿到谁能看，长期有效等于把内容公开发出去了。' +
        '还需要看的话，请找分享给你的人再发一条。',
    );
  }
  if (result.state === 'revoked') {
    return err(
      410,
      'SHARE_REVOKED',
      '分享给你这条链接的人已经把它收回了，内容不再展示。如仍需查看，请直接联系对方。',
    );
  }

  return NextResponse.json({ ok: true, share: result.view });
}
