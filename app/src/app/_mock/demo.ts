import {
  demoCnDate,
  demoDate,
  demoDay,
  demoDayOfMonth,
  demoMonth,
  demoMonthCn,
  demoMonthOfDay,
  demoMonthRangeCn,
  demoShiftMonths,
  demoShortCnDate,
  demoShortMonthCn,
  demoYearOfDay,
} from './clock';
import type {
  ActionItem,
  CaseRecord,
  Claim,
  CompanyDoc,
  CompanyProfile,
  Deadline,
  Draft,
  EvidenceItem,
  Gongdao,
  Message,
  Thread,
  TimelineEvent,
  User,
} from './types';

/**
 * 演示案件「demo」：互联网公司程序员被裁，公司要求签协商解除协议。
 * 数值口径：月工资 25000 元、司龄 8 年、朝阳区。
 * 北京上年度职工月平均工资按 11761 元、三倍封顶线 35283 元计（上线前按官方公布值核定）。
 *
 * 日期一律走 ./clock 以「今天」为原点现算，不写死年月日，理由见该模块头注。
 */

export const MONTHLY_WAGE_YUAN = 25000;
export const SERVICE_YEARS = 8;
export const BJ_AVG_WAGE_YUAN = 11761;
export const BJ_CAP_YUAN = BJ_AVG_WAGE_YUAN * 3;

/* ── 叙事锚点：全案日期都挂在这几个常量上，改一处整条时间线跟着动 ── */

/** 解除日：今天往前 35 天。它同时是公司发薪日，所以欠薪逾期天数恒为 35。 */
export const DEMO_DISMISSAL_DAY = -35;
/** 解除日所在自然月：欠薪月、社保停缴起始月都用它 */
export const DEMO_DISMISSAL_MONTH = demoMonthOfDay(DEMO_DISMISSAL_DAY);
/** 入职日：解除日往前 8 年 2 个月零 1 天，保证司龄按 8 年整算 */
export const DEMO_HIRE_DAY = demoShiftMonths(DEMO_DISMISSAL_DAY - 1, -(8 * 12 + 2));
/** 最后一份劳动合同期限：入职日起满 9 年的前一天 */
export const DEMO_CONTRACT_END_DAY = demoShiftMonths(DEMO_HIRE_DAY, 9 * 12) - 1;
/** 仲裁时效届满：解除日起一年 */
export const DEMO_ARBITRATION_DEADLINE_DAY = demoShiftMonths(DEMO_DISMISSAL_DAY, 12);
/** 工号里的年份跟着入职年 */
export const DEMO_EMPLOYEE_NO = `SX${demoYearOfDay(DEMO_HIRE_DAY)}****`;

/** 存证编号带解除日，demo.ts 与 authpay.ts 引用的是同一个值 */
export const DEMO_ATTESTATION_NO = `AT-${demoAttestDate(DEMO_DISMISSAL_DAY)}-000381`;

/** 存证编号里的日期段：AT-YYYY-MMDD-NNNNNN */
export function demoAttestDate(dayOffset: number): string {
  const iso = demoDate(dayOffset);
  return `${iso.slice(0, 4)}-${iso.slice(5, 7)}${iso.slice(8, 10)}`;
}

export const demoUser: User = {
  id: 'u_demo',
  nickname: '陈先生',
  phoneMasked: '138****6027',
  email: 'demo@example.com',
  authStatus: '已实名',
  membership: '入门',
  createdAt: demoDay(-76, '09:12'),
};

export const demoCase: CaseRecord = {
  id: 'demo',
  userId: 'u_demo',
  title: '星曜网络 · 解除通知异议',
  stage: '已收通知',
  district: '朝阳',
  goal: '争取 2N 一次性支付，工资、年假、加班费一并结清，社保补缴至离职当月。',
  bottomLine: '低于 2N 不签；不接受"个人原因离职"表述；不签任何放弃全部权利的一揽子条款。',
  status: '进行中',
  createdAt: demoDay(-76, '09:20'),
};

export const demoCompany: CompanyProfile = {
  id: 'cp_demo',
  caseId: 'demo',
  name: '星曜网络科技（北京）有限公司',
  uscc: '91110105MA0**X**7B',
  role: '签约主体',
  regCapital: '5000 万元人民币',
  legalRep: '王某某',
  riskNotes:
    '近一年新增 3 条劳动争议开庭公告，2 条被执行信息已结案。签约主体与实际发薪主体一致，暂未发现关联公司混同用工。',
  sources: [
    { title: '国家企业信用信息公示系统', url: 'https://www.gsxt.gov.cn/' },
    { title: '中国裁判文书网', url: 'https://wenshu.court.gov.cn/' },
  ],
  investigatedAt: demoDay(-34, '11:00'),
};

