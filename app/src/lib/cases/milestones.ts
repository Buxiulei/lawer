// app/src/lib/cases/milestones.ts
// 案件里程碑词表。**单独一个文件、零 import**，理由与同目录的 stages.ts 逐字相同：
// 领域包（lib/domains/labor.ts）与驾驶舱轨道（客户端）都要读它，
// 而这两处任意一处引 lib/cases/index.ts，都会把整个 lib/db 拖进浏览器包。
//
// 【为什么要从 index.ts 搬出来】搬之前这份八段在仓库里有**两份**：
// index.ts 的 CASE_MILESTONES（服务端校验用）与驾驶舱 _components/milestones.ts 的
// FULL_JOURNEY（页面画轨道用）。两份的失效形态是——改了一份、另一份仍然绿着，
// 而页面上那条轨道与库里认的里程碑从此各说各话。搬到这里之后两处都引这一份。

/**
 * 案件里程碑（批 6 驾驶舱，契约 docs/contracts/case-milestone.md §三）。
 *
 * 【为什么不是 CASE_STAGES 的子集】里程碑是**只追加的既成事实**，stage 是**可变可回退的
 * 当前态**，是两种东西（契约 §二）。早先按子集写过一稿，撞上死结：第一格「协商」在
 * CASE_STAGES 里没有对应值（那段被拆成 风声/约谈中/已收通知/已解除 四个更细的值），
 * 只能拿 `约谈中` 当键——于是「公司不谈直接解除」的案子库里会留下一条从没发生过的约谈。
 * 而且 `Extract<CaseStage, …>` **fails open**：把 CASE_STAGES 里某个值改名，
 * 里程碑联合会**静默少一员，tsc 退出码 0 一句话不报**（2026-08-28 本仓实测）——
 * 一个防词表漂移的机制，自己的失效方式就是静默漂移。改成独立联合 + index.ts 那张全量表，
 * 漏键报 TS2741、错值报 TS2322，**两个方向都红**。
 */
export const CASE_MILESTONES = [
  '协商',
  '仲裁申请',
  '立案',
  '开庭',
  '裁决',
  '一审',
  '二审',
  '执行',
] as const;

export type CaseMilestone = (typeof CASE_MILESTONES)[number];
