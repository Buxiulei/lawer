// app/src/app/api/v1/billing/ledger/route.ts
// GET 本人的公道值余额与流水。
//
// 【为什么要有这个端点】「我的」页此前整半边读的是 @/app/_mock/authpay：
// 余额是 mockLedger[0].balanceAfter，流水是 15 条写死的演示条目。
// 页面上写着「每一笔都记着只增不改」，而渲染的是假账——**承诺与渲染源对不上**。
//
// 响应里同时给 balance 与 ledger_sum，见 lib/billing 的说明：只给一个数，
// 物化余额与账本不符时页面会渲染出一个看起来完全正常的错数。
import { NextResponse } from 'next/server';

import { requireIdentity } from '@/lib/auth/guard';
import { listGongdaoLedger } from '@/lib/billing';
import { getDb } from '@/lib/db/client';

export async function GET(req: Request) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 50);
  const view = listGongdaoLedger(guard.identity.uid, Number.isFinite(limit) ? limit : 50, getDb());

  return NextResponse.json({ ok: true, ...view });
}
