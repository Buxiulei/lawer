/**
 * 文件解读 / 文书两个页面的 mock 数据（对齐 spec §7 的 company_docs、drafts、share_links）。
 *
 * demo.ts 已有的《解除劳动合同通知书》与两份文书在这里被复用并补齐页面需要的字段：
 * - 风险条款要能点开看到法条依据 → 按 quote 挂 LawRef
 * - 文书要能切版本、能分享 → 版本表与分享链接表
 */

import {
  demoCnDate,
  demoDate,
  demoDay,
  demoMonthCn,
  demoMonthRangeCn,
  demoShortCnDate,
  demoYearOfDay,
} from './clock';
import {
  DEMO_CONTRACT_END_DAY,
  DEMO_DISMISSAL_DAY,
  DEMO_DISMISSAL_MONTH,
  DEMO_EMPLOYEE_NO,
  DEMO_HIRE_DAY,
  demoCompanyDocs,
  demoDrafts,
} from './demo';
import type { CompanyDoc, Draft, LawRef, RiskFlag } from './types';

/* ── 法条原文（逐字，供风险条款与文书页引用）───────────────── */

const LAW_LC_40: LawRef = {
  cite: '《中华人民共和国劳动合同法》第 40 条',
  conclusion:
    '以"客观情况发生重大变化"解除，公司必须先协商变更劳动合同，协商不成才能解除，且要提前三十日书面通知或多付一个月工资。',
  fullText:
    '有下列情形之一的，用人单位提前三十日以书面形式通知劳动者本人或者额外支付劳动者一个月工资后，可以解除劳动合同：（一）劳动者患病或者非因工负伤，在规定的医疗期满后不能从事原工作，也不能从事由用人单位另行安排的工作的；（二）劳动者不能胜任工作，经过培训或者调整工作岗位，仍不能胜任工作的；（三）劳动合同订立时所依据的客观情况发生重大变化，致使劳动合同无法履行，经用人单位与劳动者协商，未能就变更劳动合同内容达成协议的。',
};

const LAW_LC_47: LawRef = {
  cite: '《中华人民共和国劳动合同法》第 47 条',
  conclusion:
    '经济补偿按工作年限每满一年一个月工资计算，月工资高于本地区上年度职工月平均工资三倍的按三倍封顶、年限最高十二年。',
  fullText:
    '经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资的标准向劳动者支付。六个月以上不满一年的，按一年计算；不满六个月的，向劳动者支付半个月工资的经济补偿。劳动者月工资高于用人单位所在直辖市、设区的市级人民政府公布的本地区上年度职工月平均工资三倍的，向其支付经济补偿的标准按职工月平均工资三倍的数额支付，向其支付经济补偿的年限最高不超过十二年。本条所称月工资是指劳动者在劳动合同解除或者终止前十二个月的平均工资。',
};

const LAW_LC_87: LawRef = {
  cite: '《中华人民共和国劳动合同法》第 87 条',
  conclusion: '解除被认定违法的，公司要按经济补偿标准的二倍支付赔偿金，也就是常说的 2N。',
  fullText:
    '用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第四十七条规定的经济补偿标准的二倍向劳动者支付赔偿金。',
};

const LAW_LC_26: LawRef = {
  cite: '《中华人民共和国劳动合同法》第 26 条',
  conclusion: '用人单位免除自己法定责任、排除劳动者权利的条款无效，弃权条款属于这一类。',
  fullText:
    '下列劳动合同无效或者部分无效：（一）以欺诈、胁迫的手段或者乘人之危，使对方在违背真实意思的情况下订立或者变更劳动合同的；（二）用人单位免除自己的法定责任、排除劳动者权利的；（三）违反法律、行政法规强制性规定的。对劳动合同的无效或者部分无效有争议的，由劳动争议仲裁机构或者人民法院确认。',
};

const LAW_LC_25: LawRef = {
  cite: '《中华人民共和国劳动合同法》第 25 条',
  conclusion: '除培训服务期和竞业限制两种情形外，公司不得与劳动者约定由劳动者承担违约金。',
  fullText:
    '除本法第二十二条和第二十三条规定的情形外，用人单位不得与劳动者约定由劳动者承担违约金。',
};

