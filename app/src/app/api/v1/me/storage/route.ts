// app/src/app/api/v1/me/storage/route.ts
// GET 本人的存储用量。只读、只给自己那一行——uid 取自 guard.identity，
// **不接受任何入参指定用户**：多一个 ?user_id= 就多一条越权读别人档案的路。
// 管理侧的全量聚合走 CLI（scripts/storage-audit.ts），不在 HTTP 面上开全量口。
//
// 口径（含「一文件多主」「有引用无主」两个坑）见 lib/db/storageAudit.ts 抬头。
// 这里只给本人视角的数：共享文件在自己名下按全额计，因为对用户说
// 「你占 0 字节，因为别人也传过同一份」毫无意义。
import { NextResponse } from 'next/server';

import { requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { getUserStorage } from '@/lib/db/storageAudit';

export async function GET(req: Request) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  return NextResponse.json({ ok: true, storage: getUserStorage(getDb(), guard.identity.uid) });
}
