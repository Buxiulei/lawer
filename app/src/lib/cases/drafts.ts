// app/src/lib/cases/drafts.ts
// 文书的领域常量与那段固定尾注。**站内对话与用户自己的 agent（MCP）共用这一份。**
//
// 【为什么搬出 lib/agent/tools.ts】「哪几类文书是要发给公司的」这件事决定的是
// 一道闸门：缺发送后果就拒收（charter 红线 5）。它此前只写在站内对话那一份里，
// 于是 MCP 那条入口要么抄一份（两份清单某天不一致，而闸门只认其中一份），
// 要么根本没有闸门——后一种的形态是：同一份《被迫解除通知》，用户在网页上写必须
// 附后果说明，用自己的 agent 写就不必，而两者最后都会被原样发给公司。
import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

/** **缺省领域**的文书种类（正本在 DomainPack.docKinds）。拿得到案件的调用方按案件领域取。 */
export const DRAFT_KINDS: readonly string[] = DOMAINS[DEFAULT_DOMAIN].docKinds;

export type DraftKind = string;

/**
 * 「会交到对方手里」的文书类型（缺省领域；正本在 DomainPack.outboundDocKinds）。
 * charter 红线 5 只对这几类生效——给用户自己用的那几类附一段「发出前请确认」纯属噪音。
 */
export const OUTBOUND_DRAFT_KINDS: ReadonlySet<string> = new Set(
  DOMAINS[DEFAULT_DOMAIN].outboundDocKinds,
);

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
 *
 * `outboundKinds` 是这个案子所属领域的对外文书清单；省略时按缺省领域走。
 */
export function draftBody(
  kind: string,
  content: string,
  consequences: string | null,
  outboundKinds: readonly string[] = [...OUTBOUND_DRAFT_KINDS],
): string {
  return outboundKinds.includes(kind) && consequences
    ? `${content}\n\n${confirmationFooter(consequences)}`
    : content;
}

/** 尾注的稳定锚点：confirmationFooter 恒以这一行起头，1~4 条的措辞怎么变它都不动。 */
const CONFIRMATION_FOOTER_MARKER = '【发出前必读】';

/**
 * 剥掉 confirmationFooter 拼进正文的那段尾注（**导出 / 分享给对方之前**调）。
 *
 * 【为什么单独一个函数、要发出去的两条出口都调】尾注是写给起草人自己的提醒
 * （发出后果、能不能撤回、发不发由你定），落进 drafts.content 只为站内展示时提醒本人；
 * 它一旦随文书交到对方手里，就等于把自己的顾虑连同文书一起递了出去。各出口各写一段
 * 剥离逻辑的形态是：某天尾注措辞改了，只有其中一条出口跟着改，另一条把整段原样发出去。
 *
 * 认的是 `【发出前必读】` 那一行（连同它上面那行分隔线），措辞怎么变都剥得掉；
 * **没有尾注的正文一字不动地原样返回**（导出/展示对内文书时不能动它）。
 */
export function stripConfirmationFooter(content: string): string {
  const marker = content.indexOf(CONFIRMATION_FOOTER_MARKER);
  if (marker < 0) return content;
  // 回到标记所在行的行首
  const lineStart = content.lastIndexOf('\n', marker - 1);
  let cut = lineStart < 0 ? 0 : lineStart;
  // 行首之前若正好是一整行分隔线（只由 ─ 组成），连它一起去掉
  const prevLineStart = cut <= 0 ? -1 : content.lastIndexOf('\n', cut - 1);
  const prevLine = content.slice(prevLineStart < 0 ? 0 : prevLineStart + 1, cut).trim();
  if (prevLine.length > 0 && /^─+$/.test(prevLine)) {
    cut = prevLineStart < 0 ? 0 : prevLineStart;
  }
  return content.slice(0, cut).replace(/\s+$/, '');
}
