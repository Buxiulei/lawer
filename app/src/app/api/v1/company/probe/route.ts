// app/src/app/api/v1/company/probe/route.ts
// POST 免费前置探测（方案 v3 §2.3）：**扣费之前**免费返回四个数字 + 一行工商状态。
//
// 【这条端点不动钱，也不建档】它只读缓存、（有采集器时）采一次、记一次配额。
// 报价页把「必定有货」从承诺变成扣费前可验证的事实，靠的就是这条。
//
// 【降级如实说，不返回空】缓存未命中且今日配额用完 / 采集器未接入时，
// 返回 status=quota_exhausted / no_collector 并带上 reason 原话，由页面逐字渲染。
// 返回一个空载荷会被读成「查无此公司」——那是这条端点最不能出的一种谎。
// app 侧默认不注入采集器（采集在外勤工作站，不在服务器），故线上常态是 hit 或 no_collector。
import { NextResponse } from 'next/server';

import { requireIdentity } from '@/lib/auth/guard';
import { badRequest, readJsonBody, stringField } from '@/lib/auth/http';
import { probeCompany } from '@/lib/company/probe';
import { getDb } from '@/lib/db/client';

export async function POST(req: Request) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const name = stringField(body, 'name').trim();
  const uscc = stringField(body, 'uscc').trim() || null;

  let probe;
  try {
    probe = await probeCompany(getDb(), { name, uscc, userId: guard.identity.uid });
  } catch (err) {
    // 归一化算不出档案主键（公司名与统一社会信用代码都空）时抛的是那句三段式说明，原样转给用户。
    // 本路由自己不算键、也不碰那一列，只负责把它转成 400。
    return badRequest('COMPANY_NAME_EMPTY', err instanceof Error ? err.message : String(err));
  }

  return NextResponse.json({ ok: true, probe });
}