const LAW_LC_23: LawRef = {
  cite: '《中华人民共和国劳动合同法》第 23 条',
  conclusion: '约定竞业限制的，公司必须在限制期限内按月支付经济补偿，没有补偿的竞业条款对你没有约束力。',
  fullText:
    '用人单位与劳动者可以在劳动合同中约定保守用人单位的商业秘密和与知识产权相关的保密事项。对负有保密义务的劳动者，用人单位可以在劳动合同或者保密协议中与劳动者约定竞业限制条款，并约定在解除或者终止劳动合同后，在竞业限制期限内按月给予劳动者经济补偿。劳动者违反竞业限制约定的，应当按照约定向用人单位支付违约金。',
};

const LAW_LC_35: LawRef = {
  cite: '《中华人民共和国劳动合同法》第 35 条',
  conclusion: '调岗调薪属于变更劳动合同，必须双方协商一致并采用书面形式，公司不能单方决定。',
  fullText:
    '用人单位与劳动者协商一致，可以变更劳动合同约定的内容。变更劳动合同，应当采用书面形式。变更后的劳动合同文本由用人单位和劳动者各执一份。',
};

const LAW_ARB_27: LawRef = {
  cite: '《劳动争议调解仲裁法》第 27 条',
  conclusion: '仲裁时效是一年，从知道权利被侵害之日起算，公司自己定的"三日内答复"不能缩短它。',
  fullText:
    '劳动争议申请仲裁的时效期间为一年。仲裁时效期间从当事人知道或者应当知道其权利被侵害之日起计算。前款规定的仲裁时效，因当事人一方向对方当事人主张权利，或者向有关部门请求权利救济，或者对方当事人同意履行义务而中断。从中断时起，仲裁时效期间重新计算。因不可抗力或者有其他正当理由，当事人不能在本条第一款规定的仲裁时效期间申请仲裁的，仲裁时效中止。从中止时效的原因消除之日起，仲裁时效期间继续计算。劳动关系存续期间因拖欠劳动报酬发生争议的，劳动者申请仲裁不受本条第一款规定的仲裁时效期间的限制；但是，劳动关系终止的，应当自劳动关系终止之日起一年内提出。',
};

const LAW_LAW_50: LawRef = {
  cite: '《中华人民共和国劳动法》第 50 条',
  conclusion: '工资必须按月足额以货币支付，不得克扣或者无故拖欠。',
  fullText:
    '工资应当以货币形式按月支付给劳动者本人。不得克扣或者无故拖欠劳动者的工资。',
};

const LAW_ANNUAL_5: LawRef = {
  cite: '《职工带薪年休假条例》第 5 条',
  conclusion: '应休未休的年休假，公司要按日工资收入的 300% 支付年休假工资报酬。',
  fullText:
    '单位根据生产、工作的具体情况，并考虑职工本人意愿，统筹安排职工年休假。年休假在1个年度内可以集中安排，也可以分段安排，一般不跨年度安排。单位因生产、工作特点确有必要跨年度安排职工年休假的，可以跨1个年度安排。单位确因工作需要不能安排职工年休假的，经职工本人同意，可以不安排职工年休假。对职工应休未休的年休假天数，单位应当按照该职工日工资收入的300%支付年休假工资报酬。',
};

/* ── 类型：给风险条款挂上法条依据 ───────────────────────────── */

export interface AnnotatedRiskFlag extends RiskFlag {
  /** 点开高亮后展示的依据，可为空（有的风险是事实问题不是法条问题） */
  laws: LawRef[];
}

export interface AnnotatedDoc extends Omit<CompanyDoc, 'riskFlags'> {
  riskFlags: AnnotatedRiskFlag[];
  /** 原始上传文件名，列表页显示 */
  fileName: string;
}

/** demo.ts 里 cd_1 的风险条款按原文片段挂依据 */
const LAWS_BY_QUOTE: Record<string, LawRef[]> = {
  '客观情况发生重大变化，致使原劳动合同无法履行': [LAW_LC_40],
  '按 N+1 标准向您支付经济补偿': [LAW_LC_47, LAW_LC_87],
  '逾期视为放弃相关权益': [LAW_ARB_27],
  '您与公司之间再无其他任何争议及权利义务关系': [LAW_LC_26, LAW_LAW_50],
  '具体金额以人力资源部核算结果为准': [LAW_LC_47],
};

