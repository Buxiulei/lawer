// app/src/lib/cases/intake-actions.ts
// 首诊做完给的那三件事：**种子 → 落库行的换算机制**。
//
// 【文案不在这里】按阶段的那张种子表在**领域包**里（DomainPack.intakeStageActions）。
// P4-W3 之前它住在本文件，按某一个领域的阶段名建键、写着那个行当的做法；
// 第二个领域接进来时 stage 一个都对不上，`?? []` 给 0 条种子，
// 首诊回包 actionsAdded=0 且没有一处报错——"现在做这三件事"那一屏是空的。
//
// 【为什么机制留在 lib 而不在页面里】这三条既要画在首诊第 6 步的「现在做这三件事」上，
// 又要落成用户案件里的 action_items——两处必须换算成同一个日子、同一个轻重顺序。
// 此前只有页面那一份，于是它们只是屏幕上的三行字：用户点「进入驾驶舱」，三件事一件都没进库。
//
// 【本文件保持纯】不 import 数据库、不 import 页面 mock：服务端落库与客户端预览都要用它，
// 掺进任何一边的依赖，另一边就得绕路（或者干脆再抄一份，那正是当初要修的病）。

import type { IntakeActionSeed } from '@/lib/domains/registry';

/**
 * 这条自查提醒的到期时刻（ISO8601）。dueInDays 为 null = 不设期限。
 * 预览与落库共用它，免得屏幕上写「3 天内」而库里存成了别的日子。
 */
export function intakeActionDueAt(seed: IntakeActionSeed, now: Date): string | null {
  return seed.dueInDays === null
    ? null
    : new Date(now.getTime() + seed.dueInDays * 86_400_000).toISOString();
}

/**
 * 种子序号 → action_items.priority。
 *
 * **种子表里越靠前越急，而 action_items 是按 priority 降序取的**（lib/db/cases 的
 * `ORDER BY priority DESC`，tools.ts 也写明「数字越大越急」）。所以第 0 条必须拿最大的数，
 * 直接用 i+1 会让驾驶舱「只推一件事」推出三件里最不急的那件——而它看起来完全正常。
 */
export function intakeActionPriority(total: number, index: number): number {
  return total - index;
}
