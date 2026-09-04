// app/src/lib/mcp/tools.ts
// MCP 工具注册表：一处定义，/api/mcp（tools/list、tools/call）与 /api/manifest 共用。
//
// 每个工具都是薄壳：校验入参形状 → 调 lib/cases → 把结果原样 JSON 化。
// 领域校验（枚举、归属）一律在 lib/cases，**不在这里重复实现**——REST 面走的是同一批
// lib 函数，两条入口的行为必须逐字一致，否则 agent 走 MCP 能干的事和用户在网页上能干的
// 事就会悄悄分叉。
//
// inputSchema 手写 JSON Schema 字面量：工具只有十个、参数都很浅，
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

/**
 * 元 → 分。对着人给的是「元」，落库口径全仓是「分」（*_fen）。
 * 非数一律回 NaN，交给领域层的 INVALID_MONTHLY_WAGE 报字段级错，不在这里静默兜底成某个数。
 * 有些客户端把入参一律序列化成字符串，故数字串也认。
 */
function yuanToFen(value: unknown): number {
  const yuan =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(yuan) ? Math.round(yuan * 100) : Number.NaN;
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
      '更新案件档案：阶段 stage、目标 goal、底线 bottom_line，以及用工基本盘四项——' +
      '入职时间 employed_from（YYYY-MM-DD）、月工资 monthly_wage_yuan（单位元）、岗位 position、' +
      '合同签署次数 contract_count。**至少传一个**，用于零散补齐，不必重走首诊。stage 必须是法定枚举值之一。',
    scope: 'case:write',
    inputSchema: {
      type: 'object',
      properties: {
        ...caseIdProp,
        stage: { type: 'string', enum: [...cases.CASE_STAGES], description: '案件所处阶段' },
        goal: { type: 'string', description: '用户自述的诉求目标' },
        bottom_line: { type: 'string', description: '用户自述的底线' },
        employed_from: { type: 'string', description: '入职时间，YYYY-MM-DD，不能晚于今天；工龄年限的起点' },
        monthly_wage_yuan: { type: 'number', description: '月工资，单位元（会换算成分落库）；所有赔偿金额的基数' },
        position: { type: 'string', description: '岗位' },
        contract_count: { type: 'string', description: '合同签署次数，用户自述原样记录，如「只签过一次」' },
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
        employedFrom: args.employed_from,
        monthlyWageFen: args.monthly_wage_yuan === undefined ? undefined : yuanToFen(args.monthly_wage_yuan),
        position: args.position,
        contractCount: args.contract_count,
      }),
  },
  {
    name: 'timeline_add',
    title: '追加时间线事件',
    description:
      '给案件时间线追加一条事件。时间线只追加不修改，记错了就再补一条更正事件。' +
      '写入自带幂等：传相同 client_ref 重放只落一条（返回 deduped:true）；' +
      '不传 client_ref 时，同一天、同类别、标题去掉标点空白后相同的事件也不会重复落库。',
    scope: 'case:write',
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
          description: `最多几张，默认与上限都是 ${agent.MAX_INJECTED_PACKS}；超出这个范围会被夹回 1~${agent.MAX_INJECTED_PACKS}`,
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
      // limit 归一到 [1, MAX]，越界一律夹回来而**不报错**：这是对面模型自己填的数，
      // 负数/0/小数/一万都属于它一眼看不出错在哪的填法，为此回一条 isError 只让它白跑一轮。
      // 【夹不住的后果是实测出来的，不是推理】原来的 `Number(x) || MAX` 下：
      //   limit=-5 → 检索器回 **30 张卡**，每张最长 1200 字摘要，一次调用填满对方一轮上下文；
      //   limit=0  → 落回 MAX 看似无害，但 0 本身该被读成「他填错了」而不是「不限」。
      // 两种都返回 200、格式完全正常，没有任何一处会报错。
      // 只有数字（或数字串，有些客户端把入参一律序列化成字符串）才算「他真的给了个数」；
      // true / {} / 'abc' / 没给，都落回默认满额，而不是 Number(true)=1 这种巧合值。
      const asked =
        typeof args.limit === 'number' || (typeof args.limit === 'string' && args.limit.trim())
          ? Math.floor(Number(args.limit))
          : NaN;
      const limit = Number.isFinite(asked)
        ? Math.min(Math.max(asked, 1), agent.MAX_INJECTED_PACKS)
        : agent.MAX_INJECTED_PACKS;
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
  // ──────── case_list 同样追加在末尾（不插在中间，理由见上）。它不隶属任何案件，
  //          所以像 knowledge_search 一样**不带 case_id**、也不在 CASE_SCOPED 判据里。 ────────
  {
    name: 'case_list',
    title: '列出我的案件',
    description:
      '列出当前 api key 所属用户自己的全部案件（case_id、抬头 title、阶段 stage、建档时间），新的在前。' +
      '**连上后先调它认领案件**：只有一个案件（绝大多数人）就直接用它的 case_id，不要开口问用户要编号；' +
      '有多个就把抬头列出来让用户挑；一个都没有就请用户去网页端建档（首诊）。无需任何入参。',
    scope: 'case:read',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    // 归属天然由 userId 兜底：查询条件就是本人 id，列不出别人的案件（lib/cases 讲了为什么无需 assertOwned）
    run: (db, identity) => cases.listCases(db, { userId: identity.uid }),
  },
  // ──────── intake_submit 同样追加在末尾（不插在中间，理由见 case_facts 上方）。────────
  {
    name: 'intake_submit',
    title: '首诊建档',
    description:
      '把首诊问下来的内容一次性写进这个案件：阶段、公司名、入职时间、月工资、岗位、合同次数、' +
      '经过（时间线）、诉求、底线。**新用户或用工基本盘还空着时用它一次建档**，问齐了再调，' +
      '不要让用户回网页填。金额传元（monthly_wage_yuan），服务端换算成分。' +
      '校验不过会逐字段回原因（如 INVALID_MONTHLY_WAGE），照着补齐再提交即可。',
    scope: 'case:write',
    inputSchema: {
      type: 'object',
      properties: {
        ...caseIdProp,
        stage: { type: 'string', enum: [...cases.CASE_STAGES], description: '案件所处阶段' },
        company_name: { type: 'string', description: '公司名称，就是仲裁里的被申请人' },
        employed_from: { type: 'string', description: '入职时间，YYYY-MM-DD，不能晚于今天' },
        monthly_wage_yuan: { type: 'number', description: '月工资，单位元（会换算成分落库）' },
        position: { type: 'string', description: '岗位，可省略' },
        contract_count: { type: 'string', description: '合同签署次数，用户自述原样记录，可省略' },
        events: {
          type: 'array',
          description: '用户记得的事件，每条含 date（YYYY-MM-DD，可留空）与 text',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'YYYY-MM-DD，记不清就留空' },
              text: { type: 'string', description: '发生了什么' },
            },
            required: ['text'],
          },
        },
        free_text: { type: 'string', description: '用户整段自述的经过，可省略' },
        company_docs: {
          type: 'object',
          description: '公司给过哪些文件（键 terminationNotice / settlementAgreement / otherPaper）',
          properties: {
            terminationNotice: { type: 'string', description: '《解除劳动合同通知书》' },
            settlementAgreement: { type: 'string', description: '《协商解除协议》' },
            otherPaper: { type: 'string', description: '调岗通知 / 绩效改进（PIP）/ 警告信' },
          },
        },
        company_wording: { type: 'string', description: '公司口头给的说法，可省略' },
        goals: {
          type: 'array',
          items: { type: 'string' },
          description: '诉求，至少一项',
        },
        bottom_line: { type: 'string', description: '用户的底线，可省略' },
      },
      required: ['case_id', 'stage', 'company_name', 'employed_from', 'monthly_wage_yuan', 'goals'],
    },
    // 归属校验、枚举校验、落库事务全在 cases.submitIntake（与网页 POST /cases/{id}/intake 同一函数）。
    // 本壳只做元→分换算，其余入参原样透传；校验失败结构（ok:false + errorCode + message）由路由渲染成 isError。
    run: (db, identity, args) =>
      cases.submitIntake(db, {
        caseId: num(args.case_id),
        userId: identity.uid,
        stage: args.stage,
        companyName: args.company_name,
        employedFrom: args.employed_from,
        monthlyWageFen: yuanToFen(args.monthly_wage_yuan),
        position: args.position,
        contractCount: args.contract_count,
        events: args.events,
        freeText: args.free_text,
        companyDocs: (args.company_docs ?? {}) as Record<string, unknown>,
        companyWording: args.company_wording,
        goals: args.goals,
        bottomLine: args.bottom_line,
      }),
  },
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
