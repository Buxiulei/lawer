// app/src/lib/capabilities/families/case.ts
// A 族：档案与事实（设计稿 §2 A）。
//
// 每条能力都是薄壳：校验入参形状 → 调 lib/cases → 把结果原样 JSON 化。
// 领域校验（枚举、归属）一律在 lib/cases，**不在这里重复实现**——REST 面走的是同一批
// lib 函数，两条入口的行为必须逐字一致，否则 agent 走 MCP 能干的事和用户在网页上能干的
// 事就会悄悄分叉。
import * as agent from '@/lib/agent';
import * as cases from '@/lib/cases';
import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

import { caseIdProp, intakeArgsToInput, intakeInputSchema, num, yuanToFen } from '../shared';
import type { Capability } from '../registry';

/** 阶段枚举的对外并集（tools/list 拿不到案件上下文）；落库前按案件领域的词表再校验一次。 */
const ALL_STAGES = [...new Set(Object.values(DOMAINS).flatMap((p) => p.stages))];

/**
 * 首诊工具的说明书与入参映射读的那个包。
 *
 * tools/list 拿不到案件上下文，所以两处都按缺省领域来——但它是**同一个常量**：
 * 将来改成按案件取包时，说明书与映射一起改，不会出现「说明书换了领域、映射还停在上一个」。
 */
const INTAKE_PACK = DOMAINS[DEFAULT_DOMAIN];

export const caseGet: Capability = {
  name: 'case_get',
  family: 'case',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}' },
  title: '读取案件档案',
  description:
    '读取一个案件的档案（阶段、目标、底线）以及最近的时间线事件。只能读自己的案件。',
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
};

export const caseUpdate: Capability = {
  name: 'case_update',
  family: 'case',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'PATCH', path: '/api/v1/cases/{id}' },
  title: '更新案件档案',
  description:
    '更新案件档案：阶段 stage、目标 goal、底线 bottom_line，以及用工基本盘四项——' +
    '入职时间 employed_from（YYYY-MM-DD）、月工资 monthly_wage_yuan（单位元）、岗位 position、' +
    '合同签署次数 contract_count。**至少传一个**，用于零散补齐，不必重走首诊。stage 必须是法定枚举值之一。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      stage: { type: 'string', enum: ALL_STAGES, description: '案件所处阶段' },
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
};

export const caseFacts: Capability = {
  name: 'case_facts',
  family: 'case',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/facts' },
  title: '读案件事实卡',
  description:
    '一次拿全这个案子的当前事实：当事人、案件抬头、法定期限、用工基本盘（入职时间/月薪/岗位）、' +
    '公司主体、行动卡、诉求金额、时间线、证据清单。**回答任何与案情有关的问题之前先调它**。' +
    '档案里没有的项会明写「未记录」——那是「档案里没有这一项」，不是「不存在」，不要自己脑补一个值。',
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
};

export const caseList: Capability = {
  name: 'case_list',
  family: 'case',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases' },
  title: '列出我的案件',
  description:
    '列出当前 api key 所属用户自己的全部案件（case_id、抬头 title、阶段 stage、建档时间），新的在前。' +
    '**连上后先调它认领案件**：只有一个案件（绝大多数人）就直接用它的 case_id，不要开口问用户要编号；' +
    '有多个就把抬头列出来让用户挑；一个都没有就请用户去网页端建档（首诊）。无需任何入参。',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  // 归属天然由 userId 兜底：查询条件就是本人 id，列不出别人的案件（lib/cases 讲了为什么无需 assertOwned）
  run: (db, identity) => cases.listCases(db, { userId: identity.uid }),
};

export const intakeSubmit: Capability = {
  name: 'intake_submit',
  family: 'case',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { naturalKey: '时间线事件按同案 + 同日 + 同类别 + 标题规范化去重' },
  rest: { method: 'POST', path: '/api/v1/cases/{id}/intake' },
  title: '首诊建档',
  description:
    '把首诊问下来的内容一次性写进这个案件：阶段、公司名、入职时间、月工资、岗位、合同次数、' +
    '经过（时间线）、诉求、底线。**新用户或用工基本盘还空着时用它一次建档**，问齐了再调，' +
    '不要让用户回网页填。金额传元（monthly_wage_yuan），服务端换算成分。' +
    '校验不过会逐字段回原因（如 INVALID_MONTHLY_WAGE），照着补齐再提交即可。',
  // 入参 schema **由领域包的首诊表生成**（intakeInputSchema）：字段、必填、问法与
  // 服务端校验读的是同一份，不存在「说明书上没有这个参数、服务端却要它」的缝。
  // tools/list 没有案件上下文，这里给的是缺省领域那一份（与其它 enum 同一口径）。
  inputSchema: intakeInputSchema(INTAKE_PACK),
  // 归属校验、枚举校验、落库事务全在 cases.submitIntake（与网页 POST /cases/{id}/intake 同一函数）。
  // 校验失败结构（ok:false + errorCode + message）由路由渲染成 isError。
  //
  // 【param→key 与元→分也由同一份 intakeSchema 派生】intakeArgsToInput 读的是上面那行
  // 生成说明书用的**同一个包**：往首诊表加一个字段，说明书与本壳一起认识它，不会出现
  // 「说明书宣告了、壳把它丢了」的缝。手写第二份对照表的形态见 shared.ts 的头注释。
  //
  // 【归属写在展开之后】assertDomainPack 已经不许首诊表用 caseId / userId 当键，
  // 所以今天这两行放哪儿都一样；写在后面是为了让「归属只认调用者身份」这件事
  // 不依赖另一个文件里的守卫还在不在——展开在前，同名键盖不到归属上。
  run: (db, identity, args) =>
    cases.submitIntake(db, {
      ...intakeArgsToInput(INTAKE_PACK, args),
      caseId: num(args.case_id),
      userId: identity.uid,
    } as Parameters<typeof cases.submitIntake>[1]),
};
