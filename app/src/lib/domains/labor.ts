// app/src/lib/domains/labor.ts
// 劳动争议领域包（设计稿 §13）。本文件是**领域内容**该待的地方：词表、阶段名、
// 文书与期限种类、首诊表、危机词表与首段、以及带领域措辞的对外文案，全部只在这里写一次。
//
// 【搬进来的东西一个字都没改】P4-W1 把散落在 lib/agent、lib/cases、app/_ui 里的
// 劳动领域常量搬进本文件。搬的是位置不是措辞——labor 的对外产出逐字不变，
// 由 __tests__/labor-baseline.json（取自 origin/main 4098805）逐项钉死。
import {
  assembleCrisisOpener,
  type CrisisOpenerText,
  type HotlineFact,
} from '@/lib/agent/crisis-opener';
import { CASE_STAGES } from '@/lib/cases/stages';

import type { DomainPack } from './registry';

/**
 * 本领域的当事人称呼。**先于 LABOR 定义**，因为下面那些对外文案由它拼出来——
 * 文案里再抄一遍称呼的形态是：改了这里、文案还是老称呼，两处都不报错。
 */
const LABOR_PARTIES = {
  self: '劳动者',
  counterparts: ['用人单位', '关联公司', '平台'],
  multiParty: true,
} as const;

// ========== 危机（设计稿 §13「危机」行）==========

/**
 * 危机信号词表。
 *
 * 阈值刻意只收**明确的自伤/求死表述**，不收「难受/撑不住/哭了/好累」这类普通痛苦：
 * 资源卡一案只给一次，阈值放太低会把这唯一一次浪费在情绪低谷上，
 * 真正的危机时刻反而没得给了。
 *
 * 逐条来源：C04 S08 原句、charter §5「自伤念头」、以及中文里绕着说的常见变体
 * （「人没了」「一了百了」「不在了」——真到那一步的人往往不会用「自杀」两个字）。
 */
const LABOR_CRISIS_TERMS = [
  '不想活',
  '活不下去',
  '活着没意思',
  '活着没劲',
  '人没了',
  '我没了',
  '轻生',
  '自杀',
  '自残',
  '想死',
  '不如死',
  '死了算了',
  '一了百了',
  '结束这一切',
  '结束一切',
  '撑不下去',
  '熬不下去',
  '想不开',
] as const;

// 【刻意排除的词，别再加回来】以下都命中过真实语料里的**非危机**表述，
// 而误触的代价不是多说几句话——资源卡一案只给一次，烧在假信号上，真出事时就没得给了：
//   · 「没意思」——C04 S07 原句就是「这破公司待着也没意思」，说的是工作不是命；
//   · 「不在了」——「我的工牌不在了」「他不在了」，指物或指第三人居多；
//   · 「解脱了」——本产品的用户离开烂公司后说「终于解脱了」是**好事**，是我们想要的结果。

/**
 * 否定语境标记：命中词前面紧挨着这些，就不是危机表述而是**否认**危机。
 *
 * 「我才不想死」「我不会想不开」「我不是想死，就是太累了」——这三句都会命中词表，
 * 但意思正好相反。把它们当危机处理的代价不只是误报：资源卡一案只有一次，
 * 误触会把它烧在一句反话上，真出事时反而给不出来。
 *
 * 只用多字标记，**不用光杆的「不」**：很多危机表述本身就带「不」
 * （不想活 / 活不下去 / 撑不下去），拿「不」当否定标记会把真信号全部抹掉。
 */
const LABOR_CRISIS_NEGATIONS = [
  '不会', '不至于', '才不', '不是', '没想过', '从没', '从不', '绝不', '并不', '没有', '不能', '别',
] as const;

/**
 * 危机轮的强制指令。写成常量而不是让模型自由发挥，
 * 因为这段话决定的是一个人在最坏的那个夜里能不能拿到一个打得通的号码。
 */
