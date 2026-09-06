// app/src/app/api/v1/cases/[id]/paste-back/route.ts
// POST /api/v1/cases/{id}/paste-back  body {text} → 解析预览（**不写库**）。
//
// 【为什么只认网页登录态】这条是给「坐在网页前、手上有那段回复」的人用的。
// 让 api key 也能调，等于开一条「agent 把一段自己写的文本喂进来当预览」的旁路——
// 而真有 key 的 agent 本来就能直接调那四条写能力，不必绕这里。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireWebSession } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';
import { previewPasteBack } from '@/lib/paste';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) {
    return NextResponse.json(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }

  const body = await readJsonBody(req);
  if (!body) {
    return NextResponse.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体格式不正确' },
      { status: 400 },
    );
  }

  const result = previewPasteBack(getDb(), {
    caseId,
    userId: guard.identity.uid,
    text: body.text,
  });
  if (!result.ok) {
    // 危机提示要跟着失败一起回：块格式不对不该让一个人拿不到号码
    const res = domainFailure(result);
    return result.crisis?.triggered
      ? NextResponse.json({ ...(await res.json()), crisis: result.crisis }, { status: result.status })
      : res;
  }

  return NextResponse.json(result);
}
