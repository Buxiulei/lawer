// app/src/lib/mcp/tools.ts
// MCP 工具注册表：一处定义，/api/mcp（tools/list、tools/call）与 /api/manifest 共用。
//
// 每个工具都是薄壳：校验入参形状 → 调 lib/cases → 把结果原样 JSON 化。
// 领域校验（枚举、归属）一律在 lib/cases，**不在这里重复实现**——REST 面走的是同一批
// lib 函数，两条入口的行为必须逐字一致，否则 agent 走 MCP 能干的事和用户在网页上能干的
// 事就会悄悄分叉。
//
// inputSchema 手写 JSON Schema 字面量：工具只有七个、参数都很浅，
// 引 zod + zod-to-json-schema 换来的是两个依赖和一层转换，不划算。
import type { Database } from 'better-sqlite3';

import * as cases from '@/lib/cases';
import type { DomainFailure } from '@/lib/cases';
import type { Identity } from '@/lib/auth/identity';
import type { Scope } from '@/lib/auth/api-key';

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 调用本工具需要的权限；api key 没有该 scope 即拒绝 */
  scope: Scope;
  run(db: Database, identity: Identity, args: Record<string, unknown>): unknown | DomainFailure;
}

/** case_id 在每个工具里都是必填整数，抽出来免得七份重复 */
const caseIdProp = {
  case_id: { type: 'integer', description: '案件 id' },
} as const;

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'case_get',
    title: '读取案件档案',
    description:
      '读取一个案件的档案（阶段、目标、底线）以及最近的时间线事件。只能读自己的案件。',
    scope: 'case:read',
    inputSchema: {
      type: 'object',
      properties: {
        ...caseIdProp,
        timeline_limit: {
          type: 'integer',
          description: '带回多少条时间线事件，默认 50，最多 200',
        },
      },
      required: ['case_id'],
    },
    run: (db, identity, args) =>
      cases.getCase(db, {
        caseId: num(args.case_id),
        userId: identity.uid,
        timelineLimit: args.timeline_limit === undefined ? undefined : num(args.timeline_limit),
      }),
  },
  {
    name: 'case_update',
    title: '更新案件档案',
    description:
      '更新案件的阶段 stage、目标 goal 或底线 bottom_line，三者至少传一个。stage 必须是法定枚举值之一。',
    scope: 'case:write',
    inputSchema: {
      type: 'object',
      properties: {
        ...caseIdProp,
        stage: { type: 'string', enum: [...cases.CASE_STAGES], description: '案件所处阶段' },
        goal: { type: 'string', description: '用户自述的诉求目标' },
        bottom_line: { type: 'string', description: '用户自述的底线' },
      },
      required: ['case_id'],
    },
    run: (db, identity, args) =>
      cases.updateCase(db, {
        caseId: num(args.case_id),
        userId: identity.uid,
        stage: args.stage,
        goal: args.goal,
        bottomLine: args.bottom_line,
      }),
  },
  {
    name: 'timeline_add',
    title: '追加时间线事件',
    description:
      '给案件时间线追加一条事件。时间线只追加不修改，记错了就再补一条更正事件。',
    scope: 'case:write',
    inputSchema: {
      type: 'object',
      properties: {
        ...caseIdProp,
        happened_at: { type: 'string', description: '事件发生时间，ISO8601 时间串' },
        kind: { type: 'string', enum: [...cases.TIMELINE_KINDS], description: '事件类别' },
        title: { type: 'string', description: '一句话概括发生了什么' },
        detail: { type: 'string', description: '细节补充，可省略' },
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
      }),
  },
  {
    name: 'action_list',
    title: '列出行动卡',
    description: '列出案件下的行动项，可按状态过滤（待办 / 完成 / 放弃）。',
    scope: 'case:read',
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
  },
  {
    name: 'action_complete',
    title: '完成行动卡',
    description: '把一条行动项标记为完成；也可以传 status 标记为放弃。',
    scope: 'case:write',
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
  },
  {
    name: 'deadline_list',
    title: '列出法定期限',
    description:
      '列出案件的法定期限（仲裁时效、起诉 15 日、开庭等），默认只列生效中的，按到期时间升序。',
    scope: 'case:read',
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
  },
  {
    name: 'evidence_list',
    title: '列出证据',
    description: '列出案件下已登记的证据条目（名称、分类、证明目的、固化状态）。',
    scope: 'case:read',
    inputSchema: {
      type: 'object',
      properties: { ...caseIdProp },
      required: ['case_id'],
    },
    run: (db, identity, args) =>
      cases.listEvidence(db, { caseId: num(args.case_id), userId: identity.uid }),
  },
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
