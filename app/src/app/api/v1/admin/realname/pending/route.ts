// app/src/app/api/v1/admin/realname/pending/route.ts
// GET /api/v1/admin/realname/pending  待人工审核的护照实名队列。
//
// 【这条响应里有 PII，且是刻意的】姓名与护照号在库里只以密文存在（raw_meta_enc 信封），
// 审核这件事本身就是"人看着材料核对姓名与护照号"——不给明文就没法审。
// 所以解密**只发生在过了 requireAdmin 之后的这几条路由里**，
// 别处（用户列表、审计表、日志）一律不出现它们。
//
// 队列每人至多一行：见 lib/db/realname.listPendingByProvider 的注释
//（审到一条陈旧流水会造成"操作成功但用户状态没变"的静默不一致）。
import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/admin/auth';
import { decryptPhoneFull } from '@/lib/admin/users';
import { PASSPORT_PROVIDER, readPassportEnvelope } from '@/lib/auth/passport-realname';
import { VERIFICATION_STATUS } from '@/lib/auth/realname';
import { getDb } from '@/lib/db/client';
import { listPendingByProvider } from '@/lib/db/realname';

export async function GET(req: Request) {
  const db = getDb();
  const guard = requireAdmin(db, req);
  if (!guard.ok) return guard.response;

  const pending = listPendingByProvider(db, PASSPORT_PROVIDER, VERIFICATION_STATUS.pending);

  const rows = pending.map((row) => {
    const contact = db
      .prepare('SELECT email, phone_enc FROM users WHERE id = ?')
      .get(row.user_id) as { email: string | null; phone_enc: string | null } | undefined;
    const { phone, error } = decryptPhoneFull(contact?.phone_enc ?? null);

    // 一条流水的信封解不开，不该让整个队列打不开——那一行带着自述式的 error 现身，
    // 其余的照常审。静默跳过它才是坏的：那条待审会永远没人看见。
    let certName: string | null = null;
    let certNo: string | null = null;
    let envError: string | null = null;
    try {
      const record = readPassportEnvelope(db, row.id);
      certName = record?.certName ?? null;
      certNo = record?.certNo ?? null;
    } catch (err) {
      envError = err instanceof Error ? err.message : String(err);
    }

    return {
      verification_id: row.id,
      user_id: row.user_id,
      email: contact?.email ?? null,
      phone,
      phone_error: error,
      cert_name: certName,
      cert_no: certNo,
      envelope_error: envError,
      submitted_at: row.created_at,
    };
  });

  return NextResponse.json({ ok: true, count: rows.length, rows });
}