export const demoTimeline: TimelineEvent[] = [
  {
    id: 'te_1',
    caseId: 'demo',
    happenedAt: demoDay(-99, '14:00'),
    kind: '公司动作',
    title: '部门全员会宣布"组织架构调整"',
    detail:
      '技术二部负责人在全员会上宣布部门合并，提到"会有一部分同学需要重新看机会"，未给出书面文件。',
    evidenceIds: ['ev_3'],
  },
  {
    id: 'te_2',
    caseId: 'demo',
    happenedAt: demoDay(-77, '10:30'),
    kind: '公司动作',
    title: 'HR 首次约谈，口头提出协商解除',
    detail:
      'HR 在会议室提出"N+1 方案，当天签当天走"，要求先签一份《协商解除协议》再谈金额。我方未签署。',
    evidenceIds: ['ev_4'],
  },
  {
    id: 'te_3',
    caseId: 'demo',
    happenedAt: demoDay(-60, '18:05'),
    kind: '我方动作',
    title: '书面回复公司，要求出具书面方案',
    detail:
      '通过工作邮箱回复 HR，要求以书面形式列明解除理由、补偿计算方式与支付时间，抄送本人私人邮箱留存。',
    evidenceIds: ['ev_5'],
  },
  {
    id: 'te_4',
    caseId: 'demo',
    happenedAt: demoDay(DEMO_DISMISSAL_DAY, '09:40'),
    kind: '公司动作',
    title: '收到《解除劳动合同通知书》',
    detail:
      '公司以"客观情况发生重大变化，致使劳动合同无法履行"为由单方解除，通知书载明补偿标准为 N+1，要求 3 日内办理交接。',
    evidenceIds: ['ev_1'],
  },
  {
    id: 'te_5',
    caseId: 'demo',
    happenedAt: demoDay(DEMO_DISMISSAL_DAY + 1, '09:00'),
    kind: '公司动作',
    title: `收回办公权限，${demoShortMonthCn(DEMO_DISMISSAL_MONTH)}工资未发放`,
    detail: `企业微信、代码仓库、VPN 权限于当日上午全部关闭。按公司发薪日 ${demoDayOfMonth(DEMO_DISMISSAL_DAY)} 日，${demoShortMonthCn(DEMO_DISMISSAL_MONTH)}工资至今未到账。`,
    evidenceIds: ['ev_2'],
  },
  {
    id: 'te_6',
    caseId: 'demo',
    happenedAt: demoDay(-14, '00:00'),
    kind: '系统动作',
    title: `社保停缴（${demoShortMonthCn(DEMO_DISMISSAL_MONTH)}起）`,
    detail: `北京人社 App 查询显示 ${demoMonthCn(DEMO_DISMISSAL_MONTH)}起养老、医疗停缴，缴费基数仍按 25000 元。停缴月份需在诉求中一并主张补缴。`,
    evidenceIds: [],
  },
  {
    id: 'te_7',
    caseId: 'demo',
    happenedAt: demoDay(-9, '20:30'),
    kind: '我方动作',
    title: '向公司发出《解除通知异议函》第一版',
    detail:
      '通过 EMS 与工作邮箱双通道发出，明确不认可解除理由、保留主张违法解除赔偿金的权利。EMS 单号已留存。',
    evidenceIds: [],
  },
];

