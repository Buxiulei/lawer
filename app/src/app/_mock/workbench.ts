/**
 * 对话工作台的演示剧本：用户发新消息时按顺序取一条，MockTransport 照九帧契约吐出来。
 * 接后端后本文件整体废弃，改由 /api/v1/cases/[id]/chat 的真实 SSE 提供。
 *
 * lawRefs 不在九帧契约里（WS2 定稿没有法条帧），mock 期间按 message_id 查表补上，
 * 见 mockLawRefs()。
 */

import type {
  DraftFrame,
  NoticeCode,
  RecordTool,
} from '@/app/(app)/case/[id]/_stream/frames';
import type { ActionItem, LawRef } from './types';

export interface ScriptRecord {
  tool: RecordTool;
  id: string;
  summary: string;
}

export interface ReplyScript {
  id: string;
  /** 流式输出的正文（轻量 markdown：段落 / 列表 / **加粗**） */
  content: string;
  /** 危机场景的确定性首段：meta 后毫秒级整段下发，deterministic=true，不结束等待态 */
  deterministic?: string;
  /** 本轮产出的行动卡，回复完成后加入档案待办 */
  actions: ActionItem[];
  lawRefs: LawRef[];
  /** meta.model；等待卡的中文名由它决定 */
  model: string;
  /** meta.degraded：主力模型不可用时本轮走备用 */
  degraded?: boolean;
  taskClass?: string;
  intakeStage?: string | null;
  /** meta 到首个 delta 之间的思考时长；不填按 DEFAULT_THINK_MS */
  thinkMs?: number;
  /** true = 正文一次性整块下发（危机轮真实形态：非流式，过闸后单个大 delta） */
  blockDelivery?: boolean;
  records?: ScriptRecord[];
  notices?: { code: NoticeCode; message: string }[];
  drafts?: Omit<DraftFrame, 'type'>[];
  /** 演示错误剧本：正文吐到这个比例时改吐 error 帧 */
  failAt?: { ratio: number; code: string; message: string; retryAfter?: number };
}

/** mock 首字延迟，与真链路的「受理后即达 meta」节奏对齐 */
export const DEFAULT_THINK_MS = 800;

