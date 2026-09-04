// app/src/app/api/v1/evidence/route.ts
// POST 上传证据文件（multipart）。路由只做取参 + 调 lib/evidence + 返回，
// 外加两道内存闸门（体积、并发）——闸门必须在路由这一层，因为它们要挡的正是
// req.formData() 把整个请求体读进内存这一步，进不了 lib 就晚了。
import { NextResponse } from 'next/server';

import { domainFailure, requireIdentity, requireRealname } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import * as evidence from '@/lib/evidence';
import {
  MAX_CONCURRENT_UPLOADS,
  MAX_UPLOAD_BYTES,
  parseContentLength,
  tryAcquireUploadSlot,
} from '@/lib/evidence/upload-guard';

const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / 1024 / 1024;

function formString(form: FormData, key: string): string | null {
  const v = form.get(key);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function tooLarge(actualBytes: number): NextResponse {
  const actualMb = (actualBytes / 1024 / 1024).toFixed(1);
  return NextResponse.json(
    {
      ok: false,
      error_code: 'FILE_TOO_LARGE',
      message:
        `这次上传约 ${actualMb} MB，超过单次 ${MAX_UPLOAD_MB} MB 的上限，文件没有被保存。` +
        `原因是服务器要把整份文件读进内存做哈希和加密，占用是文件本身的好几倍，` +
        `放行超大文件会把进程撑爆、连带影响正在用的其他人。` +
        `请把文件压缩到 ${MAX_UPLOAD_MB} MB 以内再传（长录音先剪成分段、照片改存 JPG），` +
        `或者拆成几份分别上传——拆开传不影响后续出证。`,
    },
    { status: 413 },
  );
}

function uploadBusy(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error_code: 'UPLOAD_BUSY',
      message:
        `服务器同时处理的上传已达 ${MAX_CONCURRENT_UPLOADS} 个上限，这次上传没有被受理。` +
        `原因是每个上传都要在内存里放一份文件副本，再放行会把整站拖垮，所以这里不排队、直接回绝。` +
        `请等十几秒后重新点一次上传；你的文件没有任何损失，系统里也没留下半条记录。`,
    },
    { status: 429 },
  );
}

export async function POST(req: Request) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  // 【实名闸】前移到上传：未实名的证据不落库、不落盘。放在体积/并发闸之前——这道判定
  // 只查一行 users，不读请求体，理应最先拒；也让未实名的人拿到「去实名」这条自述文案，
  // 而不是先撞上体积或并发的错。判定逻辑只在 guard.requireRealname 一处，这里只调它。
  const realname = requireRealname(
    getDb(),
    guard.identity,
    '上传证据前需先完成实名认证。证据要与本人身份绑定：未实名的证据无法保存，日后也无法用于出证。' +
      '请先到「设置 → 实名认证」完成认证后再上传。',
  );
  if (!realname.ok) return realname.response;

  // 【闸一】只看 Content-Length，在 req.formData() 之前。formData() 会把整个请求体读进
  // 内存，读完再判大小已经晚了——内存已经占掉了，判断只能决定要不要再浪费后面几份副本。
  const declared = parseContentLength(req.headers.get('content-length'));
  if (declared !== null && declared > MAX_UPLOAD_BYTES) return tooLarge(declared);

  // 【闸二】并发槽位。占满立即 429，不排队（理由见 upload-guard.ts）。
  const release = tryAcquireUploadSlot();
  if (!release) return uploadBusy();

  try {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json(
        { ok: false, error_code: 'INVALID_BODY', message: '请求体不是合法的 multipart 表单' },
        { status: 400 },
      );
    }

    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error_code: 'FILE_REQUIRED', message: '缺少 file 字段' },
        { status: 400 },
      );
    }

    // 后备闸：没带 Content-Length（chunked）或声明值撒谎时，用真实文件大小再量一次。
    // 这时请求体已经进了内存，拦不住第一份副本——那份由 Caddy 的路由级 30MB 兜底
    // （见 deploy/Caddyfile）；这里挡住的是 arrayBuffer + Buffer.from + 加密那三份。
    if (file.size > MAX_UPLOAD_BYTES) return tooLarge(file.size);

    const rawCaseId = formString(form, 'case_id') ?? '';
    if (!/^\d+$/.test(rawCaseId)) {
      return NextResponse.json(
        { ok: false, error_code: 'INVALID_CASE_ID', message: 'case_id 必须是正整数' },
        { status: 400 },
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const result = evidence.uploadEvidence(getDb(), {
      caseId: Number(rawCaseId),
      userId: guard.identity.uid,
      bytes,
      name: formString(form, 'name') ?? file.name ?? '',
      mime: file.type || null,
      category: formString(form, 'category') ?? undefined,
      provePurpose: formString(form, 'prove_purpose'),
      originalMedium: formString(form, 'original_medium'),
    });
    if (!result.ok) return domainFailure(result);

    return NextResponse.json(
      { ok: true, evidence: result.evidence, deduped: result.deduped },
      { status: 201 },
    );
  } finally {
    release();
  }
}
