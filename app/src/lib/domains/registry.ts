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
 * 一个领域包要提供的东西。P1 只落接口与 stages 的真实消费，其余四个数组先声明、
 * 由后续工单接到各自的消费点（事实卡分节 / 期限种类 / 文书种类 / 算钱器种类）。
 */
export interface DomainPack {
  /** 领域键，与 cases.domain 落库值同一份取值 */
  key: string;
  /** 给人看的领域名 */
  label: string;
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
 * 取领域包。取不到回 undefined 而不是回落到某个包——回落的形态是：
 * 一个 domain 写错的案件，会安安静静地按别的领域的阶段枚举被校验。
 */
export function getDomainPack(key: string): DomainPack | undefined {
  return DOMAINS[key];
}