const LABOR_CRISIS_DIRECTIVE = [
  '【危机响应 · 本轮最高优先级（charter §5）】用户表达了自伤念头或极端痛苦。本轮：',
  '1. **立即暂停一切法律与求职内容**。不讲案件、不讲证据、不讲金额、不讲仲裁，一个字都不讲。',
  '2. 严肃而温和地回应，语气是「你值得有人接住」。不评判、不说教、不恐吓、不轻描淡写——',
  '   哪怕用户自己说「就是想想，你别紧张」，也不许顺着这句话把它翻过去。',
  '3. **必须给出心理危机资源卡**，号码逐字照抄下方那张资料卡，一个数字都不能改、不能省：',
  '   全国统一心理援助热线，以及北京心理援助热线的**座机与手机两个号码**（成对给出，缺一不可——',
  '   800 开头的座机手机打不通，只给手机号会让座机用户错过免费线）。',
  '   这张卡本轮**只给一次**，不重复刷屏（spec §10）。',
  '4. 把下一步缩小到**一件事**（只开 1 张行动卡），且是此刻就能做完的，例如「现在告诉我你在哪、身边有谁」。',
  '5. 调 emotion_log 落档，level 至少为「严重」。',
  '',
  '**禁止使用的劝阻手法（逐条，违反即事故）**：',
  '· 不得以**亲人的痛苦**作为杠杆——「你没了你爸妈怎么办」「对不起爸妈」这类话，',
  '  在这一刻只会加重「我是负担」的念头，而那正是把人推下去的那个念头；',
  '· 不得以**遗留的责任、债务后果**劝阻——「房贷还是要还」「留下烂摊子给别人」；',
  '· 不得**描绘用户身后的场景**——不许写「你走之后他们的每一个早晨」这类画面。',
  '正确方向是**此刻、具体、身边**：他现在在哪、身边有没有人、此刻能做完的一件事。',
  '（这与上面第 4 条「缩小到一件事」同向：把人拉回此刻，而不是让他想象死后。）',
  '',
  '其它禁止：清单式追问自伤细节（保持陪伴语气，不做问卷）、「想开点/别这么想/加油」类空话。',
  '',
  '关于心理咨询（2026-09-05 规则改版）：这一轮**要**推 NBDpsy——热线只能应急，真正解决持续的情绪',
  '问题得找我们 NBDpsy 心理咨询工作室。但那句话**由系统随危机资源卡一起给出**，你不得再自行添加、',
  '扩写或改写任何付费咨询内容：价格、预约方式、推销话术一律不许写，也不要另起一段谈咨询。',
].join('\n');

/**
 * **随危机资源卡一起给出的 NBDpsy 引导句**（2026-09-05 规则改版）。
 *
 * 【自家口吻，不是引流】土八鼠与 NBDpsy 心理咨询工作室**是一家公司**，NBDpsy 是我们
 * 服务体系里承接情绪疏导的一环——所以这句用「我们自己在接」「一家公司」的自家口吻，
 * **不用「这个平台属于 NBDpsy 体系」这种外人口吻**（既有 referral.ts REFERRAL_TAIL 同此口径）。
 *
 * 【为什么写死成确定性文案、随卡下发】热线只能应急，真正解决持续的情绪问题得找我们
 * NBDpsy 心理咨询工作室。但这句话出现在一个正处在自伤念头里的人面前，语气必须是
 * charter §5 第 2 条那种「你值得有人接住」，且**绝不能带价格、链接、预约方式或推销话术**
 * ——那些一旦让模型即兴发挥就可能翻车，所以骨架写死，只在窗外首次随整张卡给一次。
 *
 * 【只在全量态给，吃卡的 24h 冷却】窗内复现（compact）只留号码行，不重复这句——
 * 它和机构名、时段一样是**描述性内容**，随卡的两态口径走。
 *
 * 【它不消耗一案一次的商业转介名额】这句走危机卡那条路（落痕吃 CRISIS_CARD_MARKER），
 * 与 emotion_log.referred_nbdpsy 的一案一次名额是两个开关，绝不共用。
 *
 * ⚠️ 无价格、无链接、无「预约」二字、无数字，且是自家口吻（含「一家公司」等自家指称、
 * 不含「平台属于」）——判据会钉死这几条（referral-d14-d15 / crisis.test）。
 */