const dismissalDoc: AnnotatedDoc = {
  ...demoCompanyDocs[0],
  fileName: `解除劳动合同通知书_${demoDate(DEMO_DISMISSAL_DAY).replace(/-/g, '')}.jpg`,
  riskFlags: demoCompanyDocs[0].riskFlags.map((f) => ({
    ...f,
    laws: LAWS_BY_QUOTE[f.quote] ?? [],
  })),
};

const settlementDoc: AnnotatedDoc = {
  id: 'cd_2',
  caseId: 'demo',
  fileId: 'f_2',
  title: '协商解除劳动合同协议书',
  docType: '协商协议',
  fileName: '协商解除协议_HR版.pdf',
  advice: '改签',
  adviceDetail:
    '这份协议本身可以成为你想要的结果，但现在这一版不能签：它把解除原因改成"个人原因离职"，把 175,000 元包装成"包含一切款项"，还塞了弃权、保密违约金和无补偿竞业三条。逐条改掉后再签，谈判空间仍然在你这边。',
  createdAt: demoDay(DEMO_DISMISSAL_DAY, '10:26'),
  ocrText: `协商解除劳动合同协议书

甲方：星曜网络科技（北京）有限公司
乙方：陈某    身份证号：1101**********0037

甲乙双方经友好协商，就解除劳动合同事宜达成如下协议：

一、双方一致同意，劳动合同于 ${demoCnDate(DEMO_DISMISSAL_DAY)}解除。解除原因为乙方个人原因申请离职，双方协商一致，甲方无需出具解除劳动合同证明中的用人单位提出字样。

二、甲方于本协议签署后 30 个工作日内，向乙方一次性支付经济补偿金人民币 175,000 元（税前），该款项已包含乙方在职期间的全部工资、奖金、加班费、未休年休假工资及其他一切款项。

三、乙方确认，除本协议第二条约定的款项外，乙方自愿放弃全部劳动报酬及经济补偿请求，并放弃就劳动关系存续期间及解除过程中的一切事项向甲方主张任何权利。

四、乙方承诺不向任何第三方披露本协议内容及在职期间知悉的甲方经营信息，如有违反，应向甲方支付违约金人民币 200,000 元。

五、乙方承诺自本协议签署之日起两年内不得在与甲方有竞争关系的单位任职或提供服务，甲方无需为此另行支付竞业限制补偿。

六、本协议经双方签字盖章后生效。乙方确认已充分理解本协议全部条款，签署后不得以任何理由撤销或要求变更。

甲方（盖章）：                乙方（签字）：
${demoCnDate(DEMO_DISMISSAL_DAY)}`,
  riskFlags: [
    {
      quote: '解除原因为乙方个人原因申请离职',
      level: '高',
      note: '这一句是整份协议里最贵的一句。写成个人原因离职，等于你自己承认放弃了 2N 赔偿金的基础，同时失业保险金也领不了。它还和公司自己出具的《解除劳动合同通知书》互相矛盾——通知书写的是公司单方解除。必须改成"甲方提出解除，双方协商一致"。',
      laws: [LAW_LC_47, LAW_LC_87],
    },
    {
      quote: '该款项已包含乙方在职期间的全部工资、奖金、加班费、未休年休假工资及其他一切款项',
      level: '高',
      note: '打包吸收条款。175,000 元看起来接近 N+1，但这句话把 7 月欠薪、96 小时加班费、未休年假一并塞了进去，等于你用赔偿金替公司垫付了本来就该付的钱。正确写法是分项列明：赔偿金多少、欠薪多少、年假折算多少、加班费多少，各自写清。',
      laws: [LAW_LAW_50, LAW_ANNUAL_5],
    },
    {
      quote: '乙方自愿放弃全部劳动报酬及经济补偿请求',
      level: '高',
      note: '排除劳动者权利的条款，法律上可以主张无效，但"可以主张"意味着要先打一场官司去证明它无效。最省事的做法是签之前直接把这一条划掉，而不是签完再去争。',
      laws: [LAW_LC_26],
    },
    {
      quote: '应向甲方支付违约金人民币 200,000 元',
      level: '中',
      note: '劳动者只在两种情形下可以被约定违约金：培训服务期、竞业限制。保密义务的违约金没有法律依据。这一条要么删掉，要么改成双向保密且不设违约金。',
      laws: [LAW_LC_25],
    },
    {
      quote: '甲方无需为此另行支付竞业限制补偿',
      level: '高',
      note: '两年竞业却不给补偿。没有按月补偿的竞业条款你可以不履行，但签了之后公司仍可能拿它给你的下家发函制造麻烦。要么删掉这一条，要么写明按月支付补偿的金额和账户。',
      laws: [LAW_LC_23],
    },
    {
      quote: '本协议签署后 30 个工作日内',
      level: '中',
      note: '30 个工作日实际接近一个半月，且没有写逾期怎么办。改成"解除之日起 15 日内一次性付清，逾期按日万分之五支付违约金"，并写明打到哪张卡。',
      laws: [],
    },
  ],
};