export const demoClaims: Claim[] = [
  {
    id: 'cl_1',
    caseId: 'demo',
    kind: '2N',
    label: '违法解除赔偿金（2N）',
    amountFen: 40_000_000, // 400,000.00 元
    calc: {
      formula: '2 × 工作年限 × 月工资 = 2 × 8 × 25000',
      inputs: {
        月工资: '25000 元',
        工作年限: '8 年',
        北京上年度职工月平均工资: `${BJ_AVG_WAGE_YUAN} 元`,
        三倍封顶线: `${BJ_CAP_YUAN} 元`,
      },
      capNote: `月工资 25000 元未超过北京市上年度职工月平均工资三倍（${BJ_CAP_YUAN} 元），不适用三倍封顶，也不受 12 年年限上限限制。若封顶适用，则按 ${BJ_CAP_YUAN} 元、最多 12 年计。`,
    },
    basis:
      '公司以"客观情况发生重大变化"解除但未举证客观情况、未履行协商变更程序的，构成违法解除，劳动者可主张赔偿金。',
    status: '初算',
  },
  {
    id: 'cl_2',
    caseId: 'demo',
    kind: '欠薪',
    label: `${demoMonthCn(DEMO_DISMISSAL_MONTH)}工资`,
    amountFen: 25_000_00,
    calc: {
      formula: '当月应发工资 = 25000',
      inputs: {
        所属月份: demoMonthCn(DEMO_DISMISSAL_MONTH),
        发薪日: `每月 ${demoDayOfMonth(DEMO_DISMISSAL_DAY)} 日`,
      },
      capNote: '工资债权不适用封顶。',
    },
    basis: '劳动关系存续期间的工资应当足额支付，解除不影响已发生工资的支付义务。',
    status: '已确认',
  },
  {
    id: 'cl_3',
    caseId: 'demo',
    kind: '年假',
    label: '未休年休假折算（7 天）',
    amountFen: 16_092_02,
    calc: {
      formula: '日工资 × 未休天数 × 200% = (25000 ÷ 21.75) × 7 × 2',
      inputs: {
        日工资: '1149.43 元',
        未休天数: '7 天',
        折算倍数: '200%（另 100% 已含在当月工资中）',
      },
      capNote: '年休假折算不适用封顶；跨年度未休部分需核对公司年假制度与实际审批记录。',
    },
    basis: '用人单位应安排年休假，未安排且未经劳动者书面同意放弃的，按日工资 300% 支付未休年休假工资报酬。',
    status: '待补证',
  },
  {
    id: 'cl_4',
    caseId: 'demo',
    kind: '加班费',
    label: '休息日加班费（96 小时）',
    amountFen: 27_586_21,
    calc: {
      formula: '小时工资 × 加班小时 × 200% = (25000 ÷ 21.75 ÷ 8) × 96 × 2',
      inputs: {
        小时工资: '143.68 元',
        加班小时: `96 小时（${demoMonthRangeCn(DEMO_DISMISSAL_MONTH - 4, DEMO_DISMISSAL_MONTH - 1)}周末）`,
        倍数: '200%（休息日且未安排调休）',
      },
      capNote: '加班费不适用封顶；需以考勤或钉钉打卡记录逐日对应，仲裁中由公司承担考勤举证责任。',
    },
    basis: '安排休息日工作又不能安排补休的，应支付不低于工资 200% 的加班费。',
    status: '待补证',
  },
];

