// app/src/app/api/v1/docs/[id]/route.ts
// GET 取一份来文解读的全文（对应 MCP 工具 doc_get，同一个领域函数）。
import { NextResponse } from 'next/server';

import { parseId, requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { getDoc } from '@/lib/docs';

// 每次现造一个：Response 的 body 是一次性的流，模块级共用一个实例会在第二次请求时
// 回一份空 body（且不报错）。
const notFound = () =>
  NextResponse.json(
    { ok: false, error_code: 'DOC_NOT_FOUND', message: '解读不存在' },
    { status: 404 },
  );

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const docId = parseId((await params).id);
  // 别人的与不存在的同码同文案：doc_id 是连号的，区分开就能拿它探测别人解读过什么。
  if (docId === null) return notFound();
  const doc = getDoc(getDb(), docId, guard.identity.uid);
  if (!doc) return notFound();

  return NextResponse.json({ ok: true, doc });
}
