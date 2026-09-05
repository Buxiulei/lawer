// app/src/lib/capabilities/families/company.ts
// H 族：公司主体（设计稿 §2 H）。P1 只有登记/补充一条，背调与守望是后续工单。
import * as cases from '@/lib/cases';
import { LABOR_CAPABILITY_COPY } from '@/lib/domains/labor';

import { caseIdProp, num, writeOnce } from '../shared';
import type { Capability } from '../registry';

export const companyProfileUpsert: Capability = {
  name: 'company_profile_upsert',
  family: 'company',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { clientRef: true, naturalKey: '同案 + 同 name 一条，再写即在这条上补字段' },
  title: '登记公司主体',
  description: LABOR_CAPABILITY_COPY.companyProfileUpsertDescription,
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      name: { type: 'string', description: '公司全称，尽量与营业执照一致' },
      role: { type: 'string', enum: [...cases.COMPANY_ROLES], description: '默认签约主体' },
      uscc: { type: 'string', description: '统一社会信用代码，不知道就不传' },
      legal_rep: { type: 'string', description: '法定代表人' },
      note: { type: 'string', description: '风险点：注册资本、经营异常、关联公司等' },
      sources: { type: 'string', description: '结论出处（用户自述 / 企业信息平台 / 用户回传截图），必须可溯源' },
      client_ref: {
        type: 'string',
        description: '幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库',
      },
    },
    required: ['case_id', 'name'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    return writeOnce(
      db,
      {
        caseId,
        tool: 'company_profile_upsert',
        clientRef: args.client_ref,
        keyId: identity.keyId ?? null,
      },
      () =>
        cases.upsertCompany(db, {
          caseId,
          userId: identity.uid,
          name: args.name,
          role: args.role,
          uscc: args.uscc,
          legalRep: args.legal_rep,
          note: args.note,
          sources: args.sources,
        }),
      (res) => ({ table: 'company_profiles', id: res.id }),
    );
  },
};