export const demoEvidence: EvidenceItem[] = [
  {
    id: 'ev_1',
    caseId: 'demo',
    fileId: 'f_1',
    name: '解除劳动合同通知书（原件扫描）.pdf',
    category: '公司文件',
    provePurpose: '证明公司单方解除的时间、理由与补偿标准。',
    originalMedium: '纸质原件，本人保管',
    status: '已出证',
    sizeBytes: 486_320,
    sha256: '9f2c4a7b1e0d83c5a6f4b2e9d71c085a3f6b9e2d4c7a1058e3b6d9f2c4a7b1e0d',
    attestationNo: DEMO_ATTESTATION_NO,
    createdAt: demoDay(DEMO_DISMISSAL_DAY, '10:20'),
  },
  {
    id: 'ev_2',
    caseId: 'demo',
    fileId: 'f_2',
    name: `工资流水 ${demoMonth(DEMO_DISMISSAL_MONTH - 11)} 至 ${demoMonth(DEMO_DISMISSAL_MONTH - 1)}.pdf`,
    category: '工资',
    provePurpose: '证明离职前 12 个月平均工资为 25000 元，作为各项赔偿计算基数。',
    originalMedium: '银行 App 导出 PDF，含银行电子章',
    status: '已固化',
    sizeBytes: 1_204_887,
    sha256: '3a1f8d2c6b9e04a7f5c2d8b1e6a930f4c7b2e5d8a1f4c7b0e3d6a9f2c5b8e1d4',
    createdAt: demoDay(-32, '21:05'),
  },
  {
    id: 'ev_3',
    caseId: 'demo',
    fileId: 'f_3',
    name: `劳动合同（${demoYearOfDay(DEMO_HIRE_DAY)} 年签署 + 两次续签）.pdf`,
    category: '合同',
    provePurpose: `证明入职时间 ${demoDate(DEMO_HIRE_DAY)}、岗位、约定工资与工作地点。`,
    originalMedium: '纸质原件，本人保管',
    status: '已固化',
    sizeBytes: 2_931_004,
    sha256: 'c7b2e5d8a1f4c7b0e3d6a9f2c5b8e1d43a1f8d2c6b9e04a7f5c2d8b1e6a930f4',
    createdAt: demoDay(-32, '21:11'),
  },
  {
    id: 'ev_4',
    caseId: 'demo',
    fileId: 'f_4',
    name: `HR 约谈录音 ${demoDate(-77)}.m4a`,
    category: '录音',
    provePurpose: '证明公司主动提出解除、承认系裁员而非个人绩效原因。',
    originalMedium: '本人手机录音，原始文件未删除',
    status: '已上传',
    sizeBytes: 18_446_210,
    sha256: 'e3d6a9f2c5b8e1d4c7b2e5d8a1f4c7b03a1f8d2c6b9e04a7f5c2d8b1e6a930f4',
    createdAt: demoDay(-30, '13:40'),
  },
  {
    id: 'ev_5',
    caseId: 'demo',
    fileId: 'f_5',
    name: '钉钉工作群聊天记录（架构调整通知）.png',
    category: '沟通记录',
    provePurpose: '证明公司内部已宣布裁撤部门，与"客观情况重大变化"的表述互相印证。',
    originalMedium: '手机截屏，原始聊天记录仍在',
    status: '已上传',
    sizeBytes: 742_115,
    sha256: 'f5c2d8b1e6a930f4c7b2e5d8a1f4c7b0e3d6a9f2c5b8e1d43a1f8d2c6b9e04a7',
    createdAt: demoDay(-28, '08:55'),
  },
  {
    id: 'ev_6',
    caseId: 'demo',
    fileId: 'f_6',
    name: `钉钉打卡记录 ${demoMonth(DEMO_DISMISSAL_MONTH - 4)} 至 ${demoMonth(DEMO_DISMISSAL_MONTH - 1)}.xlsx`,
    category: '考勤',
    provePurpose: '证明周末加班共 96 小时，且未安排调休。',
    originalMedium: '钉钉后台导出，本人账号可复现',
    status: '已上传',
    sizeBytes: 96_442,
    sha256: 'b9e04a7f5c2d8b1e6a930f4c7b2e5d8a1f4c7b0e3d6a9f2c5b8e1d43a1f8d2c6',
    createdAt: demoDay(-28, '09:02'),
  },
];

export const demoActions: ActionItem[] = [
  {
    id: 'ai_1',
    caseId: 'demo',
    title: '不要签公司给的《协商解除协议》',
    detail:
      '现有版本把解除原因写成"双方协商一致"，一旦签署，违法解除赔偿金（2N）的主张基础即被削弱，且第 6 条包含放弃全部其他请求的表述。可以先签收通知书本身（写明"仅确认收到，不认可内容"），协议本体不签。',
    dueAt: demoDay(1, '23:59'),
    priority: 1,
    status: '待办',
    sourceMessageId: 'm_4',
    createdAt: demoDay(DEMO_DISMISSAL_DAY, '10:35'),
  },
  {
    id: 'ai_2',
    caseId: 'demo',
    title: '导出并固化钉钉打卡记录',
    detail: `加班费主张目前缺客观考勤支撑。趁账号仍可登录，导出 ${demoMonthRangeCn(DEMO_DISMISSAL_MONTH - 4, DEMO_DISMISSAL_MONTH - 1)}打卡明细，上传后做时间戳固化；原始 Excel 请自己另存一份。`,
    dueAt: demoDay(2, '23:59'),
    priority: 1,
    status: '待办',
    sourceMessageId: 'm_4',
    createdAt: demoDay(DEMO_DISMISSAL_DAY, '10:35'),
  },
  {
    id: 'ai_3',
    caseId: 'demo',
    title: '向公司发出书面《催告支付工资函》',
    detail: `${demoShortMonthCn(DEMO_DISMISSAL_MONTH)}工资已逾期 ${-DEMO_DISMISSAL_DAY} 天。书面催告一方面固定欠薪事实，另一方面为后续主张被迫解除或加付赔偿金留下时间节点。模板已生成在「文书」页。`,
    dueAt: demoDay(6, '23:59'),
    priority: 2,
    status: '待办',
    sourceMessageId: 'm_6',
    createdAt: demoDay(-9, '21:00'),
  },
  {
    id: 'ai_4',
    caseId: 'demo',
    title: '打印近 12 个月工资流水并加盖银行章',
    detail:
      'App 导出的 PDF 在部分仲裁庭会被要求补充银行盖章版本。朝阳区各支行可现场打印，带身份证即可。',
    dueAt: demoDay(17, '23:59'),
    priority: 2,
    status: '完成',
    sourceMessageId: 'm_4',
    createdAt: demoDay(DEMO_DISMISSAL_DAY, '10:35'),
  },
  {
    id: 'ai_5',
    caseId: 'demo',
    title: '整理仲裁申请书的事实与理由段落',
    detail: `按时间线把 ${demoShortMonthCn(demoMonthOfDay(-99))}宣布调整、${demoShortMonthCn(demoMonthOfDay(-77))}约谈、${demoShortMonthCn(DEMO_DISMISSAL_MONTH)}解除、${demoShortMonthCn(DEMO_DISMISSAL_MONTH)}起停缴社保四个节点串成一条主线，每个节点对应一份证据编号。草稿已在「文书」页起头。`,
    dueAt: demoDay(27, '23:59'),
    priority: 3,
    status: '待办',
    sourceMessageId: null,
    createdAt: demoDay(-8, '09:00'),
  },
];

