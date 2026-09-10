// app/src/lib/agent/gate-marks.ts
// 出口闸留在正文里的五个标记、每个标记的一句话解释，以及「用户回一句什么就能推进」的那几句。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量（词表、阶段名、文书名、口径措辞）。
// 由 lib/capabilities/__tests__/registry-guard.test.ts 机检：写回来一个领域词就红。
// ─────────────────────────────────────────────────────
//
// 【为什么单开一个零依赖的叶子文件】三个闸各自持有自己的标记常量时，正文渲染层
// （app/(app)/case/[id]/_components/RichText.tsx）够不着它们——那三个模块各带上千行
// 纯函数（条号归一、引用块拼装），为五个字符串把它们拉进客户端包不值得，于是渲染层
// 手抄了一份字面。手抄的代价是：闸那边改了标记而渲染层没跟上，**标记原样摊在正文里、
// 没有任何样式**，看起来只是排版丑了一点，实际是用户读到了一句没有视觉降权的断言。
// 本文件零依赖，服务端与客户端都能引，手抄那一份因此撤掉了。
//
// 【为什么「一句话」与 chip 文案也在这里】禁令配出路（设计稿 §7.7）落到用户面上是三处：
// 正文里的标记（悬停解释）、提示行里的 notice 文案、一键回复 chip。三处说的是同一件事，
// 分三处各写一份的形态是——改了 notice 的措辞，标记的悬停解释还在讲上一版的做法，
// 而 chip 发出去的那句话又是第三种说法，三处都不会报错。

/** ⑤ 案号闸：验不过的案号在正文里换成这个（citation-guard.ts） */
export const UNVERIFIED_CITATION = '【案号待核实】';
/** ⑥ 条号闸：本轮没取到原文的条号后面缀这个（statute-guard.ts） */
export const UNVERIFIED_STATUTE = '【条号待核验】';
/** ⑥ 条号闸：来源登记簿标注已不是现行文本的（statute-guard.ts） */
export const SUPERSEDED_STATUTE = '【已修正，见新版】';
/** ⑨ 数值闸：不在任何来源里的数（value-guard.ts） */
export const VALUE_UNSOURCED = '【数值无来源】';
/** ⑨ 数值闸：与来源差一点点、像是抄错了一位的数（value-guard.ts） */
export const VALUE_MISMATCH = '【数值与来源卡不一致】';

/**
 * 一键回复 chip 的文本 —— **用户点一下就原样发出去的那句话**。
 *
 * 它同时被写进 notice 的出路句里（「回我一句『查一下这条』」），所以必须与 chip 逐字相同：
 * 提示行叫他说 A、chip 发出去的是 B 的形态是，用户点完之后回复答的是另一件事。
 */
export const SUGGEST_FIND_CASE = '找这个案例';
export const SUGGEST_CHECK_STATUTE = '查一下这条';
export const SUGGEST_FETCH_CURRENT = '取新版';
export const SUGGEST_RECALC = '帮我算一下';
export const SUGGEST_REPEAT_CALC = '把算式再说一遍';
export const SUGGEST_USE_CARD = '按卡里的数改一遍';

/** 五个标记的全集。渲染层按它切正文，判据按它逐字核对。 */
export const GATE_MARKS = [
  UNVERIFIED_CITATION,
  UNVERIFIED_STATUTE,
  SUPERSEDED_STATUTE,
  VALUE_UNSOURCED,
  VALUE_MISMATCH,
] as const;

export type GateMark = (typeof GATE_MARKS)[number];

/**
 * 标记 → 一句话「这是什么意思、你能做什么」。渲染层挂在标记的 `title` 上。
 *
 * 【为什么每一句都要带「回我一句 X」】只说「这一处待核实」是把问题丢回给一个本来就不懂的人：
 * 他既不知道真的条号是哪条，也不知道找谁去核。禁令配出路（设计稿 §7.7）。
 */
export const GATE_MARK_HINTS: Record<GateMark, string> = {
  [UNVERIFIED_CITATION]:
    `这里本来引了一个案号，本轮检索里没有它的原文，已经换成这个标记——别照抄；回我一句「${SUGGEST_FIND_CASE}」我去查。`,
  [UNVERIFIED_STATUTE]:
    `这一条的条号我这轮没取到原文，条号原样留着好让你自己去查；回我一句「${SUGGEST_CHECK_STATUTE}」我把原文取回来再引给你。`,
  [SUPERSEDED_STATUTE]:
    `这一条的来源已经不是现行文本，别再往正式材料里写；回我一句「${SUGGEST_FETCH_CURRENT}」我按登记簿里的新版原文重新引。`,
  [VALUE_UNSOURCED]:
    `这个数既不是这一轮算出来的，也不在来源卡里；回我一句「${SUGGEST_RECALC}」我按你档案里的数重算一遍。`,
  [VALUE_MISMATCH]:
    `这个数与来源差了一点（像是抄错了一位），以来源为准；回我一句「${SUGGEST_USE_CARD}」我照来源改。`,
};
