// app/src/app/api/v1/keys/_secret.ts
// 「查看/轮换密钥明文」两条路径共用的前置检查与错误措辞。
//
// 【为什么两条路径共用一份】它们撞见的是同一个前置条件（主密钥配没配好）。
// 各写各的措辞，形态是同一件事在两个页面上有两种说法，而两种说法里总有一种没交代出路。
import { NextResponse } from 'next/server';

import { masterKeyConfigured } from '@/lib/crypto';
import { findApiKeyById, type ApiKeyRow } from '@/lib/db/api-keys';
import { getDb } from '@/lib/db/client';

/**
 * 归属校验。**别人的 key 与不存在的 key 返回同一个响应体**，不泄漏 id 是否被占用
 *（与 DELETE /keys/{id} 逐字一致）。
 */
export function ownedKey(id: number | null, uid: number): ApiKeyRow | null {
  const row = id === null ? undefined : findApiKeyById(getDb(), id);
  return row && row.user_id === uid ? row : null;
}

export function keyNotFound(): NextResponse {
  return NextResponse.json(
    { ok: false, error_code: 'KEY_NOT_FOUND', message: 'api key 不存在' },
    { status: 404 },
  );
}

/**
 * 主密钥没配好。自述三段式：缺什么 / 为什么缺 / 怎么办。
 *
 * 【不许把 err.message 透传出去】那句话是写给运维看的（「env LAWER_DATA_KEY 长度错误：
 * 解出 31 字节」），对用户既看不懂也没有出路，还顺带把服务端的环境变量名与内部状态
 * 端到了公网上。这里给的是**用户这一侧能做什么**：什么都不用做，这把 key 没坏。
 */
export function secretUnavailable(action: '查看' | '轮换'): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error_code: 'SECRET_UNAVAILABLE',
      message:
        `缺什么：服务端的加解密主密钥这次不可用，密钥明文${action}不了。` +
        `为什么缺：明文是加密后存在库里的，${action}要用那把主密钥；它没配好，我们就取不出来。` +
        `怎么办：你这把 key 本身完全没事、照常能用，不用重新配置客户端；等我们这边修好再回来${action}。`,
    },
    { status: 503 },
  );
}

/** 密文解不开：这条记录的明文是真的找不回来了，唯一出路是轮换。 */
export function secretDecryptFailed(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error_code: 'SECRET_DECRYPT_FAILED',
      message:
        '缺什么：这把 key 存下来的明文解不开。' +
        '为什么缺：多半是服务端的主密钥换过，早前存的密文跟现在这把对不上。' +
        '怎么办：这一把的明文找不回来了，点「轮换」换一把新的——名字、权限都不变，' +
        '换完把新密钥重新配进你的客户端就行。',
    },
    { status: 500 },
  );
}

/** 没有密文可解（本列上线之前签发的存量密钥）。 */
export function keyNotViewable(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error_code: 'KEY_NOT_VIEWABLE',
      message:
        '缺什么：这把是旧密钥，看不到明文。' +
        '为什么缺：它签发的时候我们还没有留存明文，当年就只存了指纹，今天也变不出来。' +
        '怎么办：点「轮换」换一把新的——名字、权限都不变，换完把新密钥重新配进你的客户端。',
    },
    { status: 409 },
  );
}

export { masterKeyConfigured };
