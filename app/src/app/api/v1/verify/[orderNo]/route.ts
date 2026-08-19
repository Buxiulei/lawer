// app/src/app/api/v1/verify/[orderNo]/route.ts
// GET 按存证订单号公开查询（spec §8：/verify/:no 可离线复核哈希与时间戳）。
//
// **本接口刻意无鉴权**：仲裁对方、办案人员拿到订单号就该能核，不该先注册账号。
// 因此返回体不含持证人姓名/证件号（见 lib/evidence.getVerification 注释），
// 且订单号本身带 64 bit 随机段、不可枚举。
import { NextResponse } from 'next/server';

import { domainFailure } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import * as evidence from '@/lib/evidence';

export async function GET(_req: Request, { params }: { params: Promise<{ orderNo: string }> }) {
  const { orderNo } = await params;

  const result = evidence.getVerification(getDb(), decodeURIComponent(orderNo));
  if (!result.ok) return domainFailure(result);

  const { ok: _ok, ...verification } = result;
  return NextResponse.json({ ok: true, verification });
}
