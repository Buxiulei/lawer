// app/src/app/api/v1/cases/[id]/messages/route.ts
// GET 案件的历史对话。写那一路在同级的 chat/（POST + SSE），这里只管读。
//
// 【为什么要有这条端点】messages 表一直在写，但读只有服务端自己用（listRecentMessages
// 拼上下文）。网页打开时**从不取历史**：用户关掉页面再回来，聊过的全部内容在屏幕上
// 消失，而库里一条不少。对一个在等仲裁的人来说，那是"我讲过的经过没了"。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) {
    return NextResponse.json(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }

  const result = cases.listMessages(getDb(), { caseId, userId: guard.identity.uid });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json({ ok: true, messages: result.messages });
}
