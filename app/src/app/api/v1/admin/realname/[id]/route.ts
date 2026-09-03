// app/src/app/api/v1/admin/realname/[id]/route.ts
// GET /api/v1/admin/realname/:id  一条护照流水的详情（含姓名、护照号明文——见 pending/route.ts 抬头）。
//
// 只读，**不带"必须还待审"这道门**：已通过/已驳回的记录也要能翻出来看
//（"当时是谁批的、为什么驳的"是事后唯一能查的东西）。
// 材料只出哈希与大小，字节走 photo 子路由 —— 详情会被前端当成 JSON 缓存进内存，
// 把两张证件照 base64 塞进来等于让它们跟着每一次列表刷新在内存里多躺一份。
import { NextResponse } from 'next/server';

import { adminNotFound, adminServerError, requireAdmin } from '@/lib/admin/auth';
import { readPassportEnvelope } from '@/lib/auth/passport-realname';
import { parseId } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const guard = requireAdmin(db, req);
  if (!guard.ok) return guard.response;

  const id = parseId((await params).id);
  if (id === null) return adminNotFound();

  let record;
  try {
    record = readPassportEnvelope(db, id);
  } catch (err) {
    return adminServerError(
      'REALNAME_ENVELOPE_BROKEN',
      err instanceof Error ? err.message : String(err),
    );
  }
  // 查无此行、或这条流水走的是刷脸通道：都回与"路径不存在"同形的空体 404。
  if (!record) return adminNotFound();

  return NextResponse.json({
    ok: true,
    verification_id: record.verificationId,
    user_id: record.userId,
    status: record.status,
    cert_name: record.certName,
    cert_no: record.certNo,
    materials: {
      id_page: { sha256: record.materials.id_page.sha256, size: record.materials.id_page.size },
      selfie: { sha256: record.materials.selfie.sha256, size: record.materials.selfie.size },
    },
    submitted_at: record.submittedAt,
    audit: record.audit ?? null,
    reject: record.reject ?? null,
  });
}