export const demoDeadlines: Deadline[] = [
  {
    id: 'dl_1',
    caseId: 'demo',
    kind: '仲裁时效',
    title: '申请劳动仲裁的一年时效届满',
    dueAt: demoDay(DEMO_ARBITRATION_DEADLINE_DAY, '23:59'),
    derivedFrom: `自 ${demoDate(DEMO_DISMISSAL_DAY)} 收到解除通知、劳动关系终止之日起算一年`,
  },
  {
    id: 'dl_2',
    caseId: 'demo',
    kind: '自定义',
    title: '公司要求签署协商解除协议的答复期限',
    dueAt: demoDay(1, '23:59'),
    derivedFrom: 'HR 邮件中给出的"三个工作日内答复"，非法定期限，逾期不产生失权后果',
  },
  {
    id: 'dl_3',
    caseId: 'demo',
    kind: '自定义',
    title: '钉钉账号预计停用，考勤数据将无法导出',
    dueAt: demoDay(2, '23:59'),
    derivedFrom: '公司离职流程通常在解除后 30 日内回收系统账号',
  },
];

export const demoDrafts: Draft[] = [
  {
    id: 'dr_1',
    caseId: 'demo',
    kind: '异议函',
    title: '《解除劳动合同通知书》异议函',
    version: 2,
    status: '待定稿',
    updatedAt: demoDay(-9, '20:10'),
    content: `星曜网络科技（北京）有限公司：

本人陈某，工号 ${DEMO_EMPLOYEE_NO}，自 ${demoCnDate(DEMO_HIRE_DAY)}起与贵司建立劳动关系，最后担任技术二部高级工程师。${demoCnDate(DEMO_DISMISSAL_DAY)}，本人收到贵司出具的《解除劳动合同通知书》，现就该通知提出如下异议：

一、通知书所载"客观情况发生重大变化"缺乏事实依据。
贵司于 ${demoCnDate(-99)}全员会上宣布的部门合并，属于内部组织架构调整，并非订立劳动合同时所依据的客观情况发生重大变化。贵司经营范围、办公地点、本人岗位职责均未发生实质变更。

二、贵司未履行法定的协商变更程序。
即便存在客观情况变化，法律要求用人单位应先与劳动者协商变更劳动合同内容，协商不成方可解除。本人自 ${demoCnDate(-77)}起从未收到任何变更岗位、地点或薪酬的书面方案。

三、贵司尚欠付 ${demoMonthCn(DEMO_DISMISSAL_MONTH)}工资。
本人自 ${demoCnDate(DEMO_DISMISSAL_DAY + 1)}起被收回全部办公权限，${demoShortMonthCn(DEMO_DISMISSAL_MONTH)}工资至今未发放。

据此，本人不认可上述解除行为的合法性，保留就违法解除赔偿金、欠付工资、未休年休假工资报酬及加班费向劳动人事争议仲裁委员会提起仲裁的全部权利。本人已确认收到通知书，但该确认仅表示收到文件，不代表认可其内容。

请贵司于收到本函之日起五个工作日内书面答复。

异议人：陈某
${demoCnDate(-9)}`,
  },
  {
    id: 'dr_2',
    caseId: 'demo',
    kind: '证据清单',
    title: '仲裁证据清单（第一批）',
    version: 1,
    status: '草稿',
    updatedAt: demoDay(-8, '09:30'),
    content: `证据清单（申请人提交，第一批）

证据一：劳动合同及两次续签协议（复印件 3 份，原件质证时出示）
    证明目的：申请人与被申请人自 ${demoCnDate(DEMO_HIRE_DAY)}起建立劳动关系，工作地点为北京市朝阳区，约定月工资 25000 元。

证据二：${demoMonthRangeCn(DEMO_DISMISSAL_MONTH - 11, DEMO_DISMISSAL_MONTH - 1)}银行工资流水
    证明目的：申请人解除前 12 个月平均工资为 25000 元，作为赔偿金计算基数；${demoMonthCn(DEMO_DISMISSAL_MONTH)}工资未发放。

证据三：《解除劳动合同通知书》（原件）
    证明目的：被申请人于 ${demoCnDate(DEMO_DISMISSAL_DAY)}单方解除劳动合同，所载理由为"客观情况发生重大变化"。

证据四：钉钉工作群聊天记录截屏
    证明目的：被申请人内部宣布的是部门合并与人员优化，与通知书所称客观情况变化不符。

证据五：钉钉打卡记录 ${demoMonthRangeCn(DEMO_DISMISSAL_MONTH - 4, DEMO_DISMISSAL_MONTH - 1)}
    证明目的：申请人于休息日加班合计 96 小时，被申请人未安排补休亦未支付加班费。

证据六：北京市社会保险个人权益记录
    证明目的：被申请人自 ${demoMonthCn(DEMO_DISMISSAL_MONTH)}起停止缴纳社会保险费。`,
  },
];

