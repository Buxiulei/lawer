// app/src/lib/domains/registry.ts
// 领域注册表（设计稿 §13）。一个「领域」= 一份配置 + 一组内容，**不是一套新代码**：
// 工具面、表结构、MCP/REST 协议跨领域不变，变的只是这里挂的那个包。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量（词表、阶段名、文书名、口径措辞）。领域内容一律写在
// 同目录下的领域包 `./<key>.ts` 里，本文件只认接口与映射。
// 这条由 __tests__/domain-neutral-guard.test.ts 机检：写回来一个领域词就红。
// 违反它的形态是——第二个领域接进来时，你以为只要加一个包，实际要去共用层里翻出
// 上一个领域留下的散落硬编码，而它们看起来都很正常。
// ─────────────────────────────────────────────────────

import { LABOR } from './labor';

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
