// app/src/lib/capabilities/families/case.ts
// A 族：档案与事实（设计稿 §2 A）。
//
// 每条能力都是薄壳：校验入参形状 → 调 lib/cases → 把结果原样 JSON 化。
// 领域校验（枚举、归属）一律在 lib/cases，**不在这里重复实现**——REST 面走的是同一批
// lib 函数，两条入口的行为必须逐字一致，否则 agent 走 MCP 能干的事和用户在网页上能干的
// 事就会悄悄分叉。
import * as cases from '@/lib/cases';
import { issueFactsToken } from '@/lib/cases/facts-token';
import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

import {
  assertedByOf,
  caseIdProp,
  factsTokenProp,
  idAt,
  intakeArgsToInput,
  intakeInputSchema,
  num,
  renderCurrentFacts,
  yuanToFen,
} from '../shared';
import type { Capability } from '../registry';

/** 阶段枚举的对外并集（tools/list 拿不到案件上下文）；落库前按案件领域的词表再校验一次。 */
const ALL_STAGES = [...new Set(Object.values(DOMAINS).flatMap((p) => p.stages))];
/**
 * 各领域包并行轨的并集（同 ALL_STAGES 的口径：tools/list 拿不到案件上下文）。
 * 服务端按**案件所属领域**那一份校验，所以这里宽一点不会让谁写进一条本领域没有的轨。
 */
const ALL_TRACKS = [...new Set(Object.values(DOMAINS).flatMap((p) => p.tracks))];

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
  // **只有改 stage 才要 facts_token**（factsTokenArgs）：改阶段是把案子推到下一个程序节点，
  // 服务端据此落期限、开取证闸、把报告标过期——按几轮之前的印象改错一次，用户要人工回退。
  // 补一句 goal 或岗位名不在此列；整条能力一律挂闸的形态见 registry.factsTokenArgs 注释。
  precondition: ['facts_token'],
  factsTokenArgs: ['stage'],
  // 改的是这一行档案本身。**不填 deduped**：同案覆盖就是覆盖，这条能力没有重放语义。
  // 走 REST 的 PATCH /cases/{id} 由那条路由按自己的路径记（endpoint 不同、行数仍是一行）。
  ledger: {
    targetTable: 'cases',
    rowsOf: (_db, args, result) => [
      { caseId: num(args.case_id), targetId: idAt(result, 'case', 'id') },
    ],
  },
  rest: { method: 'PATCH', path: '/api/v1/cases/{id}' },
  title: '更新案件档案',
  description:
    '更新案件档案：阶段 stage、目标 goal、底线 bottom_line，以及用工基本盘四项——' +
    '入职时间 employed_from（YYYY-MM-DD）、月工资 monthly_wage_yuan（单位元）、岗位 position、' +
    '合同签署次数 contract_count，以及并行轨 track（有并行轨的领域才有，传 null 表示回主线）。' +
    '**至少传一个**，用于零散补齐，不必重走首诊。stage 必须是法定枚举值之一。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      stage: {
        type: 'string',
        enum: ALL_STAGES,
        description: '案件所处阶段。**改它必须同时带 facts_token**（见下），其余字段不必',
      },
      goal: { type: 'string', description: '用户自述的诉求目标' },
      bottom_line: { type: 'string', description: '用户自述的底线' },
      employed_from: { type: 'string', description: '入职时间，YYYY-MM-DD，不能晚于今天；工龄年限的起点' },
      monthly_wage_yuan: { type: 'number', description: '月工资，单位元（会换算成分落库）；所有赔偿金额的基数' },
      position: { type: 'string', description: '岗位' },
      contract_count: { type: 'string', description: '合同签署次数，用户自述原样记录，如「只签过一次」' },
      track: {
        type: ['string', 'null'],
        enum: [...ALL_TRACKS, null],
        description:
          '并行轨：可以与主线同时在走的那条线（不是阶段）。进轨传轨名，处置完传 null 回主线。' +
          '**它不覆盖 stage**——进轨时主线走到哪一步不变。' +
          '不是每个领域都有并行轨；这个案子所属领域没有的话，只能传 null。',
      },
      ...factsTokenProp,
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
      // 【这一行要守的是：`null` 必须原样传下去】传 null 是**出轨、回主线**这个动作，
      // 与"这次不动它"是两件事；下游 updateCase 正是靠 `!== undefined` 分这两件事的。
      // 任何把 null 折成 undefined 的写法（`args.track ?? undefined`、
      // `args.track ? … : undefined` 这类真值判断）都会让"处置完了，回主线"**静默什么都没做**，
      // 而回包 200、字段还是原来那条轨。
      //
      // 【前一版注释在这里写错了一句，更正在此】它说"用 args.track !== undefined 判会把 null
      // 与不传折成同一件事"——不成立：`args.track !== undefined ? args.track : undefined`
      // 与本行在三种入参（键不在、值为 null、值为 undefined）下**逐一同值**，那不是一个变异。
      // P4-W3 照那句话做变异实测，全套 284 条一条没红，才发现描述的是一个不存在的差别。
      // 真正会出事的是上面列的那两种折叠写法，判据在 __tests__/case-update-track.test.ts。
      track: 'track' in args ? args.track : undefined,
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
    '档案里没有的项会明写「未记录」——那是「档案里没有这一项」，不是「不存在」，不要自己脑补一个值。' +
    '每条事实后面的〔〕是它的来源档位（自述 / 书证#n / 对方认可·n / 裁审认定），照卡头的说明读。' +
    '回包里的 facts_token 是**改档案时的通行证**：case_update(stage) / claims_upsert / ' +
    'deadline_set / draft_write 四条要带上它，十分钟内有效。',
  inputSchema: {
    type: 'object',
    properties: { ...caseIdProp },
    required: ['case_id'],
  },
  run: (db, identity, args) => {
    // 归属校验、快照、渲染与预算裁剪全在 renderCurrentFacts（共用层唯一取法）：
    // 站内 agent 每轮看到的事实卡、MCP 这边拿到的、以及 facts_token 核验时比对的那一份，
    // **必须逐字是同一串**——差一个空格就会让每一次核验都判 stale，而两边看起来都正常。
    const facts = renderCurrentFacts(db, num(args.case_id), identity.uid);
    if (!facts.ok) return facts;
    return { case_facts: facts.text, facts_token: issueFactsToken(facts.text) };
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
  // 首诊一次写十几行（档案本身 + 时间线 + 诉求 + 行动卡），台账记的是**这份档案**：
  // 逐行记的形态是一次建档在表里炸出十几行，而它们答的是同一个问题「谁替他建的档」。
  // 各行自己的去重在领域层（自然键），所以这里不填 deduped。
  ledger: {
    targetTable: 'cases',
    rowsOf: (_db, args) => [{ caseId: num(args.case_id), targetId: num(args.case_id) }],
  },
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
      // 断言人由身份判，**不收入参**（见 shared.assertedByOf 的长注释）。首诊一次写十几行，
      // 漏填这一格的形态是：对方 agent 替用户建的整份档案，每一行都标着「用户本人说过」。
      assertedBy: assertedByOf(identity),
    } as Parameters<typeof cases.submitIntake>[1]),
};
