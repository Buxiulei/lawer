// app/src/app/api/v1/realname/passport/route.ts
// POST /api/v1/realname/passport  multipart: real_name, passport_no, id_page, selfie
//   → {ok, verification_id, auth_status:'待审', verification_status:'待审'}
//
// 【为什么要有这条路】阿里云实人认证只认中国大陆身份证——**只有护照的人根本没有那扇门**。
// 而 attest 需已实名，于是整条证据固化链路对他恒不可用。这不是体验问题，是可用性为零。
//
// 只认网页登录态，与 /realname/init 同一条纪律：实名是把真实身份绑到账号上的一次性动作，
// 不该由用户的 agent 代劳。
//
// 提交后是「待审」，**不是「已实名」**——人工核过材料、经审核脚本落定才转。
// requireRealname 只在「已实名」放行（guard.ts:69），所以待审期间 attest 仍然拿不到。
//
// 【内存闸和证据路由共用一套】这条路是 formData + arrayBuffer + 加密的同一种内存放大路径，
// 而且一次收**两份**材料（各上限 8MiB），放大倍数比证据那条只高不低。两条路打的是同一块
// 进程内存，所以共用同一个常量、同一个 4 槽信号量（见 lib/evidence/upload-guard）——
// 各开一个池等于把预算算两遍，两边各占满就是 8 个上传在同一个 1280M 的 cgroup 里。
import { NextResponse } from 'next/server';

import { requireWebSession } from '@/lib/auth/guard';
import { badRequest } from '@/lib/auth/http';
import { initPassportRealname } from '@/lib/auth/passport-realname';
import { AUTH_STATUS, VERIFICATION_STATUS } from '@/lib/auth/realname';
import { getDb } from '@/lib/db/client';
import {
  MAX_CONCURRENT_UPLOADS,
  MAX_UPLOAD_BYTES,
  parseContentLength,
  tryAcquireUploadSlot,
} from '@/lib/evidence/upload-guard';

const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / 1024 / 1024;

function tooLarge(actualBytes: number): NextResponse {
  const actualMb = (actualBytes / 1024 / 1024).toFixed(1);
  return NextResponse.json(
    {
      ok: false,
      error_code: 'FILE_TOO_LARGE',
      message:
        `这次提交约 ${actualMb} MB，超过单次 ${MAX_UPLOAD_MB} MB 的上限，材料没有被保存。` +
        `原因是服务器要把两份材料整个读进内存做哈希和加密，占用是文件本身的好几倍，` +
        `放行超大提交会把进程撑爆、连带影响正在用的其他人。` +
        `请把护照资料页与手持自拍各压到 8MB 以内再提交（手机相册里选「中等」尺寸导出，` +
        `或改存 JPG）——审核只要看清姓名、护照号和人脸，不需要原图那么大。`,
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
        `服务器同时处理的上传已达 ${MAX_CONCURRENT_UPLOADS} 个上限，这次提交没有被受理。` +
        `原因是每个上传都要在内存里放一份文件副本，再放行会把整站拖垮，所以这里不排队、直接回绝。` +
        `请等十几秒后重新提交一次；你的材料没有任何损失，系统里也没留下半条记录，实名状态不变。`,
    },
    { status: 429 },
  );
}

/** 从 multipart 里取一个文件，转成字节 + mime；缺了给 null 让领域层出统一文案 */
async function material(form: FormData, field: string) {
  const f = form.get(field);
  if (!(f instanceof File) || f.size === 0) return { bytes: Buffer.alloc(0), mime: null };
  return { bytes: Buffer.from(await f.arrayBuffer()), mime: f.type || null };
}

export async function POST(req: Request) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

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
      return badRequest('INVALID_BODY', '请以 multipart/form-data 提交');
    }

    // 这里不再补一道按文件大小的后备闸：领域层对**每份**材料已经卡死 8MiB
    // （passport-realname.ts 的 MATERIAL_TOO_LARGE），两份合起来 16MiB 本就低于上面的上限。
    // 没带 Content-Length（chunked）时进内存的第一份副本由 Caddy 的 30MB 兜底
    // （见 deploy/Caddyfile 的 @uploads）。
    const result = initPassportRealname(getDb(), {
      userId: guard.identity.uid,
      realName: form.get('real_name'),
      passportNo: form.get('passport_no'),
      idPage: await material(form, 'id_page'),
      selfie: await material(form, 'selfie'),
    });
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error_code: result.errorCode, message: result.message },
        { status: result.status },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        verification_id: result.verificationId,
        auth_status: AUTH_STATUS.pending,
        verification_status: VERIFICATION_STATUS.pending,
      },
      { status: 201 },
    );
  } finally {
    release();
  }
}
