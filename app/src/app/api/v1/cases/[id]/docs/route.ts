// app/src/app/api/v1/cases/[id]/docs/route.ts
// GET 列出这个案件下已解读的对方来文（对应 MCP 工具 doc_list，同一个领域函数）。
// 只列卡片要的字段，不返回原文与逐条发现——那两样按 doc_id 走 /api/v1/docs/{doc_id}。
import { NextResponse } from 'next/server';

import { parseId, requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { listDocs } from '@/lib/docs';

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

  // 归属由 listDocs 自己按 cases.user_id 判：不是本人的案件读到的是空列表，
  // 与「这个案件一份都没解读过」同形——不区分「不存在」与「不是你的」。
  return NextResponse.json({ ok: true, docs: listDocs(getDb(), caseId, guard.identity.uid) });
}