export const demoCompanyDocs: CompanyDoc[] = [
  {
    id: 'cd_1',
    caseId: 'demo',
    fileId: 'f_1',
    title: '解除劳动合同通知书',
    docType: '解除通知',
    advice: '不签',
    adviceDetail: `通知书本体可以签收，但只写"仅确认于 ${demoCnDate(DEMO_DISMISSAL_DAY)}收到本通知，对内容有异议"。随附的《协商解除协议》不要签：它把解除原因改写为协商一致，并附带全面弃权条款，签署后再主张 2N 的难度会显著上升。`,
    createdAt: demoDay(DEMO_DISMISSAL_DAY, '10:22'),
    ocrText: `解除劳动合同通知书

陈某先生：

因公司业务结构调整，订立劳动合同时所依据的客观情况发生重大变化，致使原劳动合同无法履行，经公司研究决定，自 ${demoCnDate(DEMO_DISMISSAL_DAY)}起与您解除劳动合同。

公司将按 N+1 标准向您支付经济补偿，具体金额以人力资源部核算结果为准。请您于收到本通知之日起 3 个工作日内完成工作交接，并签署《协商解除协议》，逾期视为放弃相关权益。

您确认，除本通知及《协商解除协议》约定的款项外，您与公司之间再无其他任何争议及权利义务关系。

星曜网络科技（北京）有限公司
人力资源部
${demoCnDate(DEMO_DISMISSAL_DAY)}`,
    riskFlags: [
      {
        quote: '客观情况发生重大变化，致使原劳动合同无法履行',
        level: '高',
        note: '这是解除理由的法律定性。公司需举证客观情况具体是什么、以及为何无法通过变更合同继续履行。目前的表述空泛，且与内部"部门合并"的说法不一致，是主张违法解除的主要突破口。',
      },
      {
        quote: '按 N+1 标准向您支付经济补偿',
        level: '高',
        note: '解除若被认定违法，应付的是 2N 赔偿金而非 N+1 补偿金。按本案 8 年司龄、25000 元月工资计算，两者相差约 17.5 万元。',
      },
      {
        quote: '逾期视为放弃相关权益',
        level: '高',
        note: `公司单方设定的期限不产生失权效果。法定的仲裁时效为一年，自 ${demoCnDate(DEMO_DISMISSAL_DAY)}起算，不因未在 3 日内签字而缩短。`,
      },
      {
        quote: '您与公司之间再无其他任何争议及权利义务关系',
        level: '高',
        note: '一揽子弃权条款。签署后欠薪、年假、加班费、社保补缴均可能被认定已一并结清。这一条必须删除或改为逐项列明。',
      },
      {
        quote: '具体金额以人力资源部核算结果为准',
        level: '中',
        note: '金额未写死，等于把计算口径完全交给公司。答复时应要求书面列明基数、年限与各项明细。',
      },
    ],
  },
];

