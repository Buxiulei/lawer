// app/src/app/api/v1/keys/route.ts
// GET  /api/v1/keys  列出自己的 api key（列表永不回显 key 明文或 hash）
// POST /api/v1/keys  创建 api key —— 明文在这次响应里给出，同时以密文落库，
//                    之后可用 GET /keys/{id}/secret 再取回（判据 C19 盯着"存下的确实是它"）
//
// 只认网页登录态：不允许拿一把 api key 再造新 key，否则一把泄漏的 key 就能自我续命，
// 吊销原 key 也止不住血。
import { NextResponse } from 'next/server';

import { generateApiKey, hashApiKey, normalizeRequestedScopes } from '@/lib/auth/api-key';
import { requireWebSession } from '@/lib/auth/guard';
import { readJsonBody, stringField } from '@/lib/auth/http';
import { encryptField } from '@/lib/crypto';
import { getDb } from '@/lib/db/client';
import * as store from '@/lib/db/api-keys';
import { issuedKeyBody } from './_issued';
import { NO_STORE, masterKeyConfigured, secretUnavailable } from './_secret';

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
    // MCP 客户端自报的名字。走 REST 的不报 → null，前端退到 name 并说明那是用户自己起的名。
    client_name: row.client_name,
    /**
     * 这把能不能在页面上把明文再看一次。存量旧密钥（secret_enc 为空）恒 false——
     * 页面据此显示「旧密钥不可查看，请轮换」，而不是给一个点了报错的按钮。
     */
    viewable: row.viewable === 1,
    rotated_at: row.rotated_at,
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

  // 先探再签：主密钥不可用时若照签不误，落库的就是一把**永远看不了明文**的 key——
  // 它一出生就长成了"存量旧密钥"的样子，而用户完全无从知道差别在哪。
  if (!masterKeyConfigured()) return secretUnavailable('查看');

  const key = generateApiKey();
  const id = store.insertApiKey(getDb(), {
    userId: guard.identity.uid,
    name,
    keyHash: hashApiKey(key),
    scopesJson: JSON.stringify(scopes),
    // 明文的密文，供日后 GET /keys/{id}/secret 取回。**不是 hash**：hash 解不开，
    // 存错了要到用户第一次回来查看明文时才发现，而那时错的已经是全部存量 key。
    secretEnc: encryptField(key),
  });

  return NextResponse.json(
    issuedKeyBody(req, { id, name, scopes, clientName: null, key }),
    // 正文里躺着明文：这一趟谁都不许缓存（NO_STORE 那段注释说了为什么）
    { status: 201, headers: NO_STORE },
  );
}
