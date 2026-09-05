// app/src/lib/cases/drafts.ts
// 文书的领域常量与那段固定尾注。**站内对话与用户自己的 agent（MCP）共用这一份。**
//
// 【为什么搬出 lib/agent/tools.ts】「哪几类文书是要发给公司的」这件事决定的是
// 一道闸门：缺发送后果就拒收（charter 红线 5）。它此前只写在站内对话那一份里，
// 于是 MCP 那条入口要么抄一份（两份清单某天不一致，而闸门只认其中一份），
// 要么根本没有闸门——后一种的形态是：同一份《被迫解除通知》，用户在网页上写必须
// 附后果说明，用自己的 agent 写就不必，而两者最后都会被原样发给公司。
/** 与 migrate.ts drafts.kind 注释逐字对齐 */
export const DRAFT_KINDS = [
  '异议函', '被迫解除通知', '仲裁申请书', '证据清单', '答辩状', '上诉状', '谈判话术', '其他',
] as const;

export type DraftKind = (typeof DRAFT_KINDS)[number];

/**
 * 「会发给公司」的文书类型。charter 红线 5 只对这几类生效——
 * 谈判话术、证据清单是给用户自己用的，附一段「发出前请确认」纯属噪音。
 */
export const OUTBOUND_DRAFT_KINDS: ReadonlySet<string> = new Set([
  '异议函', '被迫解除通知', '仲裁申请书', '答辩状', '上诉状',
]);

/** charter §7.5 的固定尾注。措辞写死在代码里，不交给模型每次即兴发挥——
 *  这段话是用户按下「发送」之前看到的最后一道提醒，不能有的轮次强有的轮次弱。 */
export function confirmationFooter(consequences: string): string {
  return [
    '────────────────',
    '【发出前必读】',
    `1. 发出后果：${consequences}`,
    '2. 这份文书一旦发出即无法撤回，对方会据此形成书面记录并可能作为证据使用。',
    '3. 发出前请再读一遍全文：核对每个日期、金额与事实描述，删掉任何你并不打算承认的表述。',
    '4. 发不发、什么时候发、用什么方式送达，由**你自己**决定。本系统不会替你发出。',
  ].join('\n');
}

/**
 * 一份对外文书的正文该长什么样：正文 + 固定尾注。对内文书原样返回。
 * 两条入口都调它，省得「站内带尾注、MCP 不带」这种只在某一条路上看得见的分叉。
 */
export function draftBody(kind: string, content: string, consequences: string | null): string {
  return OUTBOUND_DRAFT_KINDS.has(kind) && consequences
    ? `${content}\n\n${confirmationFooter(consequences)}`
    : content;
}
