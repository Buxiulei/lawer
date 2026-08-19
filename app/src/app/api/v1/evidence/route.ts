// app/src/app/api/v1/evidence/route.ts
// POST 上传证据文件（multipart）。路由只做取参 + 调 lib/evidence + 返回。
import { NextResponse } from 'next/server';

import { domainFailure, requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import * as evidence from '@/lib/evidence';

function formString(form: FormData, key: string): string | null {
  const v = form.get(key);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export async function POST(req: Request) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体不是合法的 multipart 表单' },
      { status: 400 },
    );
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error_code: 'FILE_REQUIRED', message: '缺少 file 字段' },
      { status: 400 },
    );
  }

  const rawCaseId = formString(form, 'case_id') ?? '';
  if (!/^\d+$/.test(rawCaseId)) {
    return NextResponse.json(
      { ok: false, error_code: 'INVALID_CASE_ID', message: 'case_id 必须是正整数' },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const result = evidence.uploadEvidence(getDb(), {
    caseId: Number(rawCaseId),
    userId: guard.identity.uid,
    bytes,
    name: formString(form, 'name') ?? file.name ?? '',
    mime: file.type || null,
    category: formString(form, 'category') ?? undefined,
    provePurpose: formString(form, 'prove_purpose'),
    originalMedium: formString(form, 'original_medium'),
  });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json(
    { ok: true, evidence: result.evidence, deduped: result.deduped },
    { status: 201 },
  );
}