// 修改要点单独挂，避免和 spec 的 company_docs 字段混在一起
const settlementRevisePoints = [
  '第一条：解除原因改为"甲方提出解除，双方协商一致"，删除关于解除证明表述的约定。',
  `第二条：金额分项列明——违法解除赔偿金、${demoMonthCn(DEMO_DISMISSAL_MONTH)}工资、未休年休假工资、加班费各自单列；支付期限改为解除之日起 15 日内，写明逾期违约责任与收款账户。`,
  '第三条：整条删除。确需概括性表述的，改为"除本协议列明款项外，双方就已列明事项无其他争议"。',
  '第四条：违约金删除；保密义务改为双向，范围限定为商业秘密。',
  '第五条：整条删除；公司坚持保留的，写明竞业限制期限、按月补偿金额与支付方式。',
  '第六条：删除"不得以任何理由撤销或要求变更"，保留法定的撤销权。',
];

const transferDoc: AnnotatedDoc = {
  id: 'cd_3',
  caseId: 'demo',
  fileId: 'f_3',
  title: '岗位调整通知书',
  docType: '调岗通知',
  fileName: '岗位调整通知_钉钉截屏.png',
  advice: '待定',
  adviceDetail:
    '这是一份通知，不是要你签字的协议，签收本身不等于同意。现在还不能判断该不该接受——取决于你打算争 2N 还是保工作。要做的是在 3 日内书面回复：不同意变更，但服从公司安排先到岗提供劳动，保留异议。等谈判方向定了再回来更新这份文件的结论。',
  createdAt: demoDay(-62, '19:40'),
  ocrText: `岗位调整通知书

陈某：

因公司业务结构调整，经研究决定，自 ${demoCnDate(-60)}起将您的工作岗位由技术二部高级工程师调整为客户成功部实施支持岗，工作地点由北京市朝阳区望京变更为北京市大兴区亦庄经济技术开发区，薪酬结构按新岗位标准执行。

请您于 ${demoCnDate(-61)} 18:00 前确认并到岗报到，逾期未报到的，公司将按旷工处理。

星曜网络科技（北京）有限公司
人力资源部
${demoCnDate(-62)}`,
  riskFlags: [
    {
      quote: '工作地点由北京市朝阳区望京变更为北京市大兴区亦庄经济技术开发区',
      level: '高',
      note: '望京到亦庄单程通勤增加一个半小时以上，属于劳动合同约定的工作地点发生重大变更，需要双方协商一致，公司不能单方通知了事。',
      laws: [LAW_LC_35],
    },
    {
      quote: '薪酬结构按新岗位标准执行',
      level: '高',
      note: '没写新标准是多少，实际是变相降薪。回复里要求公司书面写明调整后的月薪构成与数额，公司拒绝提供本身就是证据。',
      laws: [LAW_LC_35],
    },
    {
      quote: '逾期未报到的，公司将按旷工处理',
      level: '高',
      note: '这句话的作用是给你挖一个"严重违纪"的坑，好把 2N 变成 0。不要用不到岗来表达抗议：书面回复不同意变更、同时正常到岗提供劳动，让旷工这条路走不通。',
      laws: [],
    },
  ],
};

