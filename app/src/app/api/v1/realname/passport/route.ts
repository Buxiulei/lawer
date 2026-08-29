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
import { NextResponse } from 'next/server';

import { requireWebSession } from '@/lib/auth/guard';
import { badRequest } from '@/lib/auth/http';
import { initPassportRealname } from '@/lib/auth/passport-realname';
import { AUTH_STATUS, VERIFICATION_STATUS } from '@/lib/auth/realname';
import { getDb } from '@/lib/db/client';

/** 从 multipart 里取一个文件，转成字节 + mime；缺了给 null 让领域层出统一文案 */
async function material(form: FormData, field: string) {
  const f = form.get(field);
  if (!(f instanceof File) || f.size === 0) return { bytes: Buffer.alloc(0), mime: null };
  return { bytes: Buffer.from(await f.arrayBuffer()), mime: f.type || null };
}

export async function POST(req: Request) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequest('INVALID_BODY', '请以 multipart/form-data 提交');
  }

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
}
