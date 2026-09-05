// app/src/app/api/v1/evidence/[id]/brief/route.ts
// GET 读证据简报 / PUT 整份改写（乐观锁）。与 MCP 的 evidence_brief_get / evidence_brief_update
// 共用 lib/evidence/extraction 里的同一对函数。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { validateBrief } from '@/lib/evidence/brief';
import { getEvidenceBrief, updateEvidenceBrief } from '@/lib/evidence/extraction';

const NOT_FOUND = () =>
  NextResponse.json(
    { ok: false, error_code: 'EVIDENCE_NOT_FOUND', message: '这件材料不存在' },
    { status: 404 },
  );

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const evidenceId = parseId((await params).id);
  if (evidenceId === null) return NOT_FOUND();

  const result = getEvidenceBrief(getDb(), { evidenceId, userId: guard.identity.uid });
  if (!result.ok) return domainFailure(result);
  return NextResponse.json(result);
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const evidenceId = parseId((await params).id);
  if (evidenceId === null) return NOT_FOUND();

  let body: { brief?: unknown; reason?: unknown; base_version?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // 空 body 交给下面的 schema 校验统一回话
  }

  const checked = validateBrief(body.brief);
  if (!checked.ok) {
    return NextResponse.json(
      { ok: false, error_code: 'INVALID_BRIEF', message: `简报不合 schema：${checked.problems.join('；')}` },
      { status: 400 },
    );
  }
  // base_version 不是可选项：缺了就没法判断中间有没有别人改过，写下去会静默盖掉那次改动
  if (!Number.isInteger(body.base_version)) {
    return NextResponse.json(
      {
        ok: false,
        error_code: 'INVALID_BASE_VERSION',
        message: 'base_version 必须是整数，且必须是你刚读到的那一版（先 GET 本端点拿 version）',
      },
      { status: 400 },
    );
  }

  const result = updateEvidenceBrief(getDb(), {
    evidenceId,
    userId: guard.identity.uid,
    brief: checked.brief!,
    reason: typeof body.reason === 'string' ? body.reason : '',
    baseVersion: body.base_version as number,
    updatedBy: 'web',
  });
  if (!result.ok) return domainFailure(result);
  return NextResponse.json(result);
}
