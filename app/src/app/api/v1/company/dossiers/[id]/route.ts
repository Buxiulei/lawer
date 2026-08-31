// app/src/app/api/v1/company/dossiers/[id]/route.ts
// GET 一条公司档案的当前状态与**计费实况**（每个模块付了多少、退了多少、核心走的是钱还是赠送券）。
//
// 【本响应暂不含采集分块进度】「哪个模块跑到哪一步」的事实源在采集与统计管线那张工单，
// 本分支里还没有那张表。与其在这里编一个 progress 字段占位，不如先不给——一个永远停在 queued、
// 看起来却完全正常的假进度，比缺一个字段难查得多。那张工单落地后在这里合流即可，已有字段保持不动。
//
// 归属：档案是公司维度的平台资产（同一家公司全站一条），不是案件私有资产。
// 没权限与不存在返回**同一个** 404——否则这个端点就成了「这家公司有没有人建过档」的探针。
import { NextResponse } from 'next/server';

import { parseId, requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { getDossierBillingView } from '@/lib/company/dossier-billing';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const notFound = NextResponse.json(
    {
      ok: false,
      error_code: 'DOSSIER_NOT_FOUND',
      message:
        '找不到这条公司档案，或它不属于你。' +
        '档案按公司归档、按购买人授权：只有下过单或为它付过费的账号能看。' +
        '如果你确实买过，请回到公司档案列表页从入口进入，不要直接改地址栏里的编号。',
    },
    { status: 404 },
  );

  const dossierId = parseId((await params).id);
  if (dossierId === null) return notFound;

  const view = getDossierBillingView(getDb(), dossierId, guard.identity.uid);
  if (!view) return notFound;

  return NextResponse.json({
    ok: true,
    dossier: {
      id: view.dossier.id,
      company_key: view.dossier.company_key,
      name: view.dossier.name,
      uscc: view.dossier.uscc,
      status: view.dossier.status,
      created_at: view.dossier.created_at,
    },
    billing: {
      modules: view.modules,
      net_gongdao: view.netGongdao,
      paid_by_membership_credit: view.paidByMembershipCredit,
    },
  });
}
