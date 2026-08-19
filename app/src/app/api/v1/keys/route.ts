// app/src/app/api/v1/keys/route.ts
// GET  /api/v1/keys  列出自己的 api key（永不回显 key 明文或 hash）
// POST /api/v1/keys  创建 api key —— **明文只在这一次响应里出现，之后无从找回**
//
// 只认网页登录态：不允许拿一把 api key 再造新 key，否则一把泄漏的 key 就能自我续命，
// 吊销原 key 也止不住血。
import { NextResponse } from 'next/server';

import { generateApiKey, hashApiKey, normalizeRequestedScopes } from '@/lib/auth/api-key';
import { requireWebSession } from '@/lib/auth/guard';
import { readJsonBody, stringField } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';
import * as store from '@/lib/db/api-keys';

export async function GET(req: Request) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  const keys = store.listApiKeys(getDb(), guard.identity.uid).map((row) => ({
    id: row.id,
    name: row.name,
    scopes: row.scopes ? JSON.parse(row.scopes) : [],
    enabled: row.enabled === 1,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  }));
  return NextResponse.json({ ok: true, keys });
}

export async function POST(req: Request) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  const body = await readJsonBody(req);
  if (!body) {
    return NextResponse.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体格式不正确' },
      { status: 400 },
    );
  }

  const name = stringField(body, 'name').trim();
  if (!name) {
    return NextResponse.json(
      { ok: false, error_code: 'INVALID_NAME', message: 'name 不能为空，用来分辨这把 key 给谁用' },
      { status: 400 },
    );
  }

  const scopes = normalizeRequestedScopes(body.scopes);
  if (!scopes) {
    return NextResponse.json(
      { ok: false, error_code: 'INVALID_SCOPES', message: 'scopes 含未知权限项' },
      { status: 400 },
    );
  }

  const key = generateApiKey();
  const id = store.insertApiKey(getDb(), {
    userId: guard.identity.uid,
    name,
    keyHash: hashApiKey(key),
    scopesJson: JSON.stringify(scopes),
  });

  return NextResponse.json(
    {
      ok: true,
      id,
      name,
      scopes,
      key,
      warning: '这是唯一一次显示 key 明文，请立刻保存；丢了只能吊销后重建。',
    },
    { status: 201 },
  );
}
