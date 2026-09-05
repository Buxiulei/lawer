// app/src/app/api/v1/evidence/upload/[token]/route.ts
// PUT 用一次性 token 上传证据字节（设计稿 §2 B）。MCP 的 evidence_upload_url 签发地址，
// 字节走这里，之后 agent 再用同一个 token 调 evidence_register 建条目。
//
// 【这条路和 POST /api/v1/evidence 的分工】那条是网页表单的一步到位（multipart，字节与
// 元数据同一个请求）；这条只收字节，body 就是文件本身。两条**共用同一套闸门**
// （实名、体积、并发内存预算）与同一条落盘管线（storeBytes 的内容寻址 + 加密），
// 不另开一套——另开一套的形态是其中一条悄悄少了一道闸，而两条看起来都在正常工作。
//
// 【闸的顺序是判据的一部分】实名 → token 有效性 → Content-Length → 并发槽位 →
// 读请求体 → 真实体积 → 抢占 token → 落盘。任何一档没过，盘上都不该多一个字节。
import { NextResponse } from 'next/server';

import { requireIdentity, requireRealname } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { storeBytes } from '@/lib/evidence/files';
import {
  MAX_UPLOAD_BYTES_ANY,
  maxUploadBytesFor,
  MAX_CONCURRENT_UPLOADS,
  parseContentLength,
  tryAcquireUploadSlot,
} from '@/lib/evidence/upload-guard';
import {
  attachFile,
  claimUploadToken,
  inspectUploadToken,
  UPLOAD_TOKEN_TTL_MS,
} from '@/lib/evidence/upload-token';

const TTL_MINUTES = UPLOAD_TOKEN_TTL_MS / 60_000;

function err(status: number, errorCode: string, message: string): NextResponse {
  return NextResponse.json({ ok: false, error_code: errorCode, message }, { status });
}

/** token 不存在与不是自己的 token 回同一个错误：能分辨的话，这条地址就成了枚举别人案卷的探针。 */
function tokenNotFound(): NextResponse {
  return err(
    404,
    'UPLOAD_TOKEN_NOT_FOUND',
    '这条上传地址不存在。上传地址由 evidence_upload_url 签发，且只能由签发它的那个账号使用；' +
      `请重新调用 evidence_upload_url 取一条新地址（有效期 ${TTL_MINUTES} 分钟），再往新地址 PUT 文件。`,
  );
}

function tooLarge(actualBytes: number, limitBytes: number, mime: string | null): NextResponse {
  const actualMb = (actualBytes / 1024 / 1024).toFixed(1);
  const limitMb = limitBytes / 1024 / 1024;
  return err(
    413,
    'FILE_TOO_LARGE',
    `这次上传约 ${actualMb} MB，超过 ${mime ?? '该类型'} 单次 ${limitMb} MB 的上限，文件没有被保存，` +
      '这条上传地址也还没被用掉（可以直接换个更小的文件再 PUT 一次）。' +
      '上限按类型分档：图片与 PDF 25 MB、录音 100 MB、视频 100 MB——' +
      '服务器要把整份文件读进内存做哈希和加密，占用是文件本身的好几倍，放行超大文件会把进程撑爆。' +
      '请把文件压小（录音先剪成分段、视频降到 720p）或拆成几份分别上传——拆开传不影响后续出证。',
  );
}

