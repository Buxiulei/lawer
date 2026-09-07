/**
 * mock 数据类型：字段语义对齐 spec §7 数据模型。
 * 后端 lib/db 落地后本文件类型应被真实 DB 类型替换，页面组件签名不变。
 */

export type CaseStage =
  | '风声'
  | '约谈中'
  | '已收通知'
  | '已解除'
  | '仲裁准备'
  | '已立案'
  | '开庭'
  | '裁决'
  | '一审'
  | '二审'
  | '执行'
  | '结案';

export interface CaseRecord {
  id: string;
  userId: string;
  title: string;
  stage: CaseStage;
  district: string;
  goal: string;
  bottomLine: string;
  status: '进行中' | '已结案';
  createdAt: string;
}

export interface CompanyProfile {
  id: string;
  caseId: string;
  name: string;
  uscc: string;
  role: '签约主体' | '用工主体' | '关联';
  regCapital: string;
  legalRep: string;
  riskNotes: string;
  sources: { title: string; url: string }[];
  investigatedAt: string;
}

export type TimelineKind = '公司动作' | '我方动作' | '系统动作' | '期限';

export interface TimelineEvent {
  id: string;
  caseId: string;
  happenedAt: string;
  kind: TimelineKind;
  title: string;
  detail: string;
  evidenceIds: string[];
}

export type EvidenceCategory =
  | '合同'
  | '工资'
  | '社保'
  | '考勤'
  | '沟通记录'
  | '公司文件'
  | '录音'
  | '其他';

export type EvidenceStatus = '已上传' | '已固化' | '已出证';

export interface EvidenceItem {
  id: string;
  caseId: string;
  fileId: string;
  name: string;
  category: EvidenceCategory;
  provePurpose: string;
  originalMedium: string;
  status: EvidenceStatus;
  sizeBytes: number;
  sha256: string;
  attestationNo?: string;
  createdAt: string;
}

export type ClaimKind =
  | '2N'
  | 'N'
  | 'N+1'
  | '欠薪'
  | '年假'
  | '加班费'
  | '双倍工资'
  | '年终奖'
  | '竞业补偿'
  | '其他';

export interface Claim {
  id: string;
  caseId: string;
  kind: ClaimKind;
  label: string;
  amountFen: number;
  /** 计算留痕：口径、分段、封顶判定 */
  calc: {
    formula: string;
    inputs: Record<string, string | number>;
    /** 北京三倍社平封顶判定说明，未触发也要写明为什么不触发 */
    capNote: string;
  };
  basis: string;
  status: '初算' | '待补证' | '已确认';
}

export type ActionStatus = '待办' | '完成' | '放弃';

export interface ActionItem {
  id: string;
  caseId: string;
  title: string;
  detail: string;
  dueAt: string | null;
  priority: 1 | 2 | 3;
  status: ActionStatus;
  sourceMessageId: string | null;
  createdAt: string;
}

/**
 * 期限种类。**开放字符串，不是联合类型**：能落哪几类由**案件所属领域**的
 * `DomainPack.deadlineKinds` 说了算（服务端 deadline_set 按它校验），每个领域各一份。
 *
 * 【为什么不在这里钉一个领域那七类】钉死的形态是：第二个领域的每一类期限都不在联合里，
 * 页面把它们一律收成词表里最保守的那一档，于是每张卡的标题都写着同一个词
 *（「诉讼时效3年」在卡面上叫「自定义」），而 tsc 退出码 0、页面不报错、卡片数量也对。
 * 服务端那侧同一条结论早就落了（lib/cases/drafts.ts 的 `DraftKind = string`）。
 */
export type DeadlineKind = string;

export interface Deadline {
  id: string;
  caseId: string;
  kind: DeadlineKind;
  title: string;
  dueAt: string;
  derivedFrom: string;
}

/** 文书种类。同 DeadlineKind：词表在 `DomainPack.docKinds`，这里只说"是个字符串"。 */
export type DraftKind = string;

export interface Draft {
  id: string;
  caseId: string;
  kind: DraftKind;
  title: string;
  content: string;
  version: number;
  status: '草稿' | '待定稿' | '已发出';
  updatedAt: string;
}

export type CompanyDocType =
  | '解除通知'
  | '协商协议'
  | '调岗通知'
  | 'PIP'
  | '警告'
  | '其他';

export interface RiskFlag {
  /** 原文中被标记的片段，用于在解读页高亮 */
  quote: string;
  level: '高' | '中' | '低';
  note: string;
}

export interface CompanyDoc {
  id: string;
  caseId: string;
  fileId: string;
  title: string;
  docType: CompanyDocType;
  ocrText: string;
  riskFlags: RiskFlag[];
  advice: '签' | '不签' | '改签' | '待定';
  adviceDetail: string;
  createdAt: string;
}

export interface LawRef {
  /** 如「《中华人民共和国劳动合同法》第 47 条」 */
  cite: string;
  /** 一句话结论 */
  conclusion: string;
  /** 逐字原文，展开后显示在引用块中 */
  fullText: string;
}

export interface Message {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  createdAt: string;
  /** 结构化：本轮回复产出的行动卡 id */
  actionItemIds?: string[];
  /** 结构化：本轮引用的法条 */
  lawRefs?: LawRef[];
}

export interface Thread {
  id: string;
  caseId: string;
  mode: '问诊' | '陪跑' | '文书' | '录音分析';
}

export interface User {
  id: string;
  nickname: string;
  phoneMasked: string;
  email: string;
  authStatus: '未认证' | '待审' | '已实名';
  membership: '入门' | '中配' | '高配' | '无';
  createdAt: string;
}

export interface GongdaoLedgerEntry {
  id: string;
  /** 公道值增减（点数，不是钱），只追加不修改 */
  delta: number;
  type: '注册赠送' | '充值' | '消耗' | '兑换码' | '固化出证';
  feature: string;
  meta: string;
  createdAt: string;
}

export interface Gongdao {
  balance: number;
  ledger: GongdaoLedgerEntry[];
}
