// app/src/app/api/v1/files/download/[token]/route.ts
// 用一次性 token 取回一份文件（设计稿 §2 E draft_export）。
// **是 PUT /api/v1/evidence/upload/{token} 的反向**：那条只收一次字节，这条只发一次字节。
//
// 【为什么不挂鉴权】签发方（draft_export）已经确认过身份、实名与归属，并把这条地址只交给了
// 那一个人。这里再要一次凭据，用户就没法把它丢进浏览器打开——而"用浏览器打开就能拿到文件"
// 正是这条地址的用途。安全性由 token 本身担：128 bit 全随机、只取一次、10 分钟。
//
// 【闸的顺序是判据的一部分】token 有效性 → 抢占 → 读文件。抢占之前不读盘，
// 抢占失败（并发/重放/刚过期）一个字节都不发。
import { getDb } from '@/lib/db/client';
import { readBytes } from '@/lib/evidence/files';
import {
  claimDownloadToken,
  inspectDownloadToken,
  DOWNLOAD_TOKEN_TTL_MS,
} from '@/lib/files/download-token';

const TTL_MINUTES = DOWNLOAD_TOKEN_TTL_MS / 60_000;

// 一次性：缓存住等于把"只取一次"变成"取一次之后 CDN 无限次"。
export const dynamic = 'force-dynamic';

function err(status: number, errorCode: string, message: string): Response {
  return Response.json({ ok: false, error_code: errorCode, message }, { status });
}

/**
 * Content-Disposition 的文件名。ASCII 那份把非 ASCII 换成下划线（老客户端只认它），
 * filename* 那份按 RFC 5987 给 UTF-8 原名——只给 ASCII 那份的话，
 * 用户存到桌面上的中文文书会变成一串下划线，认不出是哪一份。
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const db = getDb();
  const { token } = await params;
  const plain = decodeURIComponent(token ?? '');

  const seen = inspectDownloadToken(db, plain);
  if (seen.state === 'not_found') {
    return err(
      404,
      'DOWNLOAD_TOKEN_NOT_FOUND',
      '这条下载地址不存在。请核对地址是否完整，或重新发起一次导出取一条新地址。',
    );
  }
  if (seen.state === 'consumed') {
    return err(
      410,
      'DOWNLOAD_TOKEN_USED',
      '这条下载地址已经用过了，一条地址只能取一次文件。' +
        '短命且一次性是刻意的：这条地址不带任何凭据，可重放的话，它出现过的每个地方都成了取件口。' +
        '请重新发起一次导出，取一条新地址。',
    );
  }
  if (seen.state === 'expired') {
    return err(
      410,
      'DOWNLOAD_TOKEN_EXPIRED',
      `这条下载地址已过期（有效期 ${TTL_MINUTES} 分钟）。请重新发起一次导出，取到新地址后立刻下载。`,
    );
  }

  // 【一次性就落在这一句】条件写抢占；抢不到说明另一个并发请求（或上一次重试）已经用掉了它。
  const claimed = claimDownloadToken(db, plain);
  if (!claimed) {
    return err(
      410,
      'DOWNLOAD_TOKEN_USED',
      '这条下载地址刚刚被用掉或已过期，本次没有取到文件。请重新发起一次导出，取一条新地址。',
    );
  }

  let bytes: Buffer;
  try {
    bytes = readBytes(db, claimed.file_id);
  } catch (e) {
    // 文件缺失或哈希不符：readBytes 一律抛，绝不返回残缺内容。这里如实说"取不到"，
    // 不静默回一个空文件——空文件看起来像下载成功了。
    return err(
      500,
      'FILE_UNREADABLE',
      '文件记录在，但内容取不回来（可能是存储损坏）。这条下载地址已作废，请重新发起一次导出；' +
        `若仍失败请把这句话原样报给客服。原因：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': claimed.mime ?? 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'Content-Disposition': contentDisposition(claimed.filename),
      'Cache-Control': 'no-store',
    },
  });
}