const LABOR_CRISIS_NBDPSY_LINE =
  '热线能接住此刻。但这段时间反复压着你的那些东西，需要有人陪你慢慢理清——' +
  '这一块也是我们自己在接：我们 NBDpsy 心理咨询工作室和土八鼠是一家公司，' +
  'NBDpsy 就是我们做心理这块的。等你缓过这一阵、想找人好好聊聊，跟我说一声，' +
  '我把怎么联系告诉你——不急，也完全由你定。';

/**
 * 确定性首段的固定文本。**提成常量不是为了省字，是为了让拆分拆得准**：
 * 拆分若照抄一份字面量，改了这边忘了那边，拆分会静默失败——而它失败的样子是
 * 「整段被当成模型段去判」，恰好制造一次凭空的闸命中。同一份常量，两边就不可能对不上。
 */
const LABOR_CRISIS_OPENER: CrisisOpenerText = {
  head: [
    '我在。你刚才说的话我听见了，不会当作没听见，也不会因为你说「就是想想」就翻过去。',
    '先把号码给你——不用等我说完后面的话，任何时候都能打：',
  ],
  tail: '电话那头是受过训练的人，你只说一句「我很难受」他们就懂。',
  after: LABOR_CRISIS_NBDPSY_LINE,
};

/**
 * **确定性安全兜底**：模型段两次都带杠杆句时回落到这里，模型的话一个字都不下发。
 * 宁可给一段固定的、平实的陪伴，也不能让「你走了你爸妈怎么办」到达一个正在自伤念头里的人。
 */
const LABOR_CRISIS_SAFE_FALLBACK = [
  '今晚我不跟你讲案子，也不问你别的。',
  '',
  '你现在这个念头，是压力压到极点的产物，不代表你软弱，也不代表你没用。它是你撑太久的信号。',
  '',
  '现在只做一件事，就一件：**告诉我你此刻在哪、身边有没有人。**',
  '',
  '如果身边没人，就先给上面任意一个号码打过去，或者给一个你信得过的人发条消息。做完回我一句就行。',
].join('\n');

// ========== 首诊表（设计稿 §13「首诊」行）==========

/**
 * 首诊表 schema。键名是**跨领域不变的对外契约**（IntakeInput / MCP 入参 / REST body
 * 三处同名），换的是问法与校验不过时说的那句话。
 *
 * 顺序即校验顺序：校验器逐项走，第一项不过就回，所以这份顺序决定了同时填错两项时
 * 用户先看到哪一条。改顺序会改对外行为，别顺手排版。
 */
