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

export const timelineList: Capability = {
  name: 'timeline_list',
  family: 'timeline',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/timeline' },
  title: '分页读时间线',
  description:
    '按时间倒序读案件时间线，可按发生时间下界 since 与类别 kind 过滤，limit 默认 50、最多 200。' +
    '返回里带 total（过滤后的真总数）与 next_offset（没有下一页时为 null）——' +
    '**别把一页当成全部**：case_get 只带最近若干条，早期事件（入职、第一次约谈）要靠翻页才拿得到。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      since: { type: 'string', description: '只要这个时刻之后发生的事件，ISO8601 时间串' },
      kind: { type: 'string', enum: [...cases.TIMELINE_KINDS], description: '只要这一类事件' },
      limit: { type: 'integer', description: '本页最多几条，默认 50，最多 200' },
      offset: { type: 'integer', description: '从第几条开始，默认 0；续页用上一页回的 next_offset' },
    },
    required: ['case_id'],
  },
  run: (db, identity, args) =>
    cases.listTimeline(db, {
      caseId: num(args.case_id),
      userId: identity.uid,
      since: args.since,
      kind: args.kind,
      limit: args.limit === undefined ? undefined : num(args.limit),
      offset: args.offset === undefined ? undefined : num(args.offset),
    }),
};

export const timelineMilestone: Capability = {
  name: 'timeline_milestone',
  family: 'timeline',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  // 幂等靠自然键而非 client_ref：盖章是把一行的 milestone 列设成某个值，
  // 同一事件同一里程碑再盖一次结果完全一样（不新增行、不改别的列）。
  idempotency: { naturalKey: '同一 event_id 盖同一 milestone ⇒ 结果不变' },
  rest: { method: 'POST', path: '/api/v1/cases/{id}/timeline/{eventId}/milestone' },
  title: '确认里程碑',
  description:
    '给一条已存在的时间线事件盖上里程碑。**必须先拿到用户的明确确认再调**，' +
    'user_confirmed 传 true 就是在代用户签字：里程碑是只追加、没有撤销语义的事实断言，' +
    '盖错一次就永久留在案件史里。你只负责提议，落笔的是用户。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      event_id: { type: 'integer', description: '要盖章的时间线事件 id（本案内）' },
      milestone: { type: 'string', enum: [...cases.CASE_MILESTONES], description: '达成的里程碑' },
      user_confirmed: {
        type: 'boolean',
        description: '用户已明确确认这一格达成。没问过用户就不要传 true',
      },
    },
    required: ['case_id', 'event_id', 'milestone', 'user_confirmed'],
  },
  run: (db, identity, args) =>
    cases.confirmMilestone(db, {
      caseId: num(args.case_id),
      userId: identity.uid,
      eventId: num(args.event_id),
      milestone: args.milestone,
      userConfirmed: args.user_confirmed,
    }),
};
