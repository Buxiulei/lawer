// app/src/app/_ui/AiGeneratedNotice.tsx
// 显式标识的**渲染件**（《人工智能生成合成内容标识办法》§4 第（一）项）。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量。前半截的字在 lib/ai-label.ts（法条要的那句，领域中立），
// 后半截由调用方从 DomainPack.copy.pages.aiLabelDisclaimer 取好了传进来。
// 由 app/__tests__/page-domain-guard.test.ts 机检。
// ─────────────────────────────────────────────────────
//
// 【为什么不用 hook 自己去问领域】这一件在**服务端**也要渲染（免登录分享页 /s/[token]
// 是 server component，问不到浏览器里的那套缓存）。做成 client-only 的形态是：
// 分享出去的那一份反而没有标识，而它恰恰是最容易被转发出去的那一份。
//
// 【为什么后半截糊、前半截不糊】低调模式（DESIGN.md RISK 1）把带案情的字整体糊起来。
// 前半截没有任何案情，糊掉它就与 §4「可以被用户明显感知到」直接冲突；
// 后半截带着行当（"不构成哪一种专业意见"一说就露），所以只有它进糊层。
import { AI_GENERATED_LABEL } from '@/lib/ai-label';

/**
 * 交互界面（对话页）上那一条的**定位类**：sticky 于消息列顶部，让开壳层顶栏那 56px
 * （ShellHeader 是 `sticky top-0` 的 `h-14`，两处必须对齐，否则这一条会被顶栏压住一半）。
 *
 * 【为什么它必须是 sticky，而不是排在消息列上方的一个普通块】
 * /terms/ai-labeling 第二节向用户承诺的是「消息列上方**持续可见**一条提示，
 * 不随对话滚走、不可关闭」——普通块只在滚到顶时看得见，聊过三五轮之后它已经滚出屏幕。
 * 那时页面上是一屏没有任何标识的模型输出，而协议页仍然写着它持续可见：
 * 两边都不报错，只有承诺与实现对不上（标识办法 §4「可以被用户明显感知到」也对不上）。
 *
 * 【为什么收成一个常量】它同时被 Workbench（用它）与判据（验它）读；
 * 各写一遍的形态是：改了一处、另一处的判据仍然绿着，而绿的是一个没人用的字符串。
 *
 * 【底色不能透明】sticky 之后正文会从它**底下**滚过去。`AiGeneratedNotice` 自带
 * `bg-secondary` 实色底与边框，所以这里只管定位，不碰皮肤。
 */
export const AI_NOTICE_STICKY_CLASS = 'sticky top-14 z-30';

/**
 * @param disclaimer 「所以它不是什么」——领域包给的那半句，不带句末标点。
 *   给空串时**只渲染法条要的那半句**：兜一句自己编的行当话，比缺那半句更糟。
 */
export function AiGeneratedNotice({
  disclaimer,
  className = '',
}: {
  disclaimer: string;
  className?: string;
}) {
  return (
    <p
      role="note"
      className={`rounded-[10px] border border-line bg-secondary px-3 py-2 text-[13px] leading-6 text-ink-2 ${className}`}
    >
      <span className="font-semibold text-ink">{AI_GENERATED_LABEL}</span>
      {disclaimer ? <span data-veil="">，{disclaimer}</span> : null}。
    </p>
  );
}
