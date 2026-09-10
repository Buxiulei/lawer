// app/src/lib/capabilities/families/timeline.ts
// A 族里的时间线部分（设计稿 §2 A、P4：时间线只追加）。
import * as cases from '@/lib/cases';
import { DOMAINS } from '@/lib/domains/registry';

import { assertedByOf, caseIdProp, idAt, num, sourceTierProp } from '../shared';
import type { Capability } from '../registry';

/**
 * 「这条记录是什么」的对外说明：**按事件类别列出各领域包声明的取值并集**
 *（tools/list 拿不到案件上下文，只能给并集；真正落库前按该案件所属领域的那一份再校验一次，
 * 与 claim / deadline 的 kind 同一条既定分工）。
 *
 * 【为什么是一段说明而不是一个 enum】取值域是**按 kind 分组**的：同一个串在另一类事件下
 * 不合法。摊平成一个 enum 的形态是——说明书说这个值可以传，服务端按 kind 一查就拒，
 * 而调用方照着说明书填齐了仍被拒（同 intakeSchema 的 required/errorCode 两向那条）。
 * 不分型的类别整条不列：列一个"（无）"只会让人以为要传点什么。
 */
const EVENT_TYPE_GUIDE = cases.TIMELINE_KINDS.map((kind) => {
  const specs = [
    ...new Map(
      Object.values(DOMAINS)
        .flatMap((p) => p.timelineEventTypes[kind] ?? [])
        .map((t) => [t.id, t]),
    ).values(),
  ];
  return specs.length === 0 ? null : `${kind}：${specs.map((t) => `${t.id}（${t.label}）`).join('、')}`;
})
  .filter((line): line is string => line !== null)
  .join('；');

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
  // 不走能力壳（幂等在 timeline_events 自己的列上，见上一段），所以台账由门记。
  // deduped 照实记：两道去重（client_ref / 自然键）任一命中时，这次没有新落一行。
  ledger: {
    targetTable: 'timeline_events',
    rowsOf: (_db, args, result) => [
      { caseId: num(args.case_id), targetId: idAt(result, 'event', 'id'), deduped: result.deduped === true },
    ],
  },
  rest: { method: 'POST', path: '/api/v1/cases/{id}/timeline' },
  title: '追加时间线事件',
  // **不挂 facts_token**（设计稿 §4.2-4 明写）：追加一条事件是低危高频动作，且它只加不改。
  // 挂上去的形态是——模型要记一笔就得先读一遍事实卡，于是它干脆不记，
  // 而"不落库"正是这套档案最早的那类事故。
  description:
    '给案件时间线追加一条事件。时间线只追加不修改，记错了就再补一条更正事件。' +
    '写入自带幂等：传相同 client_ref 重放只落一条（返回 deduped:true）；' +
    '不传 client_ref 时，同一天、同类别、标题去掉标点空白后相同的事件也不会重复落库。' +
    '**本条不要求 facts_token**（只追加、不覆盖），随手记即可。',
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
      event_type: {
        type: 'string',
        description:
          '这条记录**是什么**——从下面这份闭合枚举里挑一个 id。**有就填，判定不再猜**：' +
          '要件判定优先读这一格，只有没填时才回去读你写的那段字并按谓词猜它说的是不是那件事，' +
          '而叙事的写法是无穷的，猜就一定有猜错的时候。挑不准就整个不传（记录照样落库）。' +
          `按事件类别分组，传错会拿到 400 INVALID_EVENT_TYPE 并列出该类别的全部允许值——${EVENT_TYPE_GUIDE}。` +
          '（取值域按案件所属领域定，这里列的是各领域的并集。）',
      },
      // 追加型：每条新事件本来就要有一个自己的档位，不传即落最弱档。
      ...sourceTierProp('不传即落最弱档「自述」——时间线只追加，这条新事件从此带着这个档位。'),
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
      sourceTier: args.source_tier,
      eventType: args.event_type,
      // 断言人由身份判，**不收入参**（见 shared.assertedByOf 的长注释）
      assertedBy: assertedByOf(identity),
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
  // 盖章改的是那条事件行的一列，target 就是它。**不填 deduped**：这条能力的回包里
  // 没有"这次是重放"这一格（同一格盖两次结果完全相同，领域层也不区分），
  // 猜一个出来的形态是台账里那一列写着一个没人算过的判断。
  ledger: {
    targetTable: 'timeline_events',
    rowsOf: (_db, args, result) => [
      { caseId: num(args.case_id), targetId: idAt(result, 'event', 'id') },
    ],
  },
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