export const workbenchReplies: ReplyScript[] = [
  {
    id: 'rs_1',
    model: 'claude-sonnet-5',
    taskClass: 'critical',
    intakeStage: 'done',
    records: [
      {
        tool: 'timeline_add',
        id: 'tl_r1',
        summary: '7 月 15 日收到解除通知（立案材料清单已按此生成）',
      },
    ],
    content: `立案本身不难，材料齐了当场就能收。朝阳区劳动人事争议仲裁委员会在朝阳区人力资源和社会保障局的仲裁接待窗口收件，也可以走北京市网上仲裁服务平台先提交，通过初审再去现场核验原件。

按你现在的档案，要带的东西是这四类：

1. **仲裁申请书**，一式三份（本人一份、仲裁委一份、送达公司一份）。事实与理由部分按时间线写：5 月宣布部门合并、6 月 3 日 HR 首次约谈、7 月 15 日收到解除通知、7 月起停缴社保。
2. **本人身份证复印件**一份，正反面复印在同一页。
3. **公司主体信息**：在国家企业信用信息公示系统查询后打印，要有查询日期。这一步是为了写准被申请人的名称、统一社会信用代码和住所地，写错会被要求补正。
4. **证据清单加证据复印件**各三份，按你已经固化的六件编号，原件开庭时带去质证。

有两件事需要提醒。一是**你月工资 25000 元，没超过北京市上年度职工月平均工资的三倍**，所以赔偿金按实际工资算，不封顶；请求事项里直接写 400000 元，不要写"按法律规定计算"。二是加班费那 96 小时目前只有你自己的说法，考勤记录在公司手里——这类证据依法应当由公司提供，但你手上有导出件会主动得多。

申请书写完先别交，发给我核一遍请求事项和金额，这两处写错后面变更要走额外流程。`,
    lawRefs: [
      {
        cite: '《中华人民共和国劳动争议调解仲裁法》第二十一条',
        conclusion:
          '劳动合同履行地和公司所在地的仲裁委都能管；两边都申请的，由劳动合同履行地管辖——你在朝阳上班，递朝阳。',
        fullText:
          '劳动争议仲裁委员会负责管辖本区域内发生的劳动争议。劳动争议由劳动合同履行地或者用人单位所在地的劳动争议仲裁委员会管辖。双方当事人分别向劳动合同履行地和用人单位所在地的劳动争议仲裁委员会申请仲裁的，由劳动合同履行地的劳动争议仲裁委员会管辖。',
      },
      {
        cite: '《中华人民共和国劳动争议调解仲裁法》第六条',
        conclusion:
          '考勤、工资表这类由公司掌握的证据，公司不提供的要承担不利后果——加班费不会因为你手里没有考勤就没法主张。',
        fullText:
          '发生劳动争议，当事人对自己提出的主张，有责任提供证据。与争议事项有关的证据属于用人单位掌握管理的，用人单位应当提供；用人单位不提供的，应当承担不利后果。',
      },
    ],
    actions: [
      {
        id: 'ai_r1_1',
        caseId: 'demo',
        title: '打印公司主体信息查询页',
        detail:
          '在国家企业信用信息公示系统搜"星曜网络科技（北京）有限公司"，把结果页连同查询日期一起打印。被申请人名称、统一社会信用代码、住所地三项要和打印件完全一致，写错会被要求补正、耽误立案。',
        dueAt: '2026-08-24T23:59:00+08:00',
        priority: 1,
        status: '待办',
        sourceMessageId: null,
        createdAt: '2026-08-19T10:00:00+08:00',
      },
      {
        id: 'ai_r1_2',
        caseId: 'demo',
        title: '把仲裁申请书的请求事项逐条写出金额',
        detail:
          '四项请求分别写死数字：违法解除赔偿金 400000 元、2026 年 7 月工资 25000 元、未休年休假工资 16092.02 元、休息日加班费 27586.21 元。不要写"依法计算"，仲裁庭按你写的金额审。写完发我核一遍。',
        dueAt: '2026-08-26T23:59:00+08:00',
        priority: 1,
        status: '待办',
        sourceMessageId: null,
        createdAt: '2026-08-19T10:00:00+08:00',
      },
    ],
  },
  {
    id: 'rs_2',
    model: 'claude-sonnet-5',
    taskClass: 'critical',
    records: [
      {
        tool: 'claims_upsert',
        id: 'cl_r2',
        summary: '四项诉求合计 468678.23 元（口径未变）',
      },
    ],
    content: `先把结论说在前面：对方在电话里说什么都不算数，只认书面。你可以听、可以录音，但不要在电话里答应任何数字。

如果 HR 再打来，按这三句话应对：

- "解除的理由和补偿方案，请发书面版本到我邮箱，我看完再答复。"
- "我不接受把解除原因写成协商一致或者个人原因。"
- "工资、年假、加班费、社保补缴要分项列明，不接受一揽子写成一个数。"

关于金额，你手里的底牌是这样的：公司现在给的是 **N+1，约 225000 元**；如果解除被认定违法，是 **2N，400000 元**；差额 **175000 元**。加上欠薪、年假、加班费，你档案里初算的四项合计 **468678.23 元**。

谈判时能松动的空间在支付时间和保密条款，不在解除原因的定性——一旦写成协商一致，2N 的主张基础就没了，这一条不换。

另外 7 月工资已经逾期 34 天，这一笔不属于争议金额，属于公司明确欠付。催告函发出去之后如果还是不给，这笔可以单独走支付令，比仲裁快。`,
    lawRefs: [
      {
        cite: '《中华人民共和国劳动合同法》第三十条',
        conclusion:
          '工资必须及时足额付；拖欠的，可以直接向法院申请支付令，不必等仲裁走完。',
        fullText:
          '用人单位应当按照劳动合同约定和国家规定，向劳动者及时足额支付劳动报酬。用人单位拖欠或者未足额支付劳动报酬的，劳动者可以依法向当地人民法院申请支付令，人民法院应当依法发出支付令。',
      },
    ],
    actions: [
      {
        id: 'ai_r2_1',
        caseId: 'demo',
        title: '把谈判三句话存进手机备忘录',
        detail:
          'HR 来电时容易被带节奏。三句话写在备忘录第一条，接电话前扫一眼：只认书面、不认可协商一致的定性、各项分开列明。电话里不给数字、不做承诺、不签任何东西。',
        dueAt: '2026-08-21T23:59:00+08:00',
        priority: 2,
        status: '待办',
        sourceMessageId: null,
        createdAt: '2026-08-19T10:00:00+08:00',
      },
    ],
  },
  {
    id: 'rs_3',
    model: 'deepseek-v4-pro',
    taskClass: 'standard',
    records: [
      {
        tool: 'timeline_add',
        id: 'tl_r3',
        summary: '新增一条公司沟通记录，已排入时间线',
      },
      {
        tool: 'emotion_log',
        id: 'em_r3',
        summary: '本轮状态：着急但条理清楚',
      },
    ],
    content: `收到。我把这条并进档案了，下面是它对现有主张的影响。

**对时间线**：这是一个新的公司动作节点，和 7 月 15 日的解除通知形成前后呼应，写进申请书的事实部分能让"客观情况重大变化"这个说法更站不住。

**对证据**：这类沟通记录的关键是可复现——原始的聊天窗口、邮件、短信都不要删，截屏只是副本。原件还在你手机里这件事，比截屏本身更重要。

**对金额**：暂时不影响四项初算，合计仍是 **468678.23 元**。

接下来这一步做完，材料就齐了。`,
    lawRefs: [],
    actions: [
      {
        id: 'ai_r3_1',
        caseId: 'demo',
        title: '把新的沟通记录补进证据库并固化',
        detail:
          '上传后做时间戳固化，证明目的写清楚"证明公司在某月某日就该事项的表态"。原始聊天记录、邮件不要删除，仲裁时可能被要求当庭打开原始载体核对。',
        dueAt: '2026-08-23T23:59:00+08:00',
        priority: 2,
        status: '待办',
        sourceMessageId: null,
        createdAt: '2026-08-19T10:00:00+08:00',
      },
    ],
  },
];