export async function PUT(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const db = getDb();
  const guard = requireIdentity(db, req, 'case:write');
  if (!guard.ok) return guard.response;

  // 【实名闸在最前】与 POST /api/v1/evidence 同口径：只查一行 users、不读请求体，
  // 未实名的证据一个字节都不该落盘。
  const realname = requireRealname(
    db,
    guard.identity,
    '上传证据前需先完成实名认证。证据要与本人身份绑定：未实名的证据无法保存，日后也无法用于出证。' +
      '请先到「设置 → 实名认证」完成认证后再上传。',
  );
  if (!realname.ok) return realname.response;

  const { token } = await params;
  const seen = inspectUploadToken(db, decodeURIComponent(token ?? ''));
  if (seen.state === 'not_found' || seen.row?.user_id !== guard.identity.uid) {
    return tokenNotFound();
  }
  if (seen.state === 'consumed') {
    return err(
      409,
      'UPLOAD_TOKEN_USED',
      '这条上传地址已经用过了，一条地址只收一次文件。' +
        '如果上一次就是你传的，直接用同一个 upload_token 调 evidence_register 登记这条证据；' +
        '如果要再传一份别的文件，请重新调用 evidence_upload_url 取一条新地址。',
    );
  }
  if (seen.state === 'expired') {
    return err(
      410,
      'UPLOAD_TOKEN_EXPIRED',
      `这条上传地址已过期（有效期 ${TTL_MINUTES} 分钟），文件没有被保存。` +
        '有效期短是刻意的：这条地址不带鉴权头就能写字节，长期有效等于一把长期钥匙。' +
        '请重新调用 evidence_upload_url 取一条新地址，取到之后立刻上传。',
    );
  }
  const row = seen.row;

  const limit = maxUploadBytesFor(row.mime);

  // 【闸一】只看 Content-Length，在读请求体之前。读完再判大小已经晚了——内存已经占掉了。
  // 这一档**不消耗 token**：拒的是这次请求，不是这条地址，换个小文件还能用同一条。
  const declared = parseContentLength(req.headers.get('content-length'));
  if (declared !== null && declared > limit) return tooLarge(declared, limit, row.mime);

  // 【闸二】并发内存预算。声明多少就预留多少；没声明按最大档预留（宁可少放一个进来）。
  const release = tryAcquireUploadSlot(declared ?? row.size ?? MAX_UPLOAD_BYTES_ANY);
  if (!release) {
    return err(
      429,
      'UPLOAD_BUSY',
      `服务器同时处理的上传已达上限（最多 ${MAX_CONCURRENT_UPLOADS} 个，且合计内存有预算），这次上传没有被受理。` +
        '这里不排队——排队等于把请求体继续攒在内存里，正是这道闸要防的事。' +
        '请等十几秒后用同一条上传地址重试；这条地址还没被用掉，你的文件也没有任何损失。',
    );
  }

  try {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await req.arrayBuffer());
    } catch {
      return err(400, 'INVALID_BODY', '读不到请求体。本接口的 body 就是文件字节本身，不是表单也不是 JSON。');
    }

    // 后备闸：没带 Content-Length（chunked）或声明值撒谎时，用真实字节数再量一次。
    if (bytes.length > limit) return tooLarge(bytes.length, limit, row.mime);
    if (bytes.length === 0) {
      return err(
        400,
        'EMPTY_FILE',
        '请求体是空的，没有文件被保存，这条上传地址也还没被用掉。请把文件字节直接作为 PUT 的 body 发过来。',
      );
    }

    // 【一次性就落在这一句】条件写抢占；抢不到说明另一个并发请求（或上一次重试）已经用掉了它。
    const claimed = claimUploadToken(db, decodeURIComponent(token));
    if (!claimed) {
      const again = inspectUploadToken(db, decodeURIComponent(token));
      if (again.state === 'expired') {
        return err(
          410,
          'UPLOAD_TOKEN_EXPIRED',
          `这条上传地址在读取文件的过程中过期了（有效期 ${TTL_MINUTES} 分钟），文件没有被保存。` +
            '请重新调用 evidence_upload_url 取一条新地址再传。',
        );
      }
      return err(
        409,
        'UPLOAD_TOKEN_USED',
        '这条上传地址刚刚被用掉了（同一条地址只收一次文件），本次请求的文件没有被保存。' +
          '如果那一次也是你发的，直接用这个 upload_token 调 evidence_register 登记；否则请另取一条新地址。',
      );
    }

    const stored = storeBytes(db, bytes, row.mime);
    attachFile(db, claimed.id, stored.fileId);

    return NextResponse.json(
      {
        ok: true,
        upload_token_consumed: true,
        file: { size: stored.size, sha256: stored.sha256, deduped: stored.deduped },
        next: '字节已收下，但还没有证据条目。请用同一个 upload_token 调 evidence_register 填名称、分类与证明目的。',
      },
      { status: 201 },
    );
  } finally {
    release();
  }
}
