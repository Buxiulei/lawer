// app/src/app/api/v1/company/dossiers/confirm/route.ts
// POST 确认下单：扣公道值（核心可用会员赠送券核销）并建档。
//
// 扣费端点用 case:write —— 与「会花钱的动作」同级；报价那条是 case:read。
// 一把只读 key 能触发扣费，是这类端点最容易漏的一格。
//
// 请求体：{ name, uscc?, modules?: DossierModule[], doc_count?: number } 与报价端点逐字同形，
// 前端把报价用的那个对象原样发过来即可——两边字段不同名会让「报的价」与「买的东西」错位。
// ⚠️ doc_count 权威来源应是服务端探测缓存（采集工单）；该表落地前由本路由透传，见 DossierOrderInput 注释。
import { NextResponse } from 'next/server';

import { domainFailure, requireIdentity } from '@/lib/auth/guard';
import { badRequest, readJsonBody, stringField } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';
import { confirmDossier } from '@/lib/company/dossier-billing';
import { parseModules, parseDocCount } from '../modules';

export async function POST(req: Request) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;

  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const modules = parseModules(body.modules);
  if (!modules) {
    return badRequest(
      'INVALID_MODULES',
      'modules 只能是 venue/entity/graph/docs_list/docs_stats/patterns 的非空数组。' +
        '写了别的值说明前后端对模块名的理解不一致，宁可报错也不静默按默认值下单——' +
        '按默认值下单会扣走用户没打算买的那些模块的钱。省略 modules 即六个模块都买。',
    );
  }

  const docCount = parseDocCount(body.doc_count);
  if (docCount === null) {
    return badRequest('INVALID_DOC_COUNT', 'doc_count 必须是非负整数（有公开文书链接的可计费篇数）。');
  }

  const result = confirmDossier(getDb(), guard.identity.uid, {
    name: stringField(body, 'name').trim(),
    uscc: stringField(body, 'uscc').trim() || null,
    modules,
    docCount,
  });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json({
    ok: true,
    dossier_id: result.dossierId,
    paid_by: result.paidBy,
    charged: result.charged,
    entitlement_id: result.entitlementId,
    quote: result.quote,
  });
}