const handoverDoc: AnnotatedDoc = {
  id: 'cd_4',
  caseId: 'demo',
  fileId: 'f_4',
  title: '工作交接确认单',
  docType: '其他',
  fileName: `工作交接确认单_${demoDate(-32).replace(/-/g, '')}.jpg`,
  advice: '签',
  adviceDetail:
    '这张单子只确认物品和资料交接的事实，不涉及解除原因、金额和弃权，如实交接完就可以签。签之前把清单逐项核对一遍，签完先拍照留一份自己手里。唯一要盯住的是：不要让人在这张单子上添"薪资已结清""双方再无争议"之类的话，真被加了就当场划掉并注明。',
  createdAt: demoDay(-32, '16:05'),
  ocrText: `工作交接确认单

交接人：陈某（技术二部）    接收人：李某（技术二部）

交接内容：
1. 笔记本电脑一台，资产编号 XY-2021-0473，附电源适配器；
2. 员工门禁卡一张，卡号 3341；
3. 代码仓库与内部系统权限，已于交接日移交并注销；
4. 在办项目文档 12 份，清单见附页。

双方确认上述物品及资料已于 ${demoCnDate(-32)}交接完毕，物品外观完好。

交接人签字：            接收人签字：            部门负责人：`,
  riskFlags: [],
};

export const mockDocs: AnnotatedDoc[] = [
  dismissalDoc,
  settlementDoc,
  transferDoc,
  handoverDoc,
];

export function getDoc(docId: string): AnnotatedDoc | undefined {
  return mockDocs.find((d) => d.id === docId);
}

/** 改签建议的修改要点（按文件 id 取） */
export const revisePointsByDoc: Record<string, string[]> = {
  cd_2: settlementRevisePoints,
};

/* ── OCR 进度：确定性文案，不写「AI 思考中」──────────────────── */

export interface OcrStep {
  label: string;
  /** 停留毫秒，合计约 4.5 秒 */
  ms: number;
}

export const OCR_STEPS: OcrStep[] = [
  { label: '正在上传文件…', ms: 700 },
  { label: '正在识别文字…', ms: 1600 },
  { label: '正在比对风险条款…', ms: 1500 },
  { label: '正在生成签署建议…', ms: 900 },
];

/** 上传演示解读的是这份协商协议样张 */
export const DEMO_UPLOAD_DOC_ID = 'cd_2';

/* ── 文书 ───────────────────────────────────────────────────── */

const arbitrationDraft: Draft = {
  id: 'dr_3',
  caseId: 'demo',
  kind: '仲裁申请书',
  title: '劳动仲裁申请书（朝阳区仲裁委）',
  version: 1,
  status: '草稿',
  updatedAt: demoDay(-5, '21:05'),
  content: `劳动仲裁申请书

申请人：陈某，男，1990 年 3 月 12 日出生，汉族，住北京市朝阳区。
被申请人：星曜网络科技（北京）有限公司
住所地：北京市朝阳区望京东路 X 号 X 座
法定代表人：王某某    统一社会信用代码：91110105MA0**X**7B

仲裁请求：
一、请求裁决被申请人支付违法解除劳动合同赔偿金 400,000 元；
二、请求裁决被申请人支付 ${demoMonthCn(DEMO_DISMISSAL_MONTH)} 1 日至 ${demoShortCnDate(DEMO_DISMISSAL_DAY)}工资 12,500 元；
三、请求裁决被申请人支付 ${demoYearOfDay(DEMO_DISMISSAL_DAY) - 2} 年至 ${demoYearOfDay(DEMO_DISMISSAL_DAY)} 年未休年休假工资报酬 18,965 元；
四、请求裁决被申请人支付 ${demoMonthRangeCn(DEMO_DISMISSAL_MONTH - 4, DEMO_DISMISSAL_MONTH - 1)}休息日加班工资 33,103 元；
五、请求裁决被申请人为申请人补缴 ${demoMonthCn(DEMO_DISMISSAL_MONTH)}社会保险费。

事实与理由：
申请人自 ${demoCnDate(DEMO_HIRE_DAY)}入职被申请人处，双方签订三份书面劳动合同，最后一份期限至 ${demoCnDate(DEMO_CONTRACT_END_DAY)}，岗位为技术二部高级工程师，工作地点北京市朝阳区，解除前十二个月平均工资 25,000 元。

${demoCnDate(DEMO_DISMISSAL_DAY)}，被申请人向申请人出具《解除劳动合同通知书》，以"订立劳动合同时所依据的客观情况发生重大变化"为由单方解除劳动合同。但被申请人所称的客观情况变化实为内部部门合并，属于经营自主决策范畴，不构成法定的客观情况重大变化；且被申请人从未就变更劳动合同内容与申请人协商，直接作出解除决定，程序亦不合法。

综上，被申请人的解除行为构成违法解除，依法应支付赔偿金。为此，申请人依据《劳动争议调解仲裁法》相关规定提起仲裁，请依法裁决。

此致
北京市朝阳区劳动人事争议仲裁委员会

申请人：
${demoCnDate(-5)}`,
};

