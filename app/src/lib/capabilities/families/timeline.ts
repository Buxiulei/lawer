// app/src/lib/capabilities/families/timeline.ts
// A 族里的时间线部分（设计稿 §2 A、P4：时间线只追加）。
import * as cases from '@/lib/cases';

import { caseIdProp, num } from '../shared';
import type { Capability } from '../registry';

export const timelineAdd: Capability = {
  name: 'timeline_add',
  family: 'timeline',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  // 【注意】本条的 client_ref 走的是 timeline_events 自己的列与索引（早于 agent_writes 落地），
  // 不经 lib/capabilities/idempotent。新写能力统一走那个助手，这条**保持原样不动**：
  // 改一条已经在生产上跑着的幂等路径，换来的只是"两处长得一样"。
  idempotency: {
    clientRef: true,
    naturalKey: '同案 + 同日 + 同类别 + 标题去掉标点空白后相等',
  },
  rest: { method: 'POST', path: '/api/v1/cases/{id}/timeline' },
  title: '追加时间线事件',
  description:
    '给案件时间线追加一条事件。时间线只追加不修改，记错了就再补一条更正事件。' +
    '写入自带幂等：传相同 client_ref 重放只落一条（返回 deduped:true）；' +
    '不传 client_ref 时，同一天、同类别、标题去掉标点空白后相同的事件也不会重复落库。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      happened_at: { type: 'string', description: '事件发生时间，ISO8601 时间串' },
      kind: { type: 'string', enum: [...cases.TIMELINE_KINDS], description: '事件类别' },
      title: { type: 'string', description: '一句话概括发生了什么' },
      detail: { type: 'string', description: '细节补充，可省略' },
      client_ref: {
        type: 'string',
        description: '幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库',
      },
    },
    required: ['case_id', 'happened_at', 'kind', 'title'],
  },
  run: (db, identity, args) =>
    cases.addTimelineEvent(db, {
      caseId: num(args.case_id),
      userId: identity.uid,
      happenedAt: args.happened_at,
      kind: args.kind,
      title: args.title,
      detail: args.detail,
      clientRef: args.client_ref,
    }),
};