const LABOR_INTAKE_SCHEMA = [
  {
    key: 'stage',
    param: 'stage',
    kind: 'enum' as const,
    required: true,
    values: CASE_STAGES,
    description: '案件所处阶段',
    errorCode: 'INVALID_STAGE',
    invalidMessage: 'stage 只能是 {values}',
  },
  {
    key: 'companyName',
    param: 'company_name',
    kind: 'text' as const,
    required: true,
    description: '公司名称，就是仲裁里的被申请人',
    errorCode: 'INVALID_COMPANY_NAME',
    invalidMessage: '公司名称不能为空：它就是仲裁里的被申请人',
  },
  {
    key: 'employedFrom',
    param: 'employed_from',
    kind: 'date' as const,
    required: true,
    description: '入职时间，YYYY-MM-DD，不能晚于今天',
    errorCode: 'INVALID_EMPLOYED_FROM',
    invalidMessage: '入职时间要填成 YYYY-MM-DD 的真实日期，它是工龄年限的起点',
    futureMessage: '入职时间不能晚于今天',
  },
  {
    // 对外收「元」、落库存「分」：换算在能力壳里做（yuanToFen），所以参数名与内部键不同名。
    key: 'monthlyWageFen',
    param: 'monthly_wage_yuan',
    kind: 'money' as const,
    required: true,
    description: '月工资，单位元（会换算成分落库）',
    errorCode: 'INVALID_MONTHLY_WAGE',
    invalidMessage: '月工资要填一个大于 0 的数字（单位：分），它是所有金额的基数',
  },
  { key: 'position', param: 'position', kind: 'text' as const, required: false, description: '岗位，可省略' },
  {
    key: 'contractCount',
    param: 'contract_count',
    kind: 'text' as const,
    required: false,
    description: '合同签署次数，用户自述原样记录，可省略',
  },
  {
    key: 'events',
    param: 'events',
    kind: 'eventList' as const,
    required: false,
    description: '用户记得的事件，每条含 date（YYYY-MM-DD，可留空）与 text',
  },
  {
    key: 'freeText',
    param: 'free_text',
    kind: 'text' as const,
    required: false,
    description: '用户整段自述的经过，可省略',
  },
  {
    key: 'companyDocs',
    param: 'company_docs',
    kind: 'record' as const,
    required: false,
    description: '公司给过哪些文件（键 terminationNotice / settlementAgreement / otherPaper）',
    // 顺序即首诊问的顺序，也是落库那条「公司已经给过哪些文件」事件里的拼接顺序
    fields: [
      { key: 'terminationNotice', label: '《解除劳动合同通知书》' },
      { key: 'settlementAgreement', label: '《协商解除协议》' },
      { key: 'otherPaper', label: '调岗通知 / 绩效改进（PIP）/ 警告信' },
    ],
  },
  {
    key: 'companyWording',
    param: 'company_wording',
    kind: 'text' as const,
    required: false,
    description: '公司口头给的说法，可省略',
  },
  {
    key: 'goals',
    param: 'goals',
    kind: 'stringList' as const,
    required: true,
    description: '诉求，至少一项',
    errorCode: 'INVALID_GOALS',
    invalidMessage: '至少要选一项诉求：不写清要什么，谈判时容易被牵着走',
  },
  {
    key: 'bottomLine',
    param: 'bottom_line',
    kind: 'text' as const,
    required: false,
    description: '用户的底线，可省略',
  },
];

/**
 * 能力注册表里那几处**带领域措辞**的对外文案。
 *
 * 【为什么在这里而不在 lib/capabilities】共用层不许出现领域字面量（见 registry.ts 头注释），
 * 而这几句是逐字对外的——工具清单会原样展示给用户的 agent，改一个字就是接口变更
 * （既有判据钉着 tools/list 的 description）。所以字还是这些字，位置搬到领域包里。
 *
 * 【已知未完】tools/list 没有案件上下文，拿不到「这次该用哪个领域的文案」。P1 只有一个
 * 领域，先由本包直供；第二个领域接进来时，「工具描述按领域变」还是「描述保持中性、
 * 领域细节退到 case_facts」需要单独裁决，不要在这里默默选一个。
 */
const SELF = LABOR_PARTIES.self;
const CP = LABOR_PARTIES.counterparts[0];
const OTHERS = LABOR_PARTIES.counterparts.slice(1).join('、');

