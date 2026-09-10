// app/src/lib/cases/timeline-kinds.ts
// 时间线事件类别词表。**单独一个文件、零 import**：与 stages.ts / milestones.ts 同一条理由——
// 领域注册表（lib/domains/registry.ts）要按这四个键校验各领域包声明的「事件类型」分组，
// 而注册表是被页面引用的；从 lib/cases/index.ts 取这个词表会连带把整个 lib/db 拖进浏览器包。

/** 与 migrate.ts timeline_events.kind 注释逐字对齐 */
export const TIMELINE_KINDS = ['公司动作', '我方动作', '系统动作', '期限'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];