const wageDemandDraft: Draft = {
  id: 'dr_4',
  caseId: 'demo',
  kind: '其他',
  title: `${demoMonthCn(DEMO_DISMISSAL_MONTH)}工资催告函`,
  version: 1,
  status: '已发出',
  updatedAt: demoDay(-7, '10:20'),
  content: `星曜网络科技（北京）有限公司：

本人陈某，工号 ${DEMO_EMPLOYEE_NO}，与贵司的劳动关系已于 ${demoCnDate(DEMO_DISMISSAL_DAY)}解除。截至本函发出之日，贵司尚未支付本人 ${demoMonthCn(DEMO_DISMISSAL_MONTH)} 1 日至 ${demoShortCnDate(DEMO_DISMISSAL_DAY)}的工资 12,500 元。

工资应当以货币形式按月足额支付，不得克扣或者无故拖欠。现要求贵司于收到本函之日起三个工作日内，将上述款项支付至本人工资卡（尾号 4471）。

逾期未付的，本人将就该笔工资一并提起劳动仲裁，并主张相应经济补偿。

陈某
${demoCnDate(-7)}`,
};

export const mockDrafts: Draft[] = [...demoDrafts, arbitrationDraft, wageDemandDraft];

export function getDraft(draftId: string): Draft | undefined {
  return mockDrafts.find((d) => d.id === draftId);
}

export interface DraftVersion {
  version: number;
  content: string;
  updatedAt: string;
  /** 这一版改了什么，列表里显示一行 */
  note: string;
}

/** dr_1 有两版；其余文书只有当前一版，由 versionsOf 兜底生成 */
const VERSION_HISTORY: Record<string, DraftVersion[]> = {
  dr_1: [
    {
      version: 1,
      updatedAt: demoDay(-11, '22:40'),
      note: '首版：只写了对解除理由的异议',
      content: `星曜网络科技（北京）有限公司：

本人陈某，自 ${demoCnDate(DEMO_HIRE_DAY)}起与贵司建立劳动关系。${demoCnDate(DEMO_DISMISSAL_DAY)}，本人收到贵司《解除劳动合同通知书》，现提出异议如下：

贵司以"客观情况发生重大变化"为由解除劳动合同，但 ${demoCnDate(-99)}全员会上宣布的是部门合并，属于内部组织架构调整，不构成客观情况重大变化。本人不认可该解除行为的合法性。

异议人：陈某
${demoCnDate(-11)}`,
    },
    {
      version: 2,
      updatedAt: demoDay(-9, '20:10'),
      note: '补充未协商变更、7 月欠薪两项，并写明签收不等于认可',
      content: demoDrafts[0].content,
    },
  ],
};

export function versionsOf(draft: Draft): DraftVersion[] {
  const history = VERSION_HISTORY[draft.id];
  if (history) return history;
  return [
    {
      version: draft.version,
      content: draft.content,
      updatedAt: draft.updatedAt,
      note: '当前版本',
    },
  ];
}

/* ── 分享链接（spec §7 share_links；默认 7 天过期、可撤销）──── */

export interface ShareLink {
  id: string;
  draftId: string;
  token: string;
  scope: '档案只读' | '单文件下载';
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export const SHARE_TTL_DAYS = 7;

export const mockShareLinks: ShareLink[] = [
  {
    id: 'sl_1',
    draftId: 'dr_1',
    token: 'k3f9x2qm7ab4',
    scope: '单文件下载',
    createdAt: demoDay(-3, '09:05'),
    expiresAt: demoDay(-3 + SHARE_TTL_DAYS, '09:05'),
    revokedAt: null,
  },
  {
    id: 'sl_2',
    draftId: 'dr_1',
    token: 'p8w1nd5tz6cv',
    scope: '单文件下载',
    createdAt: demoDay(-8, '14:30'),
    expiresAt: demoDay(-8 + SHARE_TTL_DAYS, '14:30'),
    revokedAt: demoDay(-7, '08:15'),
  },
];

export function shareUrlOf(token: string): string {
  return `https://lawer.example.com/s/${token}`;
}