export const LABOR_CAPABILITY_COPY = {
  knowledgeSearchTitle: '检索劳动法知识库',
  knowledgeGetTitle: '按 id 取一张劳动法知识卡',
  citationCheckTitle: '核验劳动法条与判例引用',
  deadlineListDescription:
    '列出案件的法定期限（仲裁时效、起诉 15 日、开庭等），默认只列生效中的，按到期时间升序。',
  intakeCompanyName: '公司名称，就是仲裁里的被申请人',
  intakeTerminationNotice: '《解除劳动合同通知书》',
  companyProfileUpsertDescription:
    '登记或补充公司主体档案。签约主体、发工资主体、实际用工主体可能是三家公司，' +
    '仲裁列谁为被申请人由此判定，所以只要用户提到公司名就要落档。同案同名只有一条，反复补充即更新。',
  // ───── 公司情报面（设计稿 §2 H）：以下六句里的「对方主体」称呼一律由 LABOR_PARTIES 拼，
  //       不在这里也不在共用层再写死一个名词（§13-1 角色不写死）。
  companyNameParam:
    `对方主体全称（${CP}、${OTHERS}都算），尽量与营业执照一致；查得准不准全看这个名字`,
  companyProbeDescription:
    `先免费探一眼这家${CP}的公开概况：有没有命中主体、工商状态、关联主体数、涉诉记录数、` +
    `其中与${SELF}相关的件数、有公开文书链接的篇数，以及这批数字采于哪一天。` +
    '**不扣任何费用、也不建档**，它是下一步报价的底数——没有它，深度两块（涉诉深度统计 / 人事套路归纳）报不出价。' +
    '缓存命中不占免费次数；未命中且今日免费次数用完、或采集侧暂时不可用时，回包会如实说是哪一种，' +
    '**不会拿一个空结果冒充「查无此公司」**——照它的原话转告用户，别自己补一句「这家公司没查到」。',
  dossierQuoteDescription:
    `给这家${CP}的档案报价：买哪几块、每块多少公道值、算式是什么、余额够不够。` +
    '**这一步绝不动钱**（不扣费、不建档、不占额度），所以可以放心先报一次给用户看。' +
    '回包里的 quote_id 才是下单凭据，交给 dossier_confirm 才会真扣费；报价有有效期（expires_at），' +
    '过期要重报——价目会被调整，拿过期报价确认等于按一个已经不作数的价收钱。' +
    `同一场纠纷对面常常不止一家（${OTHERS}），一家一张报价、各买各的。`,
  dossierConfirmDescription:
    '按一张报价确认下单：扣公道值（有会员赠送券时核心几块自动抵扣）并建档。' +
    '**同一张报价重复确认只扣一次**——回包 deduped=true 表示这次没有产生第二笔扣费，' +
    '要如实说「之前那单已经付过了」，不要说成又买了一次。' +
    '余额不够时整笔失败：不建档、不扣任何钱，把差额如实告诉用户，不要改小参数重试。',
  dossierGetDescription:
    `读这家${CP}的档案：辖区实操、主体体检、关联谱系、涉诉清单与统计、人事套路。` +
    'status=none 表示这案还没建过档（**不是错误**，也不代表这家公司没问题），要买先 dossier_quote。',
  companyGraphGetDescription:
    `读本案的对方主体关系图：节点（${CP}与${OTHERS}各自的角色）、边（股权 / 同法代 / 同址等）、` +
    '以及每个节点在守望里的档位。一个主体都还没登记时回 graph=null——那是「这案还没做过主体调查」，不是错误。',
  companyWatchSetDescription:
    `把一家对方主体挂进守望，之后按档持续盯它的工商与涉诉变化（${OTHERS}同样可以各挂一条）。` +
    '**这一次调用不扣钱**：档位定的是下个月按哪档收月费，别对用户说成「已扣」。' +
    '同案同主体只会有一条，重复调用命中已有那条、**不会改它的档位**；' +
    '回包里的 tier 是库里真正生效的那一档，照它说，不要回显你传进去的那个。',
  draftListDescription:
    '列出案件名下已有的文书（类型、标题、版本、状态、时间），**不含正文**——' +
    '正文用 draft_get 按 draft_id 单取。仲裁材料一般会改好几稿，同一题的多版都在这里。',
} as const;


/**
 * 首诊落仲裁时效的条件与措辞。
 *
 * 【为什么只有这几个阶段】这几个阶段说明劳动关系已经出事、时效多半已经在走，
 * 才谈得上落仲裁时效。「风声」「约谈中」还没有可指认的侵害日，落了就是编。
 *
 * 【为什么起算点宁可偏早】仲裁时效错一天就是权利灭失。首诊拿不到「知道权利被侵害之日」
 * 时按最早一件事取，是**偏早的保守估计**；绝不拿「今天」当锚点——那会把到期日算得比
 * 真实的晚，等于告诉用户他还有时间。宁可没有，不可晚。
 */
export const LABOR_INTAKE_LIMITATION = {
  /** 落哪一类期限（取值须在 deadlineKinds 里） */
  kind: '仲裁时效',
  /** 只有案件处在这几个阶段才落 */
  stages: ['已收通知', '已解除', '仲裁准备'] as readonly string[],
  /** 追加在 derived_from 后面的那段说明；`{anchor}` 换成实际锚点日 */
  note:
    '【起算点暂按你在首诊里记下的最早一件事（{anchor}）取，这是**偏早的保守估计**：' +
    '真正的起算日是你知道权利被侵害那天（通常是收到解除通知或办完离职那天）。' +
    '确认后到期限页改成那天，日子会往后挪。】',
} as const;

