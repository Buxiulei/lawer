// app/src/app/api/v1/keys/[id]/rotate/route.ts
// POST /api/v1/keys/{id}/rotate  换发新明文，旧明文立即失效
//
// 【与「吊销后重建」的区别，就是这条路径的全部意义】重建会换掉 id，于是用户在设置页
// 认的那一行没了、页面本地缓存的 issued.id 对不上、client_name（对方助手自报的名字）
// 也一并丢掉——他明明只是想换一串密码。轮换保留 id / name / scopes / client_name，
// 变的只有那串明文。
//
// 【鉴权同 POST /keys】只认网页登录态：能拿 api key 给自己换发新密钥，等于一把泄漏的
// key 可以自我续命，吊销原 key 也止不住血。
import { NextResponse } from 'next/server';

import { generateApiKey, hashApiKey, parseScopes } from '@/lib/auth/api-key';
import { parseId, requireWebSession } from '@/lib/auth/guard';
import { encryptField } from '@/lib/crypto';
import * as store from '@/lib/db/api-keys';
import { getDb } from '@/lib/db/client';
import { issuedKeyBody } from '../../_issued';
import {
  NO_STORE,
  keyNotFound,
  keyRevoked,
  masterKeyConfigured,
  ownedKey,
  secretUnavailable,
} from '../../_secret';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  const row = ownedKey(parseId((await params).id), guard.identity.uid);
  if (!row) return keyNotFound();

  // 【吊销的不给轮换】enabled=0 之后 resolveIdentity 一律不认这一行，换多少次新明文
  // 都还是一把 401 的 key。放它过去的形态最坏：用户在设置页看着「已吊销」那枚标记，
  // 手里却拿到一串刚发的、看起来完全正常的新密钥，配进客户端之后一头撞上 401，
  // 而页面从头到尾没说过一句它不能用。出路是新建，不是再轮换一次。
  if (row.enabled !== 1) return keyRevoked();

  // 先探再写：主密钥不可用时若照旧 UPDATE，旧明文已经作废而新明文存不下密文，
  // 用户会拿到一把"这辈子只能看这一眼"的 key——比直接说不行更糟。
  if (!masterKeyConfigured()) return secretUnavailable('轮换');

  const key = generateApiKey();
  store.rotateApiKeySecret(getDb(), row.id, {
    keyHash: hashApiKey(key),
    secretEnc: encryptField(key),
  });

  return NextResponse.json(
    issuedKeyBody(req, {
      id: row.id,
      name: row.name,
      // scopes 不许在轮换里改：那是另一件事（要收紧权限走吊销重建，用户得知道自己在改权限）
      scopes: parseScopes(row.scopes),
      clientName: row.client_name,
      key,
    }),
    // 正文里躺着明文：这一趟谁都不许缓存
    { headers: NO_STORE },
  );
}