/**
 * 演示剧本：只能用 ?mock=<id> 点名触发，不进默认轮转。
 * 用途是把等待态、降级、草稿确认、提示、错误这几条线跑给人看。
 */
export const scenarioReplies: ReplyScript[] = [
  {
    // 推理模型长考：首字前 4 分钟，用来验等待卡与 60 秒后的安抚文案
    id: 'rs_long',
    model: 'claude-opus-5',
    taskClass: 'critical',
    thinkMs: 240_000,
    content: `算完了。你这份协议里有两处会吃亏，我按影响从大到小说。

**第一处是解除原因写成"协商一致"**。签下去等于承认双方谈妥了走人，2N 的主张基础当场没了，差额 175000 元拿不回来。这一条不能换任何东西。

**第二处是"双方再无其他争议"这句话**。它把欠薪、年假、加班费、社保补缴一并结清了，而这四项你档案里初算合计 468678.23 元，协议给的是 225000 元。

如果公司催得紧，你可以先回一句"金额和表述我需要核对，三个工作日内答复"，这句话不构成任何承诺。`,
    lawRefs: [],
    records: [
      {
        tool: 'claims_upsert',
        id: 'cl_long',
        summary: '协议金额与初算差额 243678.23 元已记入诉求对比',
      },
    ],
    actions: [
      {
        id: 'ai_long_1',
        caseId: 'demo',
        title: '先回一句"需要核对，三个工作日内答复"',
        detail:
          '书面回一句就够，不解释理由、不给数字。这句话不构成承诺，也不会被解读为拒绝谈判，同时把签字压力挪后三天。',
        dueAt: '2026-08-20T23:59:00+08:00',
        priority: 1,
        status: '待办',
        sourceMessageId: null,
        createdAt: '2026-08-19T10:00:00+08:00',
      },
    ],
  },
  {
    // 主力模型不可用，本轮走备用
    id: 'rs_degraded',
    model: 'qwen3.7-max',
    degraded: true,
    taskClass: 'standard',
    thinkMs: 1200,
    content: `可以录，但录的时候有三件事要注意。

一是你本人在场的对话可以录，不需要对方同意；二是不要用剪辑过的版本，原始文件保留在手机里别删；三是录之前把手机电量和存储留够，谈话中途断掉的录音在质证时容易被质疑完整性。

约谈当天，先问一句"今天这次谈话的结论会不会出书面文件"，把对方的回答录进去——后面公司改口时这句最好用。`,
    lawRefs: [],
    records: [
      {
        tool: 'timeline_add',
        id: 'tl_deg',
        summary: '约谈准备：录音要点已排入时间线',
      },
    ],
    actions: [
      {
        id: 'ai_deg_1',
        caseId: 'demo',
        title: '约谈前把手机录音测试一遍',
        detail:
          '提前录 30 秒回放，确认收音清楚、存储够用。原始文件不要剪辑、不要转存后删除原件，仲裁时可能要求当庭打开原始载体核对。',
        dueAt: '2026-08-22T23:59:00+08:00',
        priority: 2,
        status: '待办',
        sourceMessageId: null,
        createdAt: '2026-08-19T10:00:00+08:00',
      },
    ],
  },
  {
    // 产出草稿：走确认流，UI 不给"直接发出"
    id: 'rs_draft',
    model: 'claude-sonnet-5',
    taskClass: 'critical',
    thinkMs: 1500,
    content: `按你刚才补充的两条，异议函我改到了第 2 版，改动集中在三处：

1. 把"部门合并"明确写成内部组织架构调整，不构成订立合同时所依据的客观情况重大变化。
2. 补了一句公司从未提出变更岗位、地点或薪酬的书面方案，把程序问题坐实。
3. 末尾加了"确认收到不代表认可内容"，防止签收被当成认可。

先看一遍全文，尤其是日期和工号这两处。`,
    lawRefs: [],
    records: [
      {
        tool: 'deadline_set',
        id: 'dl_draft',
        summary: '异议函答复期限：收到之日起 5 个工作日',
      },
    ],
    drafts: [
      {
        id: 'dr_1',
        kind: '异议函',
        title: '《解除劳动合同通知书》异议函',
        version: 2,
        requires_confirmation: true,
      },
    ],
    actions: [],
  },
  {
    // 六种 notice 里挑三种同时出现
    id: 'rs_notice',
    model: 'deepseek-v4-flash',
    taskClass: 'standard',
    thinkMs: 1000,
    content: `年终奖这一块，你们公司规章里写的是"发放日在职方可领取"。这类条款在实践中不是一律有效，要看奖金的性质：如果它对应的是你已经完成的年度工作，走到庭上被认定为劳动报酬的一部分、支持按比例支付的情形不少见。

你手上需要的是两样东西：写着这条规定的员工手册页，以及你往年实际拿到年终奖的银行流水。两样都有，这一项才好主张。`,
    lawRefs: [],
    notices: [
      {
        code: 'KNOWLEDGE_MISS',
        message: '年终奖发放日在职条款：知识库无逐字依据',
      },
      { code: 'ACTION_CARD_CAPPED', message: '本轮行动卡超过 3 条，已截取' },
      { code: 'REFERRAL_ALREADY_USED', message: '本案已提示过一次' },
    ],
    records: [
      {
        tool: 'claims_upsert',
        id: 'cl_notice',
        summary: '新增待补证诉求：年终奖（金额待定）',
      },
    ],
    actions: [
      {
        id: 'ai_notice_1',
        caseId: 'demo',
        title: '翻出员工手册里写年终奖的那一页',
        detail:
          '拍照或截屏，要能看到页码和条款编号。手册是公司单方制定的，庭上会核对版本，最好连同签收记录一起找出来。',
        dueAt: '2026-08-25T23:59:00+08:00',
        priority: 2,
        status: '待办',
        sourceMessageId: null,
        createdAt: '2026-08-19T10:00:00+08:00',
      },
    ],
  },
  {
    // 六个 notice code 一次全出，只为人工核对文案，真实一轮不会这么多
    id: 'rs_notice_all',
    model: 'deepseek-v4-flash',
    taskClass: 'bulk',
    thinkMs: 800,
    content: `这一轮的提示比较多，正文先给结论：竞业限制条款要看公司有没有按月付补偿，没付满三个月你可以书面提出解除。类似情形此前有过支持劳动者的裁判（【案号待核实】），拿到逐字案号后我会补进档案。

下面几条是这一轮处理过程中的说明。`,
    lawRefs: [],
    notices: [
      { code: 'KNOWLEDGE_MISS', message: '竞业补偿标准：无逐字依据' },
      { code: 'KNOWLEDGE_UNAVAILABLE', message: '知识库连接失败' },
      { code: 'ACTION_CARD_CAPPED', message: '行动卡超过 3 条' },
      { code: 'ACTION_CARD_MISSING', message: '本轮无新增行动卡' },
      { code: 'REFERRAL_ALREADY_USED', message: '本案已提示过一次' },
      { code: 'TOOL_INPUT_REJECTED', message: 'claims_upsert 入参校验未通过' },
      { code: 'CITATION_BLOCKED', message: '正文含案号占位' },
      { code: 'EMOTIONAL_LEVERAGE_DETECTED', message: '内部治理信号' },
      { code: 'NBDPSY_PITCH_BLOCKED', message: '内部治理信号' },
    ],
    actions: [],
  },
  {
    // 危机场景：确定性首段毫秒级先到，模型正文再等 90 秒（演示用，真链路 2-4 分钟）。
    // 验的是「即时回应卡出现后等待卡仍在跳秒」，以及 60 秒后的安抚文案照常升级。
    id: 'rs_crisis',
    model: 'claude-opus-5',
    taskClass: 'critical',
    thinkMs: 90_000,
    blockDelivery: true,
    deterministic: `我在，先别急着做决定。你说的这些我都看到了，这件事不是你一个人扛得住才算数。
如果这会儿实在撑不住，北京市心理援助热线 010-82951332 可以打，接线的人会听你说完。
你的材料和时间我都记着，下面的事我们一件一件来。`,
    content: `先说结论：你现在最要紧的两件事都还没到期，时间上是来得及的。

**一是仲裁时效**。从收到解除通知那天起算一年，也就是到明年 7 月 15 日之前都能立案。这一年里你什么时候身体和状态允许了再动手，都不算晚。

**二是这个月的开销**。7 月工资和赔偿金是两笔钱、两条路，工资那笔属于公司明确欠付，可以单独走支付令，比仲裁快很多。如果这个月周转不开，先催这一笔。

材料方面你已经固化了六件证据，缺的只有公司主体信息查询页，这一步在网上就能做完，不用出门。

今天如果只做一件事，就做上面那一件。剩下的等你缓过来再说，我一直在。`,
    lawRefs: [],
    records: [
      {
        tool: 'emotion_log',
        id: 'em_crisis',
        summary: '本轮状态：压力偏高，已给到求助渠道',
      },
    ],
    actions: [
      {
        id: 'ai_crisis_1',
        caseId: 'demo',
        title: '在网上打印公司主体信息查询页',
        detail:
          '国家企业信用信息公示系统搜公司全称，结果页连同查询日期一起打印或存 PDF。全程线上，十分钟能做完。今天做这一件就够。',
        dueAt: '2026-08-27T23:59:00+08:00',
        priority: 2,
        status: '待办',
        sourceMessageId: null,
        createdAt: '2026-08-19T10:00:00+08:00',
      },
    ],
  },
  {
    // 半途断流：验流内错误卡 + 倒计时重试
    id: 'rs_error',
    model: 'claude-sonnet-5',
    taskClass: 'standard',
    thinkMs: 900,
    failAt: {
      ratio: 0.35,
      code: 'UPSTREAM_TIMEOUT',
      message: '这一轮中途断了，刚才那段没说完。',
      retryAfter: 10,
    },
    content: `社保这一项跟赔偿金是两条线，分开走。公司从 7 月起停缴，这段属于欠缴，补缴由社保经办机构追缴，不在仲裁委的受理范围里。

具体做法是先在北京市社会保险网上服务平台打一份个人权益记录，把断缴月份圈出来，然后向参保区的社保经办机构反映。`,
    lawRefs: [],
    actions: [],
  },
];

const ALL_SCRIPTS = [...workbenchReplies, ...scenarioReplies];

export function findScript(id: string): ReplyScript | undefined {
  return ALL_SCRIPTS.find((s) => s.id === id);
}

/** mock 的 message_id 形如 m_<scriptId>_<时间戳>，法条卡按剧本 id 回填。 */
export function mockLawRefs(messageId: string): LawRef[] {
  return ALL_SCRIPTS.find((s) => messageId.startsWith(`m_${s.id}_`))?.lawRefs ?? [];
}