export const demoThread: Thread = {
  id: 'th_1',
  caseId: 'demo',
  mode: '陪跑',
};

export const demoMessages: Message[] = [
  {
    id: 'm_1',
    threadId: 'th_1',
    role: 'user',
    content:
      '我在一家互联网公司做了 8 年后端，上周 HR 找我谈，说部门要合并，让我签一份协商解除协议，给 N+1。我月薪 25000，在朝阳上班。这个能签吗？',
    createdAt: demoDay(-76, '09:20'),
  },
  {
    id: 'm_2',
    threadId: 'th_1',
    role: 'assistant',
    model: 'claude',
    createdAt: demoDay(-76, '09:20:40'),
    content: `先说结论：现在不要签。签了之后解除原因就变成"协商一致"，你能拿到的上限基本锁死在公司给的这个数；不签，主动权还在你手里。\n\n按你说的条件先算一遍：8 年司龄、月工资 25000 元，N+1 大约是 22.5 万元（8 个月 + 1 个月代通知金）。如果公司的解除被认定为违法解除，赔偿金是 2N，也就是 40 万元。差额大约 17.5 万元。\n\n你的月工资 25000 元没有超过北京市上年度职工月平均工资的三倍（35283 元），所以不适用封顶，年限也不受 12 年上限限制——这一点对你有利。\n\n为了判断"部门合并"是否构成合法解除理由，我还需要三件事：\n1. 公司有没有给过书面的岗位变更方案；\n2. ${demoShortMonthCn(demoMonthOfDay(-99))}那次全员会有没有留下通知、纪要或聊天记录；\n3. 你最近 12 个月的工资构成（基本工资 + 绩效 + 补贴分别多少）。`,
    actionItemIds: [],
    lawRefs: [
      {
        cite: '《中华人民共和国劳动合同法》第四十条第三项',
        conclusion:
          '以"客观情况重大变化"解除，前提是先协商变更劳动合同且协商不成，公司要为这两步举证。',
        fullText:
          '有下列情形之一的，用人单位提前三十日以书面形式通知劳动者本人或者额外支付劳动者一个月工资后，可以解除劳动合同：……（三）劳动合同订立时所依据的客观情况发生重大变化，致使劳动合同无法履行，经用人单位与劳动者协商，未能就变更劳动合同内容达成协议的。',
      },
    ],
  },
  {
    id: 'm_3',
    threadId: 'th_1',
    role: 'user',
    content:
      '没有给过书面方案，只是会上说了一句。全员会有钉钉群通知截图。工资是固定的 25000，没有绩效浮动。今天他们直接给我发了《解除劳动合同通知书》。',
    createdAt: demoDay(DEMO_DISMISSAL_DAY, '10:12'),
  },
  {
    id: 'm_4',
    threadId: 'th_1',
    role: 'assistant',
    model: 'claude',
    createdAt: demoDay(DEMO_DISMISSAL_DAY, '10:35'),
    content:
      '通知书我已经解读完，风险点标在「文件解读」页，一共 5 处，其中 4 处是高风险。\n\n最关键的两处：一是公司把解除理由写成"客观情况发生重大变化"，但没有书面变更方案，也没有协商记录，这一步程序缺失，是你主张违法解除、要求 2N 的核心依据；二是通知书末尾那句"再无其他任何争议及权利义务关系"，属于一揽子弃权，欠薪、年假、加班费一旦签字就可能被视为一并结清。\n\n通知书本身可以签收，但要在签名旁写明"仅确认收到，对内容有异议"。随附的《协商解除协议》不要签。\n\n档案已经更新：时间线补到 4 条，诉求初算 4 项合计 46.87 万元。接下来 7 天有三件事要做，都在下面的行动卡里。',
    actionItemIds: ['ai_1', 'ai_2', 'ai_4'],
    lawRefs: [
      {
        cite: '《中华人民共和国劳动合同法》第四十七条',
        conclusion:
          '经济补偿按每满一年一个月工资计；月工资高于当地上年度职工月平均工资三倍的，按三倍计且最多支付 12 年。',
        fullText:
          '经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资的标准向劳动者支付。六个月以上不满一年的，按一年计算；不满六个月的，向劳动者支付半个月工资的经济补偿。劳动者月工资高于用人单位所在直辖市、设区的市级人民政府公布的本地区上年度职工月平均工资三倍的，向其支付经济补偿的标准按职工月平均工资三倍的数额支付，向其支付经济补偿的年限最高不超过十二年。本条所称月工资是指劳动者在劳动合同解除或者终止前十二个月的平均工资。',
      },
      {
        cite: '《中华人民共和国劳动合同法》第八十七条',
        conclusion: '公司违法解除的，按经济补偿标准的二倍支付赔偿金，即本案的 2N。',
        fullText:
          '用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条规定的经济补偿标准的二倍向劳动者支付赔偿金。',
      },
    ],
  },
  {
    id: 'm_5',
    threadId: 'th_1',
    role: 'user',
    content: `${demoShortMonthCn(DEMO_DISMISSAL_MONTH)}工资到今天还没发，社保也停了。是不是可以直接去仲裁？`,
    createdAt: demoDay(-9, '19:50'),
  },
  {
    id: 'm_6',
    threadId: 'th_1',
    role: 'assistant',
    model: 'claude',
    createdAt: demoDay(-9, '19:51:20'),
    content: `可以直接申请仲裁，时效到 ${demoCnDate(DEMO_ARBITRATION_DEADLINE_DAY)}，不着急。但在立案之前先补一步：发一份书面《催告支付工资函》。\n\n理由是证据角度而不是程序角度——书面催告会把"公司明知欠薪且经催告仍不支付"这个事实固定下来，对后续主张有帮助；同时它也给了对方一个在开庭前和解的台阶，很多案子在这一步就谈成了。\n\n社保停缴属于另一条线：仲裁委通常不直接处理补缴争议，需要向社保稽核部门投诉。这条我另外给你一张行动卡，不占用仲裁的准备时间。\n\n异议函第二版已经写好，在「文书」页。发出去之前会再问你一次——这份是要送到公司的，发出后对方会看到全部内容。`,
    actionItemIds: ['ai_3'],
    lawRefs: [
      {
        cite: '《中华人民共和国劳动争议调解仲裁法》第二十七条',
        conclusion: `仲裁时效为一年，从知道或应当知道权利被侵害之日起算；本案自 ${demoCnDate(DEMO_DISMISSAL_DAY)}起算。`,
        fullText:
          '劳动争议申请仲裁的时效期间为一年。仲裁时效期间从当事人知道或者应当知道其权利被侵害之日起计算。……劳动关系存续期间因拖欠劳动报酬发生争议的，劳动者申请仲裁不受本条第一款规定的仲裁时效期间的限制；但是，劳动关系终止的，应当自劳动关系终止之日起一年内提出。',
      },
    ],
  },
];

