// app/src/app/api/v1/cases/[id]/paste-back/confirm/route.ts
// POST /api/v1/cases/{id}/paste-back/confirm  body {batch_id, accept:[序号]} → 写入。
//
// 幂等靠 client_ref = paste-<batch_id>-<序号>（见 lib/paste/apply）：
// 同一批重放多少次，档案里都只有一份。

import { domainFailure, parseId, requireWebSession } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';
import { confirmPasteBack } from '@/lib/paste';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) {
    return apiJson(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }

  const body = await readJsonBody(req);
  if (!body) {
    return apiJson(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体格式不正确' },
      { status: 400 },
    );
  }

  const result = await confirmPasteBack(getDb(), guard.identity, {
    caseId,
    batchId: body.batch_id,
    accept: body.accept,
  });
  if (!result.ok) return domainFailure(result);

  return apiJson(result);
}
