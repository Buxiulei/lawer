// app/src/lib/agent/facts-entry.ts
// **事实卡的唯一渲染入口**（设计稿 §4.2-2 / §4.2-4）。
//
// 【为什么要有这个文件】事实卡此前有两个出口（站内 prompt、MCP 的 case_facts），各自写着
// 渲染器套渲染器那一句。S4 又添了两个读者——facts_token 的签发与核验。
// 四处各拼一遍的形态**不是崩溃，是一条永远走不通的路**：某一处渲染出来的字与另一处
// 差一个空格，于是每一次令牌核验都判 stale，调用方照着提示重读、再写、再 stale，
// 而两边看起来都在正常工作（设计稿 §4.2-4「哈希绑的是那份卡的字节」）。
//
// 所以收成一个入口：全仓对渲染器的调用只出现在下面那一行（判据
// case-facts.test.ts G-F0 按源码扫，多一处即红）。
//
// 【归属校验不在这里】本文件只按 caseId 取数与渲染，**不认识 user_id**——
// 与 loadCaseSnapshot 同一条分工（归属由 lib/cases 那道门把关）。
// 调用方必须先过 lib/cases 的归属校验；直接拿它去回一个 HTTP 响应，
// 就是把别人的事实卡整张交出去，而且返回 200、格式完全正常。
import type { Database } from 'better-sqlite3';

import { buildCaseFacts, renderCaseFacts } from './case-facts';
import { loadCaseSnapshot, type CaseSnapshot } from './snapshot';

/** 从**手上已有的快照**渲染事实卡。站内每一轮走这条（快照上游已经取过一次，不重取）。 */
export function factsCardOf(snapshot: CaseSnapshot): string {
  return renderCaseFacts(buildCaseFacts(snapshot));
}

/**
 * 按 caseId 现取现渲。**调用方必须已经做过归属校验**（见文件头）。
 * MCP/REST 的 case_facts 与 facts_token 的核验走这条。
 */
export function factsCardFor(db: Database, caseId: number): string {
  return factsCardOf(loadCaseSnapshot(db, caseId));
}