export const demoGongdao: Gongdao = {
  balance: 3860,
  ledger: [
    {
      id: 'gl_1',
      delta: 2000,
      type: '注册赠送',
      feature: 'signup',
      meta: '注册赠送，够走完一次完整首诊',
      createdAt: demoDay(-76, '09:12'),
    },
    {
      id: 'gl_2',
      delta: -412,
      type: '消耗',
      feature: 'agent.问诊',
      meta: '首诊问答 6 轮 · claude',
      createdAt: demoDay(-76, '09:26'),
    },
    {
      id: 'gl_3',
      delta: 5900,
      type: '充值',
      feature: 'order.中配月卡',
      meta: '中配套餐 ¥59',
      createdAt: demoDay(DEMO_DISMISSAL_DAY, '10:05'),
    },
    {
      id: 'gl_4',
      delta: -1180,
      type: '消耗',
      feature: 'ocr.解除通知',
      meta: '解除通知 OCR + 风险解读 · qwen-vl',
      createdAt: demoDay(DEMO_DISMISSAL_DAY, '10:22'),
    },
    {
      id: 'gl_5',
      delta: -1200,
      type: '固化出证',
      feature: 'evidence.attest',
      meta: `存证订单 ${DEMO_ATTESTATION_NO}`,
      createdAt: demoDay(DEMO_DISMISSAL_DAY, '10:31'),
    },
    {
      id: 'gl_6',
      delta: -1248,
      type: '消耗',
      feature: 'draft.异议函',
      meta: '异议函 v1 → v2 · claude',
      createdAt: demoDay(-9, '20:10'),
    },
  ],
};
