// app/src/lib/domains/labor.ts
// 劳动争议领域包（设计稿 §13）。本文件是**领域内容**该待的地方：词表、阶段名、
// 文书与期限种类、以及带领域措辞的对外文案，全部只在这里写一次。
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

export const LABOR: DomainPack = {
  key: 'labor',
  label: '劳动争议',

  // 我方与对方各是谁（设计稿 §14-1）。本领域对面**常态不止一家**：签约主体、实际用工主体、
  // 关联公司、用工平台可能是几家不同的公司，被申请人列谁由此判定，故 multiParty 为 true。
  parties: LABOR_PARTIES,

  // 阶段枚举**搬过来引用**，不在这里复制第二份：CASE_STAGES 还被首诊页（客户端）
  // 直接引着，抄一份的形态是两处枚举某天不一致，而 stage 校验只看得见其中一处。
  stages: CASE_STAGES,

  // 事实卡分节，顺序即 lib/agent/case-facts.ts 的渲染顺序。
  // 渲染器目前仍自带这份标题（P1 不动渲染器），两处一致由
  // __tests__/domain-pack-labor.test.ts 机检——它对着 case-facts.ts 源码逐条比。
  factsSections: [
    '当事人',
    '案件抬头',
    '本案对话',
    '法定期限',
    '用工基本盘（首诊四项）',
    '公司主体',
    '未完成的行动卡',
    '诉求（claims）',
    '时间线',
    '证据',
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

  // 下面三组取的是**已落库那份值集**（migrate.ts 里 deadlines.kind / drafts.kind /
  // claims.kind 三条 DDL 注释），不是设计稿 §2 D/E/F 的规划清单：写工具还没落地之前，
  // 列一批库里存不进去的种类等于给后来的人一份看着像真的假清单。
  deadlineKinds: ['仲裁时效', '起诉15日', '上诉15日', '举证期限', '开庭', '申请执行2年', '答辩期', '自定义'],
  docKinds: ['异议函', '被迫解除通知', '仲裁申请书', '证据清单', '答辩状', '上诉状', '谈判话术', '其他'],
  calculatorKinds: ['2N', 'N', 'N+1', '欠薪', '年假', '加班费', '双倍工资', '年终奖', '竞业补偿', '其他'],
};

/**
 * 能力注册表里那几处**带领域措辞**的对外文案。
 *
 * 【为什么在这里而不在 lib/capabilities】共用层不许出现领域字面量（见 registry.ts 头注释），
 * 而这四句是逐字对外的——工具清单会原样展示给用户的 agent，改一个字就是接口变更
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
  deadlineListDescription:
    '列出案件的法定期限（仲裁时效、起诉 15 日、开庭等），默认只列生效中的，按到期时间升序。',
  intakeCompanyName: '公司名称，就是仲裁里的被申请人',
  intakeTerminationNotice: '《解除劳动合同通知书》',
  companyProfileUpsertDescription:
    '登记或补充公司主体档案。签约主体、发工资主体、实际用工主体可能是三家公司，' +
    '仲裁列谁为被申请人由此判定，所以只要用户提到公司名就要落档。同案同名只有一条，反复补充即更新。',
  // ───── 公司情报面（设计稿 §2 H）：以下六句里的「对方主体」称呼一律由 LABOR_PARTIES 拼，
  //       不在这里也不在共用层再写死一个名词（§14-1 角色不写死）。
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
