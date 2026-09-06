// app/src/lib/domains/registry.ts
// 领域注册表（设计稿 §13）。一个「领域」= 一份配置 + 一组内容，**不是一套新代码**：
// 工具面、表结构、MCP/REST 协议跨领域不变，变的只是这里挂的那个包。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量（词表、阶段名、文书名、口径措辞）。领域内容一律写在
// 同目录下的领域包 `./<key>.ts` 里，本文件只认接口与映射。
// 这条由 lib/capabilities/__tests__/registry-guard.test.ts 机检：写回来一个领域词就红。
// 违反它的形态是——第二个领域接进来时，你以为只要加一个包，实际要去共用层里翻出
// 上一个领域留下的散落硬编码，而它们看起来都很正常。
// ─────────────────────────────────────────────────────

import { LABOR } from './labor';

/**
 * 个案报告一节的**取数口径**。领域包只说"这一节叫什么、从哪一堆数据长出来"，
 * 生成器（lib/cases/report.ts）认的是这里的英文键，不认标题字面——
 * 认标题的形态是：第二个领域把「证据地图」改叫别的名字，生成器就悄悄给它一节空的。
 */
export type ReportSectionSource =
  | 'basics' // 案件抬头与基本字段
  | 'narrative' // 从时间线长出来的主线
  | 'disputes' // 争议点：金额主张
  | 'positions' // 目标与底线
  | 'evidence' // 材料清单与简报
  | 'timeline' // 时间线摘要
  | 'deadlines' // 生效中的期限
  | 'actions' // 未完成的待办
  | 'risks' // 缺口与未定项
  | 'changelog'; // 变更日志（只追加）

/** 个案报告的一节：给人看的标题 + 给生成器看的取数口径。 */
export interface ReportSectionSpec {
  title: string;
  source: ReportSectionSource;
}

/**
 * 本领域里「我方」与「对方」各是谁（设计稿 §14-1）。角色**不写死**：有的领域对面是一家机构，
 * 有的领域对面可能同时有好几方，谁在对面是领域的事，不是工具面的事。
 *
 * 【为什么工具描述要读它，而不是各自写死一个名词】写死的形态是：第二个领域接进来时，
 * 它的用户在工具清单里读到的仍是上一个领域的那个称呼——工具照常可用、回包照常正确，
 * 只是每一句话都在跟他讲另一个行当的事，而没有任何一处会报错。
 */
export interface DomainParties {
  /** 我方：这套工具服务的那一方 */
  self: string;
  /**
   * 对方主体的称呼，**第一个是最典型的那一个**（工具描述取它作单数称呼）。
   * 其余项是同一场纠纷里可能一并出现的其他对方主体。
   */
  counterparts: readonly string[];
  /** 对面是否可能同时不止一方（true 时工具面按「可能有好几家」说话，不按单数说） */
  multiParty: boolean;
}

/**
 * 一个领域包要提供的东西。P1 只落接口与 stages 的真实消费，其余四个数组先声明、
 * 由后续工单接到各自的消费点（事实卡分节 / 期限种类 / 文书种类 / 算钱器种类）。
 */
export interface DomainPack {
  /** 领域键，与 cases.domain 落库值同一份取值 */
  key: string;
  /** 给人看的领域名 */
  label: string;
  /** 我方与对方各是谁；工具面的「对方主体」措辞取自它，不在工具面写死 */
  parties: DomainParties;
  /** 案件阶段枚举。**唯一真源**：stage 校验读它，不再各处引 CASE_STAGES */
  stages: readonly string[];
  /** 事实卡分节标题（顺序即渲染顺序） */
  factsSections: readonly string[];
  /**
   * 个案报告的分节骨架（顺序即渲染顺序）。
   *
   * 【为什么不复用 factsSections】那份钉的是事实卡渲染器的分区标题（有判据逐条比对），
   * 是「服务端读出来的原始事实」；报告是**整理过的长期记忆**，两者分节本来就不同
   * （报告有「争议焦点」「谈判纪律」「变更日志」，事实卡没有）。混用一个数组的形态是：
   * 谁先改谁赢，而另一边的判据仍然绿着。
   */
  reportSections: readonly ReportSectionSpec[];
  /** 法定期限的种类 */
  deadlineKinds: readonly string[];
  /** 文书种类 */
  docKinds: readonly string[];
  /** 算钱器种类 */
  calculatorKinds: readonly string[];
}

/** key → 领域包。加一个领域 = 加一个包 + 在这里挂一行。 */
export const DOMAINS: Record<string, DomainPack> = {
  [LABOR.key]: LABOR,
};

/**
 * 缺省领域键：一条数据没说自己属于哪个领域时，按它算。
 *
 * 【为什么要有缺省，而不是要求处处显式声明】领域字段是**后加**的：库里既有的案件行、
 * 既有的知识卡都没有它（cases.domain 由迁移按默认值补齐；知识卡的 domain 只在卡片
 * 自己声明时才写进 index.json）。没有缺省就只能把"没声明"读成"不属于任何领域"，
 * 而那会让全部既有内容在按领域过滤的那一刻整批消失——返回 200、一条卡都不给。
 *
 * 【取值同源】取的是今天全站唯一在跑的那个包的 key，与 lib/db/migrate.ts 给
 * cases.domain 的 DDL 默认值同值。两处不一致的形态是：同一个存量案件按 A 包校验阶段、
 * 按 B 域检索知识，而两边都返回 200、都不报错。
 */
export const DEFAULT_DOMAIN: string = LABOR.key;

/**
 * 取领域包。取不到回 undefined 而不是回落到某个包——回落的形态是：
 * 一个 domain 写错的案件，会安安静静地按别的领域的阶段枚举被校验。
 */
export function getDomainPack(key: string): DomainPack | undefined {
  return DOMAINS[key];
}
