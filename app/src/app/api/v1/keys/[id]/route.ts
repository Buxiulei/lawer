// app/src/app/api/v1/keys/[id]/route.ts
// DELETE /api/v1/keys/{id}  吊销 api key
// 实为 enabled=0 而非删行：key_hash 上有 UNIQUE 约束，留着行既防同一把 key 被重新注册，
// 也保住审计线索（何时创建、最后一次何时被用）。
import { NextResponse } from 'next/server';

import { parseId, requireWebSession } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import * as store from '@/lib/db/api-keys';

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  const id = parseId((await params).id);
  const row = id === null ? undefined : store.findApiKeyById(getDb(), id);
  // 别人的 key 与不存在的 key 返回同一个错误，不泄漏 id 是否被占用
  if (!row || row.user_id !== guard.identity.uid) {
    return NextResponse.json(
      { ok: false, error_code: 'KEY_NOT_FOUND', message: 'api key 不存在' },
      { status: 404 },
    );
  }

  store.disableApiKey(getDb(), row.id);
  return NextResponse.json({ ok: true, id: row.id, enabled: false });
}
