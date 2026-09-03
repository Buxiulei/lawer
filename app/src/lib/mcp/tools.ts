// app/src/lib/mcp/tools.ts
// MCP 工具注册表：一处定义，/api/mcp（tools/list、tools/call）与 /api/manifest 共用。
//
// 每个工具都是薄壳：校验入参形状 → 调 lib/cases → 把结果原样 JSON 化。
// 领域校验（枚举、归属）一律在 lib/cases，**不在这里重复实现**——REST 面走的是同一批
// lib 函数，两条入口的行为必须逐字一致，否则 agent 走 MCP 能干的事和用户在网页上能干的
// 事就会悄悄分叉。
//
// inputSchema 手写 JSON Schema 字面量：工具只有九个、参数都很浅，
// 引 zod + zod-to-json-schema 换来的是两个依赖和一层转换，不划算。
import type { Database } from 'better-sqlite3';

import * as agent from '@/lib/agent';
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

/**
 * knowledge_search 返回的正文摘要上限。
 *
 * 【为什么摘不是全文】站内 agent 那条通路给的是**逐字全文**（retrieval.ts 讲了为什么：
 * 转述过的法条与编造的法条在用户眼里没有区别）。这里不同：MCP 一次 tools/call 的返回
 * 要整段进对方模型的上下文，而 534 号那张卡单卡就一万两千字，六张卡能把对方一轮的
 * 上下文占满。所以这里给摘要 + citation_guide——**要逐字引用的那几句在 citation_guide 里
 * 是全的**（它拼的是 facts.statute_quotes 的原文），摘要只是让对方知道这张卡讲什么。
 */
const KNOWLEDGE_EXCERPT_MAX = 1200;

/** case_id 在每个工具里都是必填整数，抽出来免得七份重复 */
const caseIdProp = {
  case_id: { type: 'integer', description: '案件 id' },
} as const;

/** 知识卡类型枚举，与 lib/agent 的 AGENT_TOOLS.knowledge_search 同一份取值 */
const KNOWLEDGE_TYPES = [
  '法条卡',
  '判例卡',
  '计算规则',
  '流程SOP',
  '文书模板',
  '话术卡',
  '情绪指南',
  '数据卡',
] as const;

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
  // ──────── 以下两个是后加的。**追加在末尾、不插在中间**：客户端会把工具清单原样
  //          展示给用户，顺序变了等于面板重排；判据 C11 钉着这个顺序。 ────────
  {
    name: 'case_facts',
    title: '读案件事实卡',
    description:
      '一次拿全这个案子的当前事实：当事人、案件抬头、法定期限、用工基本盘（入职时间/月薪/岗位）、' +
      '公司主体、行动卡、诉求金额、时间线、证据清单。**回答任何与案情有关的问题之前先调它**。' +
      '档案里没有的项会明写「未记录」——那是「档案里没有这一项」，不是「不存在」，不要自己脑补一个值。',
    scope: 'case:read',
    inputSchema: {
      type: 'object',
      properties: { ...caseIdProp },
      required: ['case_id'],
    },
    run: (db, identity, args) => {
      const caseId = num(args.case_id);
      // 【归属校验必须走 lib/cases】直接 loadCaseSnapshot 是能跑通的——它只按 caseId 取数，
      // 不认识 user_id。那样这个工具会把**别人的**事实卡整张交出去，而且返回 200、
      // 格式完全正常。这里借 getCase 的门（同一批领域校验，不在本文件重写一遍）。
      const owned = cases.getCase(db, { caseId, userId: identity.uid, timelineLimit: 1 });
      if (!owned.ok) return owned;
      const snapshot = agent.loadCaseSnapshot(db, caseId);
      // 渲染与预算裁剪一律复用 lib/agent/case-facts：站内 agent 每轮看到的事实卡
      // 与 MCP 这边拿到的必须逐字是同一份，否则同一个案子会有两套"当前事实"。
      return { case_facts: agent.renderCaseFacts(agent.buildCaseFacts(snapshot)) };
    },
  },
  {
    name: 'knowledge_search',
    title: '检索劳动法知识库',
    description:
      '按自然语言检索法条卡/判例卡/计算规则/流程SOP/文书模板/话术卡/情绪指南/数据卡。' +
      '任何涉法断言、任何数字、任何文书起草之前都先调它——你记忆里的条号和数字一律不可用。' +
      '每张卡带 citation_guide（可直接照抄的引用块）与 confidence；confidence 是「待核实」的' +
      '必须如实转达给用户。检索不到就说查不到，不要编条号和案号。',
    // 沿用现有 case:read / case:write 两档权限模型，不为这一个工具新开一个维度：
    // 知识库是公共资料，能读自己案子的 key 读它不多拿到任何东西。
    scope: 'case:read',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索词，用案情关键词而非整句话，如「客观情况重大变化 北京口径」',
        },
        type: {
          type: 'string',
          enum: [...KNOWLEDGE_TYPES],
          description: '只要某一类卡时传，一般不传',
        },
        limit: {
          type: 'integer',
          description: `最多几张，默认与上限都是 ${agent.MAX_INJECTED_PACKS}`,
        },
      },
      required: ['query'],
    },
    run: (_db, _identity, args) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      // 先拦空 query 再进检索器：lib/knowledge 对空 query 的约定是抛错
      //（它的「宁可炸也不静默返回空」），而对 MCP 调用方来说这是一个可以自己改正的
      // 入参错误，该走 isError 让模型看见原因，不该长成一个 500。
      if (!query) {
        return {
          ok: false as const,
          status: 400,
          errorCode: 'INVALID_QUERY',
          message: 'query 不能为空：给一组案情关键词，比如「经济补偿 计算 北京」',
        };
      }
      const limit = Math.min(Number(args.limit) || agent.MAX_INJECTED_PACKS, agent.MAX_INJECTED_PACKS);
      const type = typeof args.type === 'string' ? args.type : undefined;
      const packs = agent.createKnowledgeSearcher().search(query, { limit, type });
      return {
        query,
        packs: packs.map((p) => ({
          id: p.id,
          title: p.title,
          type: p.type,
          region: p.region,
          confidence: p.confidence,
          updated: p.updated,
          // 与站内 agent 那条通路**同一个函数**产出，两边引用格式逐字一致。
          // 手写第二份的形态是：同一条法条在网页里和在用户自己的助手里长得不一样。
          citation_guide: agent.packCitationGuide(p),
          excerpt:
            p.body.length > KNOWLEDGE_EXCERPT_MAX
              ? `${p.body.slice(0, KNOWLEDGE_EXCERPT_MAX)}……（正文已截断；要逐字引用请照抄 citation_guide）`
              : p.body,
        })),
        note:
          '引用时：法条给条号 + 逐字原文，判例给案号 + 来源，数字给值与生效期间；' +
          'confidence 为「待核实」的必须如实带上这个状态。检索不到就说查不到，不要编。',
      };
    },
  },
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
