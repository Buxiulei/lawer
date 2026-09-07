// app/src/lib/ai-label-case.ts
// 「这个案子的显式标识该怎么说」——**服务端唯一入口**。
//
// 【为什么与 ai-label.ts 分成两个文件】那一份是法条要的几个字，浏览器与服务端都要读；
// 这一份要查库（案件属于哪个领域），一旦被客户端组件引到就把 better-sqlite3 拖进浏览器包。
// 分开之后，"能不能在客户端用"由 import 图本身回答，不靠人记得。
//
// 【为什么不让各处自己 `domainPackOrDefault(findCaseById(...)?.domain)`】需要这句话的
// 服务端出口有两个（免登录分享页、导出 PDF），将来还会有更多。各写一遍的形态是：
// 某一处忘了兜底、或者取错了那半句，而它照常返回 200、文件照常生成——
// 缺的只是法条要求的那一句。
import type { Database } from 'better-sqlite3';

import { AI_GENERATED_LABEL } from '@/lib/ai-label';
import { findCaseById } from '@/lib/db/cases';
import { domainPackOrDefault } from '@/lib/domains/registry';

/**
 * 显式标识的后半截（「所以它不是什么」）。
 * 案件查不到 / 领域写坏时按缺省领域走——同 domainPackOrDefault 的既有口径。
 */
export function caseAiDisclaimer(db: Database, caseId: number): string {
  return domainPackOrDefault(findCaseById(db, caseId)?.domain).copy.pages.aiLabelDisclaimer ?? '';
}

/**
 * 写进导出文件里的那**一整句**（标识办法 §4 末款）。
 * 后半截取不到时只给前半截：兜一句自己编的行当话比缺那半句更糟。
 */
export function caseAiLabelLine(db: Database, caseId: number): string {
  const tail = caseAiDisclaimer(db, caseId);
  return tail ? `${AI_GENERATED_LABEL}，${tail}。` : `${AI_GENERATED_LABEL}。`;
}
