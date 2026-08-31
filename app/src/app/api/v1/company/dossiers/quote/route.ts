// app/src/app/api/v1/company/dossiers/quote/route.ts
// POST 公司档案报价。**这个端点不动钱**：不扣费、不建档、不占额度，纯只读。
// 之所以单独开一个端点而不是把价写在前端：价目在 pricing_config 表里，改价改表不发版，
// 前端写死一份就会出现「页面显示 340、实际扣 200」这种收错钱的偏差。
//
// 请求体：{ name, uscc?, modules?: DossierModule[], doc_count?: number }
//   modules 省略即六个模块都报；doc_count = 免费探测给的"有公开文书链接的劳动争议篇数"，M5/M6 计价用。
import { NextResponse } from 'next/server';

import { domainFailure, requireIdentity } from '@/lib/auth/guard';
import { badRequest, readJsonBody, stringField } from '@/lib/auth/http';
import { getDb } from '@/lib/db/client';
import { quoteDossier } from '@/lib/company/dossier-billing';
import { parseModules, parseDocCount } from '../modules';

export async function POST(req: Request) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const body = await readJsonBody(req);
  if (!body) return badRequest('INVALID_BODY', '请求体格式不正确');

  const modules = parseModules(body.modules);
  if (!modules) {
    return badRequest(
      'INVALID_MODULES',
      'modules 只能是 venue/entity/graph/docs_list/docs_stats/patterns 的非空数组。' +
        '写了别的值说明前后端对模块名的理解不一致，宁可报错也不静默按默认值报价——' +
        '按默认值报价会让用户看到一个他没选的总价。省略 modules 即六个模块都报。',
    );
  }

  const docCount = parseDocCount(body.doc_count);
  if (docCount === null) {
    return badRequest('INVALID_DOC_COUNT', 'doc_count 必须是非负整数（有公开文书链接的可计费篇数）。');
  }

  const result = quoteDossier(getDb(), guard.identity.uid, {
    name: stringField(body, 'name').trim(),
    uscc: stringField(body, 'uscc').trim() || null,
    modules,
    docCount,
  });
  if (!result.ok) return domainFailure(result);

  return NextResponse.json({ ok: true, quote: result.quote });
}
