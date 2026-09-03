// app/src/app/api/v1/admin/realname/[id]/photo/[kind]/route.ts
// GET /api/v1/admin/realname/:id/photo/:kind   kind ∈ id_page | selfie
//
// 证件照的**原始字节**，经管理员鉴权后流式返回。
//
// 【为什么不给公开 URL、不落 public】材料落盘是内容寻址 + AES-GCM 整文件加密
//（lib/evidence/files），盘上没有一个可直接读的图片文件。若为了让 <img> 好写就把它
// 解密一份丢进 public/，那份明文就永远躺在那儿了——一条能被猜到路径的 URL
// 等于把身份证照片公开发布，而它的失败形态是"一切正常，只是有人拿到了"。
//
// 【为什么带 no-store】证件照经过的每一层（浏览器磁盘缓存、公司代理、CDN）都会留副本。
// 后台在办公室的电脑上打开，缓存就落在那台电脑上；管理员换人、电脑转手，照片还在。
//
// 【前端不能直接 <img src="…">】本站鉴权是 Authorization: Bearer（localStorage 里的 token），
// 浏览器发 <img> 请求不带这个头 ⇒ 会撞上闸门的 404。取图必须用 fetch + blob + objectURL
//（见 RealnamePendingQueue.tsx）。
import { NextResponse } from 'next/server';

import { adminBadRequest, adminNotFound, adminServerError, requireAdmin } from '@/lib/admin/auth';
import { readPassportEnvelope } from '@/lib/auth/passport-realname';
import { parseId } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { findFileById } from '@/lib/db/evidence';
import { readBytes } from '@/lib/evidence/files';

const KINDS = ['id_page', 'selfie'] as const;
type Kind = (typeof KINDS)[number];

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; kind: string }> },
) {
  const db = getDb();
  const guard = requireAdmin(db, req);
  if (!guard.ok) return guard.response;

  const { id: rawId, kind: rawKind } = await params;
  const id = parseId(rawId);
  if (id === null) return adminNotFound();
  if (!(KINDS as readonly string[]).includes(rawKind)) {
    return adminBadRequest('BAD_KIND', `材料只有 ${KINDS.join(' / ')} 两种`);
  }
  const kind = rawKind as Kind;

  let record;
  try {
    record = readPassportEnvelope(db, id);
  } catch (err) {
    return adminServerError(
      'REALNAME_ENVELOPE_BROKEN',
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!record) return adminNotFound();

  const ref = record.materials?.[kind];
  const file = ref ? findFileById(db, ref.file_id) : undefined;
  if (!ref || !file) return adminNotFound();

  let bytes: Buffer;
  try {
    bytes = readBytes(db, ref.file_id);
  } catch (err) {
    // 库里有行、盘上没文件（或哈希对不上）。这不是"没这张图"，是存储坏了——
    // 说清楚是哪一种，运维才知道该去查挂载点还是查密钥。
    return adminServerError(
      'MATERIAL_UNREADABLE',
      err instanceof Error ? err.message : String(err),
    );
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': file.mime || 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store',
    },
  });
}
