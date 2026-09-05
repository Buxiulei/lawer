// app/src/lib/capabilities/families/actions.ts
// G 族：行动卡（设计稿 §2 G）。
import * as cases from '@/lib/cases';

import { caseIdProp, num } from '../shared';
import type { Capability } from '../registry';

export const actionList: Capability = {
  name: 'action_list',
  family: 'actions',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/actions' },
  title: '列出行动卡',
  description: '列出案件下的行动项，可按状态过滤（待办 / 完成 / 放弃）。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      status: { type: 'string', enum: [...cases.ACTION_STATUSES], description: '只看某个状态' },
    },
    required: ['case_id'],
  },
  run: (db, identity, args) =>
    cases.listActions(db, {
      caseId: num(args.case_id),
      userId: identity.uid,
      status: args.status === undefined ? undefined : String(args.status),
    }),
};

export const actionComplete: Capability = {
  name: 'action_complete',
  family: 'actions',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'PATCH', path: '/api/v1/cases/{id}/actions/{actionId}' },
  title: '完成行动卡',
  description: '把一条行动项标记为完成；也可以传 status 标记为放弃。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      action_id: { type: 'integer', description: '行动项 id' },
      status: {
        type: 'string',
        enum: [...cases.ACTION_STATUSES],
        description: '目标状态，默认「完成」',
      },
    },
    required: ['case_id', 'action_id'],
  },
  run: (db, identity, args) =>
    cases.setActionStatus(db, {
      caseId: num(args.case_id),
      userId: identity.uid,
      actionId: num(args.action_id),
      status: args.status,
    }),
};
