// app/src/app/_ui/domain.ts
// 页面侧读领域包的**唯一入口**（设计稿 §13「网页」行）。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量。这里只有「怎么取」，取出来的字全在 lib/domains/<key>.ts。
// 由 app/__tests__/page-domain-guard.test.ts 机检。
// ─────────────────────────────────────────────────────
//
// 【为什么要有这一层，而不是各处 `DOMAINS[x] ?? DOMAINS[缺省]`】散着写的形态是：
// 某一处忘了兜底，那一处就在一行 domain 写坏的案件上炸在属性访问；或者反过来——
// 将来要改政策时得先把散落的每一处翻出来，而漏掉的那一处不会报错。
// 服务端那侧的同一条政策收在 registry.domainPackOrDefault，本文件直接引它，
// **不再写第二份兜底**。
//
// 【页面为什么可以直接引 lib/domains】lib/domains/registry.ts 只引领域包，
// 领域包只引 lib/cases/stages 与 lib/cases/milestones 这两个零 import 的词表文件
// 与 lib/agent/crisis-opener 这个叶子模块——一个 lib/db 都不会被拖进浏览器包。

import { domainPackOrDefault, journeyOfPack } from '@/lib/domains/registry';

export { domainPackOrDefault as packOf };

/**
 * 驾驶舱那条轨道的格子。
 *
 * 领域包没给 `journey` 时**退回 stages**：让轨道至少讲这个行当的事，
 * 好过继续摆着上一个领域的格子（那时页面照常渲染、一个报错都没有，
 * 只有这个用户读到的每一格都在说另一个行当）。
 *
 * 退回不是等价物：stages 是可回退的当前态，轨道格子是只追加的既成事实——
 * 退回之后那条轨道会跟着 stage 一起往回缩。所以领域包该给的还是要给。
 */
export function journeyOf(domain: string | null | undefined): readonly string[] {
  return journeyOfPack(domainPackOrDefault(domain));
}

/**
 * 本领域的并行轨（设计稿 §16）。**空数组是结论不是缺项**：
 * 主线线性的领域没有并行轨，页面据此**整行不渲染**——
 * 摆一行「当前轨：无」出来，是在告诉用户这里本该有点什么。
 */
export function tracksOf(domain: string | null | undefined): readonly string[] {
  return domainPackOrDefault(domain).tracks;
}
