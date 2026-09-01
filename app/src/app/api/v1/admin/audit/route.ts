// app/src/app/api/v1/admin/audit/route.ts
// GET /api/v1/admin/audit  最近的后台操作（admin_audit 倒序）。
// 只读，不提供删除/编辑端点：一张能被后台自己改的审计表等于没有审计表。
import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/admin/auth';
import { listRecentAudit } from '@/lib/admin/audit';
import { getDb } from '@/lib/db/client';

export async function GET(req: Request) {
  const db = getDb();
  const guard = requireAdmin(db, req);
  if (!guard.ok) return guard.response;

  const limit = Number(new URL(req.url).searchParams.get('limit') ?? '50');
  const rows = listRecentAudit(db, Number.isFinite(limit) ? limit : 50);

  return NextResponse.json({
    ok: true,
    rows: rows.map((r) => ({
      id: r.id,
      operator_uid: r.operator_uid,
      action: r.action,
      target_uid: r.target_uid,
      // detail_json 原样透出（前端只渲染，不解释）：审计要看的是当时到底记了什么，
      // 在这里挑字段等于让读表的人相信我们挑得对。
      detail_json: r.detail_json,
      created_at: r.created_at,
    })),
  });
}
