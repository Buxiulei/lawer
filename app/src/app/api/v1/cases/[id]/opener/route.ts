// app/src/app/api/v1/cases/[id]/opener/route.ts
// GET /api/v1/cases/{id}/opener?tier=long|medium|short → 无工具模式的「陪跑开场白」纯文本。
//
// 【为什么两种凭据都收】网页要它（设置页那颗「复制开场白」），用户自己的脚本也可能要它
// （把开场白喂给一个自建的 agent）。它只读、不写、不花钱，凭据够读档案就够拿它。

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';
import { buildOpener, isOpenerTier, OPENER_TIERS } from '@/lib/paste';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) {
    return apiJson(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }

  const raw = new URL(req.url).searchParams.get('tier') ?? 'medium';
  if (!isOpenerTier(raw)) {
    return apiJson(
      {
        ok: false,
        error_code: 'INVALID_TIER',
        message: `tier 只能是 ${Object.keys(OPENER_TIERS).join(' / ')}（分别对应约 ${Object.values(OPENER_TIERS).join(' / ')} 字）。`,
      },
      { status: 400 },
    );
  }

  const result = buildOpener(getDb(), { caseId, identity: guard.identity, tier: raw });
  if (!result.ok) return domainFailure(result);

  return apiJson({
    ok: true,
    tier: result.tier,
    budget: result.budget,
    length: result.text.length,
    omitted: result.omitted,
    text: result.text,
  });
}