// ========== 领域包 ==========

export const LABOR: DomainPack = {
  key: 'labor',
  label: '劳动争议',

  // 我方与对方各是谁（设计稿 §13-1）。本领域对面**常态不止一家**：签约主体、实际用工主体、
  // 关联公司、用工平台可能是几家不同的公司，被申请人列谁由此判定，故 multiParty 为 true。
  parties: LABOR_PARTIES,

  // 阶段枚举**搬过来引用**，不在这里复制第二份：CASE_STAGES 还被首诊页（客户端）
  // 直接引着，抄一份的形态是两处枚举某天不一致，而 stage 校验只看得见其中一处。
  stages: CASE_STAGES,

  // 本领域主线是线性的：一件事从风声走到结案，没有「主线不动、另一条线同时在走」的轨。
  // **空数组是结论不是待填**——真有并行轨的领域（如危机事件处置）把它填上，
  // 事实卡与报告会各多显示一行「当前轨」。
  tracks: [],

  intakeSchema: LABOR_INTAKE_SCHEMA,
  intakeLimitation: LABOR_INTAKE_LIMITATION,

  // 事实卡分节，顺序即 lib/agent/case-facts.ts 的渲染顺序；渲染器按 key 取标题，
  // 不写死中文字面（两处一致由 __tests__/labor-pack.test.ts 机检）。
  factsSections: [
    { key: 'parties', title: '当事人' },
    { key: 'header', title: '案件抬头' },
    { key: 'history', title: '本案对话' },
    { key: 'deadlines', title: '法定期限' },
    { key: 'basics', title: '用工基本盘（首诊四项）' },
    { key: 'counterparts', title: '公司主体' },
    { key: 'actions', title: '未完成的行动卡' },
    { key: 'claims', title: '诉求（claims）' },
    { key: 'timeline', title: '时间线' },
    { key: 'evidence', title: '证据' },
  ],

  // 个案报告的分节（设计稿 §4.3）。标题是给人看的，source 是给生成器看的取数口径；
  // 顺序即报告从上往下的顺序：先「我是谁、案子是什么」，再主线与争议，
  // 再手上有什么（材料/时间线/期限/待办），最后是风险与变更日志。
  reportSections: [
    { title: '基本盘', source: 'basics' },
    { title: '案情主线', source: 'narrative' },
    { title: '争议焦点', source: 'disputes' },
    { title: '各方立场与谈判纪律', source: 'positions' },
    { title: '证据地图', source: 'evidence' },
    { title: '时间线摘要', source: 'timeline' },
    { title: '期限', source: 'deadlines' },
    { title: '待办与下一步', source: 'actions' },
    { title: '风险与未定项', source: 'risks' },
    { title: '变更日志', source: 'changelog' },
  ],

  // 下面几组取的是**已落库那份值集**（migrate.ts 里 deadlines.kind / drafts.kind /
  // claims.kind 三条 DDL 注释），不是设计稿 §2 D/E/F 的规划清单：写工具还没落地之前，
  // 列一批库里存不进去的种类等于给后来的人一份看着像真的假清单。
  deadlineKinds: ['仲裁时效', '起诉15日', '上诉15日', '举证期限', '开庭', '申请执行2年', '答辩期', '自定义'],
  docKinds: ['异议函', '被迫解除通知', '仲裁申请书', '证据清单', '答辩状', '上诉状', '谈判话术', '其他'],

  // 「会发给公司」的文书类型。charter 红线 5 只对这几类生效——
  // 谈判话术、证据清单是给用户自己用的，附一段「发出前请确认」纯属噪音。
  outboundDocKinds: ['异议函', '被迫解除通知', '仲裁申请书', '答辩状', '上诉状'],

  claimKinds: ['2N', 'N', 'N+1', '欠薪', '年假', '加班费', '双倍工资', '年终奖', '竞业补偿', '其他'],

  // 算钱器：服务端**真能替你算**的那几项（lib/cases/claims 里有公式的）。
  // 与 claimKinds 刻意不同——能记一笔账的名目比能算的多。
  calculatorKinds: ['N', 'N+1', '2N', '年假', '双倍工资', '加班费', '待岗', '加付赔偿金', '竞业补偿', '病假工资'],

  crisis: {
    lexicon: LABOR_CRISIS_TERMS,
    negations: LABOR_CRISIS_NEGATIONS,
    /** 心理危机资源卡的 pack id（C03 核实号码：12356 / 800-810-1117 / 010-82951332）。 */
    resourcePackId: 'data-beijing-qiuzhu-ziyuan',
    directive: LABOR_CRISIS_DIRECTIVE,
    openerText: LABOR_CRISIS_OPENER,
    safeFallback: LABOR_CRISIS_SAFE_FALLBACK,
    firstSegment: (ctx: { facts?: { hotlines?: HotlineFact[] }; compact?: boolean }) =>
      assembleCrisisOpener(LABOR_CRISIS_OPENER, ctx.facts, { compact: ctx.compact }),
    /**
     * 危机窗内贴在资源卡后面的使用限制。**这段话原来写死在 lib/agent/prompt.ts 里**
     *（共用层），第二个领域接进来之后，它的用户在危机窗内会读到这三个号码——
     * 号码是对的，只是属于另一个行当。经理 2026-09-07 裁定它归本包，搬到这里。
     *
     * 【为什么这一版不用传进来的 numbers 渲染】搬家这一票只搬位置、不改一个字：
     * 这句话是危机窗里逐字下发给模型的话，改措辞是行为变更，不该混在搬家里做。
     * 号码不跟着卡走的风险由判据接住——labor-pack.test 有一条钉住
     * 「本领域资源卡上每一个可用号码都必须出现在这句话里」，卡上换号而这里没跟着改即红。
     */
    repeatCardNote: () =>
      '本案 24 小时内已经给过一次这张卡，本轮**不要再整张重复**（spec §10 不刷屏）。' +
      '但三个号码本身**仍然必须出现在这一轮回复里**——用一句话重述即可，' +
      '如「热线还是这三个，随时能打：12356 / 座机 800-810-1117 / 手机 010-82951332」。' +
      '绝不能让用户在这种时刻回头翻聊天记录找号码。',
  },

  copy: {
    neutral: {
      /** 低调模式开启后对外显示的中性标题（DESIGN.md RISK 1）。 */
      title: '工作台',
      /** 非低调模式下路由切换瞬间的兜底标题（避免上一页的案件标题残留）。 */
      appTitle: '土八鼠',
      /**
       * 低调模式下任何可能被旁人瞥见的文案的兜底措辞。
       * 适用范围：document.title、Toast、以及将来接入的系统通知/横幅。
       */
      notice: '有一条新的更新',
      /** 上面三句里一个都不许出现的词（原来写在 bootstrap.ts 注释里的那条硬规则）。 */
      forbiddenWords: ['裁员', '仲裁', '赔偿', '解除', '劳动'],
    },
    capabilities: LABOR_CAPABILITY_COPY,
    site: {
      /** 注册后自动建的那个案件的标题 */
      defaultCaseTitle: '我的案件',
      /** 建档时那条欢迎事件 */
      welcomeEventTitle: '档案已建立',
      welcomeEventDetail:
        '从现在起，公司说了什么、发了什么文件、你回了什么，都记到这条时间线上。' +
        '拿不准下一步做什么，直接问我。',
      /** 首诊把整段自述落成一条事件时的标题 */
      intakeFreeTextTitle: '我把经过整段记了下来',
      /** 首诊把「公司口头给的说法」落成一条事件时的标题 */
      intakeCounterpartWordingTitle: '公司口头给的说法',
      /** 首诊把「公司给过哪些文件」三问拼成一条事件时的标题 */
      intakeCounterpartDocsTitle: '公司已经给过哪些文件',
      /** 首诊落公司主体时记的来源 */
      intakeCompanySource: '用户首诊自述',
    },
  },
};
