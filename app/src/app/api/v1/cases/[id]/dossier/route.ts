// app/src/app/api/v1/cases/[id]/dossier/route.ts
// GET 本案被申请人的公司档案（契约 docs/contracts/dossier-api.md §二）。
//
// 【为什么要有这条，而不是让页面直接打 /company/dossiers/{id}】页面手上只有 caseId。
// 档案是**公司维度**的平台资产（company_key 唯一、跨案共享），案件是用户维度的；
// 这条端点做的就是那一次解析：案件 → 被申请人主体 → 档案（键的计算在
// lib/company/dossier.findDossierBySubject 里，本文件不碰键）。
// 它是 /company/dossiers/{id} 的薄包装：**归属判据同一条**（getDossierBillingView，
// 没买过就当没有），只是入口的钥匙从 dossier_id 换成了 case_id。
//
// 【解析本身在 lib/dossier/case-dossier.ts】本路由只做 HTTP 皮：鉴权 → 调它 → 包 JSON。
// 用户自己的 agent 走 dossier_get 调的是同一个函数，两条路径不会各自演化。
//
// 【没有档案不是错误】三种情况在用户那里是同一件事——「这个案子还没建过档」：
//   ① 案里还没落被申请人主体；② 这家公司全站没人建过档；③ 建过，但这个账号没买过。
// 一律 200 + `{ status: 'none', dossier: null, orderPath }`，页面据此引导去报价页。
// **三种不分开说**：分开说等于把「这家公司有没有人建过档」做成一个人人可查的探针
// （同 /company/dossiers/{id} 把「无权限」与「不存在」合并成一个 404 的理由）。
//
// 【为什么 404 不再兼作"还没建档"】端点不存在时前端拿到的也是 404。
// 两者在页面上长成同一个样子的那段时间里，档案页对每一个真实案件都在打一个不存在的端点、
// 显示着一屏体面的「还没建档」——mock 了网络层的组件测试全绿，而端点根本没写。
// 所以「还没建档」必须是一个**明确的 200 载荷**，404 只留给「案件不存在或不属于你」。
//
// 【demo 不走这条】演示案件的 id 不是数字、且必须在未登录时也能看，
// 它的档案形状由前端的 mock 直接给（DossierLoader 的 isDemo 分支）。
// 让这条端点认 'demo' 就等于开一个免鉴权分支——为了演示在鉴权上开的口子，
// 会被真实案件一起用上。
import { NextResponse } from 'next/server';

import { domainFailure, parseId, requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { getCaseDossier } from '@/lib/dossier/case-dossier';

const NOT_FOUND = { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) return NextResponse.json(NOT_FOUND, { status: 404 });

  const result = getCaseDossier(getDb(), { caseId, userId: guard.identity.uid });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json({
    ok: true,
    status: result.status,
    dossier: result.dossier,
    orderPath: result.orderPath,
  });
}
