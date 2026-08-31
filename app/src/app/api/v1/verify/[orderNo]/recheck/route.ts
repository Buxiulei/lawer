// app/src/app/api/v1/verify/[orderNo]/recheck/route.ts
// POST 按存证订单号做**服务端实时复核**：当场重算原件哈希、重新验《存证证明》的签名与时间戳。
//
// **本接口刻意无鉴权**（与同级 GET 一致）：仲裁对方、办案人员拿到订单号就该能核，
// 不该先注册账号。代价是它比 GET 重得多（读盘、解密、调 sidecar），故按 IP 限流
// 24h 30 次（计数器在 lib/evidence/recheck.ts，与登录发码的额度各记各的）。
//
// 响应体不含持证人姓名/证件号——与 GET 同口径，理由见 lib/evidence.getVerification。
// sidecar 的裁决也不全量透传：出境前过 toPublicVerdict 白名单投影（它自己写的
// error / signatures[].error 是裸 Python 异常原文，留在服务端日志里）。
import { NextResponse } from 'next/server';

import { extractClientIp } from '@/lib/auth/ip-quota';
import { domainFailure } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import * as evidence from '@/lib/evidence';

export async function POST(req: Request, { params }: { params: Promise<{ orderNo: string }> }) {
  const { orderNo } = await params;

  const result = await evidence.recheckVerification(getDb(), {
    orderNo: decodeURIComponent(orderNo),
    ip: extractClientIp(req.headers),
  });
  if (!result.ok) return domainFailure(result);

  const { order_no, overall_ok, checks, verdict } = result.report;
  return NextResponse.json({
    ok: true,
    order_no,
    overall_ok,
    checks,
    verdict: evidence.toPublicVerdict(verdict),
  });
}
