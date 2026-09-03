// app/src/app/api/v1/keys/[id]/secret/route.ts
// GET /api/v1/keys/{id}/secret  取回这把 key 的明文
//
// 【为什么这条路径存在】此前明文只在创建响应里出现一次，关掉那一屏之后设置页的接入话术里
// 就只剩占位符——用户想换台设备接一次，唯一的出路是吊销重建，而重建会让已经配好的
// 其它客户端一起断连。这把 key 保护的是他自己的案件档案，他本来就有权再看一眼。
//
// 【只认网页登录态】与 POST /keys 同一条理由：允许拿 api key 读出自己的明文没有意义，
// 允许它读出**别的 key** 的明文则等于一把泄漏的 key 能横向拿走全部凭据。
//
// 【绝不 touch last_used_at】那一列是「接没接上」的唯一判据（_ui/useConnectedAgent）。
// 在网页上看一眼密钥不是「你的助手连进来了」，写这一列会把判据污染成假阳性：
// 页面从此说「已接入」，而用户其实一个字都还没粘进客户端。
import { NextResponse } from 'next/server';

import { parseId, requireWebSession } from '@/lib/auth/guard';
import { decryptField } from '@/lib/crypto';
import { getDb } from '@/lib/db/client';
import {
  keyNotFound,
  keyNotViewable,
  masterKeyConfigured,
  ownedKey,
  secretDecryptFailed,
  secretUnavailable,
} from '../../_secret';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  const row = ownedKey(parseId((await params).id), guard.identity.uid);
  if (!row) return keyNotFound();

  // 已吊销的也让看：查看 ≠ 使用。吊销的那把拿回来也调不动任何接口
  //（resolveIdentity 只认 enabled=1），而用户想核对"当年配进去的是不是这一把"是正当的。
  if (!row.secret_enc) return keyNotViewable();
  if (!masterKeyConfigured()) return secretUnavailable('查看');

  let key: string;
  try {
    key = decryptField(row.secret_enc);
  } catch {
    return secretDecryptFailed();
  }

  return NextResponse.json({ ok: true, id: row.id, name: row.name, key });
}
