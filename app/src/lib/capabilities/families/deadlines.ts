// app/src/lib/capabilities/families/deadlines.ts
// F 族：期限（设计稿 §2 F）。
import * as cases from '@/lib/cases';
import { LABOR_CAPABILITY_COPY } from '@/lib/domains/labor';

import { caseIdProp, num } from '../shared';
import type { Capability } from '../registry';

export const deadlineList: Capability = {
  name: 'deadline_list',
  family: 'deadlines',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/deadlines' },
  title: '列出法定期限',
  // 这句话里举的期限种类是领域内容，正本在 lib/domains/labor.ts（共用层不写领域字面量）
  description: LABOR_CAPABILITY_COPY.deadlineListDescription,
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      include_resolved: { type: 'boolean', description: '是否连已履行/作废的一起列出' },
    },
    required: ['case_id'],
  },
  run: (db, identity, args) =>
    cases.listDeadlines(db, {
      caseId: num(args.case_id),
      userId: identity.uid,
      includeResolved: args.include_resolved === true,
    }),
};
