// app/src/app/api/v1/redeem/route.ts
// POST /api/v1/redeem —— 用户在「我的」页输一条兑换码，面值公道值到账。
//
// 【入账只走 lib/billing 的 gongdaoGrant】本路由一行 SQL 都不写：一码一兑的幂等由
// `lib/billing/redeem.ts` 的两道闸把住（码行 CAS 占位 + ledger 的 (type, ref_id) 唯一索引），
// 路由自己拼 SQL 就等于绕开这两道。
import { NextResponse } from 'next/server';

import { requireIdentity } from '@/lib/auth/guard';
import { badRequest, failureResponse, readJsonBody, stringField } from '@/lib/auth/http';
import { isRedeemLocked, recordRedeemFailure, redeemCode } from '@/lib/billing/redeem';
import { getDb } from '@/lib/db/client';

/**
 * 失败时对外的**唯一**一句话。
 *
 * 【为什么四种失败共用一句】码不存在 / 已被兑 / 已过期 / 已停用，只要回得不一样，
 * 这个接口就成了一台**码存在性预言机**：撞库的人不必兑成功，只要能分辨「这条不存在」
 * 和「这条存在但已被用」，就等于拿到了一个可枚举的判据，把 30^16 的搜索空间
 * 从「必须猜中一张没人用过的码」降成「猜中任意一张码即可确认字母表/长度/发码规律」。
 * 面值是凭空造出来的公道值，这个预言机的代价是真金白银。
 *
 * 代价是抄错一位的用户看不到「你抄错了」。这条代价由下面那句提示词承担
 * （明说了「对一下有没有抄错」），而不是由分叉的错误码承担。
 */
const INVALID_MESSAGE = '兑换码无效或已使用。对一下有没有抄错，或者换一条再试。';

/** 失败锁的提示：这条**必须**与 INVALID_MESSAGE 可区分——用户有权知道自己现在是被限速了。 */
const LOCKED_MESSAGE = '这个账号一小时内输错太多次了，先歇一会儿再试。';

export async function POST(req: Request): Promise<NextResponse> {
  const db = getDb();
  const guard = requireIdentity(db, req, 'case:write');
  if (!guard.ok) return guard.response;
  const uid = guard.identity.uid;

  const body = await readJsonBody(req);
  if (!body) return badRequest('BAD_REQUEST', '请求体不是合法 JSON');
  const code = stringField(body, 'code').trim();
  if (!code) return badRequest('REDEEM_CODE_REQUIRED', '请填写兑换码');

  // 锁在**核销之前**判：锁上之后连正确的码也兑不了，这是刻意的——
  // 撞库的人手里迟早会攒出一条真码，那时若还放行，前面 10 次失败就白拦了。
  if (isRedeemLocked(db, uid)) {
    return failureResponse({ ok: false, status: 429, errorCode: 'REDEEM_LOCKED', message: LOCKED_MESSAGE });
  }

  const result = redeemCode(db, uid, code);
  if (!result.ok) {
    // 四种 reason 在这里全部合流：**不要**按 reason 分支返回，理由见 INVALID_MESSAGE。
    recordRedeemFailure(db, uid);
    return failureResponse({ ok: false, status: 400, errorCode: 'REDEEM_INVALID', message: INVALID_MESSAGE });
  }

  return NextResponse.json({ ok: true, gongdao: result.gongdao, balance: result.balance });
}
