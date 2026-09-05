// app/src/lib/capabilities/families/evidence.ts
// B 族：证据（设计稿 §2 B）。P1 只有既有的读清单一条。
import * as cases from '@/lib/cases';

import { caseIdProp, num } from '../shared';
import type { Capability } from '../registry';

export const evidenceList: Capability = {
  name: 'evidence_list',
  family: 'evidence',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/evidence' },
  title: '列出证据',
  description: '列出案件下已登记的证据条目（名称、分类、证明目的、固化状态）。',
  inputSchema: {
    type: 'object',
    properties: { ...caseIdProp },
    required: ['case_id'],
  },
  run: (db, identity, args) =>
    cases.listEvidence(db, { caseId: num(args.case_id), userId: identity.uid }),
};
