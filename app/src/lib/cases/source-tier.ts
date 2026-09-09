// app/src/lib/cases/source-tier.ts
// **来源四档与断言人**（设计稿 §2 A3 / §4.2-1）：档案里每一条事实的「这话是谁说的、有多硬」。
//
// 【为什么必须是类型，不是提醒】「自述 ≠ 书证」这件事此前只活在事实卡的几句渲染文案里
// （〔用户自述待核实〕是**整段**贴上去的，不是逐条从数据推出来的）。那种形态下：
//   · 一条由证据提取写进来的事件，与一条用户随口说的事件，在库里长得**完全一样**；
//   · 渲染器只能按"这一整区大概都是自述"去猜，猜错时没有任何一处会报错；
//   · 于是"你有书证"与"你只是这么说"在模型眼里是同一件事，而这正是仲裁庭上唯一要紧的分别。
// 所以四档落成库里的列、渲染由数据推出、要件三态由档位程序推导（见 ./elements.ts）。
//
// 【本文件零依赖】它被 lib/db（建表注释对齐）、lib/cases（写入口）、lib/agent（渲染）
// 与 lib/agent/calc（InputSource 收成子集）同时引用。一旦它 import 了任何东西，
// calc → cases → agent → calc 这条环就会成形；零依赖是这条边界的机械保证。
//
// 【领域中立】四个档位讲的是「这条事实的证明力从哪来」，与行当无关：
// 书证、对方认可、裁审认定在任何一种纠纷里都是同一件事。**不许**往这里加任何行当名词。

/**
 * 来源四档，**由弱到强排列**（顺序即证明力顺序，比较一律经 tierRank，不要按下标手算）。
 *
 * · 自述     —— 当事人口述落档，没有第三方支撑。**默认档**：说不清来源的一律落这里。
 * · 书证     —— 有落库证据支撑（合同、流水、聊天记录、通知原件……）。
 * · 对方认可 —— 对方书面承认过。**单列一档**是因为它改变的是举证负担：
 *               对方认了的事实，用户不必再证（design §4.2-1）。
 * · 裁审认定 —— 仲裁委/法院在本案或关联案里认定过。
 */
export const SOURCE_TIERS = ['自述', '书证', '对方认可', '裁审认定'] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

/**
 * 这条断言是**谁写进档案的**。与档位正交：同一条「书证」既可能由用户自己登记，
 * 也可能由内容提取写入；同一条「自述」既可能是用户在网页上打的字，
 * 也可能是他自己的 agent 替他推断出来的。
 *
 * · user           —— 用户本人（网页登录态）。
 * · agent_inferred —— 用户自己的 agent 经 API 写入。**它推断出来的东西不是用户说过的话**，
 *                     展示层据此标黄（设计稿 §4.4-5）。
 * · doc_extract    —— 由证据内容提取产出（读过文件之后写下的）。
 * · system         —— 服务端规则产出（推算的期限、系统默认值……）。
 */
export const ASSERTED_BY = ['user', 'agent_inferred', 'doc_extract', 'system'] as const;
export type AssertedBy = (typeof ASSERTED_BY)[number];

/**
 * 缺省档位。**存量数据一律回填这一档**（migrate.ts 的 DDL 默认值取同一个字面量）。
 *
 * 【为什么缺省是最弱的那一档，而不是「未知」】「不知道有多硬」在推理里与「很硬」无法区分——
 * 模型看到一个它不认识的档位，只会当它不存在，于是这条事实照常被当成已坐实的。
 * 往弱处默认是**可以说出口的谎的反面**：多标一条待证，代价是用户多补一张证；
 * 少标一条待证，代价是他带着一句没有支撑的话上庭。
 */
export const DEFAULT_SOURCE_TIER: SourceTier = '自述';
export const DEFAULT_ASSERTED_BY: AssertedBy = 'user';

/** 由证据内容提取写进档案的那条路：档位与断言人**成对**固定（设计稿 §4.2-1）。 */
export const DOC_EXTRACT_ORIGIN: { tier: SourceTier; assertedBy: AssertedBy } = {
  tier: '书证',
  assertedBy: 'doc_extract',
};

/**
 * 档位的强弱序号（0 最弱）。**比较证明力只经这个函数**：
 * 散着写 `tier === '书证' || tier === '对方认可' || …` 的形态是——加第五档时漏掉某一处，
 * 那一处把新档位判成"比自述还弱"，而它读起来完全正常。
 */
export function tierRank(tier: SourceTier): number {
  return SOURCE_TIERS.indexOf(tier);
}

/** 「书证及以上」——要件三态里 `成立` 的门槛（设计稿 §2 A3）。 */
export function isDocumented(tier: SourceTier): boolean {
  return tierRank(tier) >= tierRank('书证');
}

/**
 * 库里读回来的字符串归一成档位。**认不出来的回 null，不回缺省档**：
 * 悄悄折成「自述」的形态是，一个写坏的值与一条真的自述事实在读侧完全同形，
 * 于是没有任何一处会发现库里有脏数据。调用方自己决定认不出时怎么办。
 */
export function normalizeSourceTier(v: unknown): SourceTier | null {
  return typeof v === 'string' && (SOURCE_TIERS as readonly string[]).includes(v)
    ? (v as SourceTier)
    : null;
}

export function normalizeAssertedBy(v: unknown): AssertedBy | null {
  return typeof v === 'string' && (ASSERTED_BY as readonly string[]).includes(v)
    ? (v as AssertedBy)
    : null;
}

/**
 * 事实卡上每条事实的档位后缀（设计稿 §4.2-2）。**由数据推出，不在渲染时猜**。
 *
 * 形态固定四种 + 一种缺失：
 *   〔自述〕〔书证#12〕〔对方认可·timeline#8〕〔裁审认定〕〔未记录〕
 *
 * @param tier 档位；**null = 档案里根本没有这一项**，渲染成〔未记录〕。
 *   〔未记录〕与〔自述〕的分别是这套东西的全部意义所在：前者是"没有这条事实"，
 *   后者是"有这条事实、但只有一个人的说法"。合成一种的形态是——
 *   模型把〔未记录〕读成"没有/不适用/时效没问题"（设计稿 §1.2「未记录误判」那一行）。
 * @param ref 锚点（证据 id、时间线锚……）。给了才带；不给只渲档位本身，不编一个占位。
 */
export function tierMark(tier: SourceTier | null | undefined, ref?: string | number | null): string {
  if (tier == null) return '〔未记录〕';
  const anchor = ref === undefined || ref === null || `${ref}`.trim() === '' ? null : `${ref}`.trim();
  if (anchor === null) return `〔${tier}〕`;
  // 书证的锚点是一条**证据行的 id**（#12 读作"第 12 件材料"）；其余档位的锚点是一句
  // 带表名的定位（timeline#8），两者的分隔符故意不同——一眼能看出该去哪儿翻。
  return tier === '书证' ? `〔${tier}#${anchor}〕` : `〔${tier}·${anchor}〕`;
}

/**
 * 「这几组事实里，一条书证及以上的都没有」——**取证闸的判据只有这一份**。
 *
 * 【为什么收成一个函数】它有两个读者：事实卡首行那句话（读侧，lib/agent/case-facts）
 * 与强制取证行动卡的落卡条件（写侧，lib/cases）。两处各写一遍 `some(isDocumented)` 的形态是：
 * 某一处把判定写反或漏了归一，于是卡上说"你没有书证"、而行动卡不落（或反过来），
 * 两处各自看都正常。
 *
 * @param groups 若干组带档位的行。**空组（一行都没有的那一组）不参与判定**——
 *   由调用方先滤掉：一个还没登记任何诉求的案子，不该因为"诉求组里没有书证"被催取证。
 * @returns 有任何一行到达书证及以上 ⇒ false（不开闸）。全部组都为空时也回 false。
 */
export function noDocumentedFact(
  groups: readonly (readonly { source_tier: string }[])[],
): boolean {
  const rows = groups.flat();
  if (rows.length === 0) return false;
  return !rows.some((r) => {
    const tier = normalizeSourceTier(r.source_tier);
    return tier !== null && isDocumented(tier);
  });
}

/**
 * 算钱器 `InputSource` → 来源四档的**收敛映射**（设计稿 §4.2-1「calc 的 InputSource 收成子集」）。
 *
 * 【为什么不是把 calc 那三个值直接换掉】那三个字面量已经落在 claims.calc_json 里、
 * 印在用户看过的算式说明里、钉在算钱器的判据基线里。换字面量会同时改动**历史数据的语义**
 * 与**对外承诺的措辞**，而这一票要改的只是"它们各自属于哪一档"。所以字面量原样保留，
 * 由这张表把它们收进四档体系——两边从此只有一份枚举，不会各自漂移。
 *
 * · 用户自述 → 自述
 * · 证据佐证 → 书证
 * · 系统默认 → **null**：它根本不是一条案件事实（是社平工资、最低工资这类服务端取的口径值），
 *   给它安一个档位就是把"系统查表查来的"伪装成"当事人这边的证明力"。
 *   它的正确归属是 asserted_by=system，而 asserted_by 与档位正交。
 */
export const CALC_INPUT_SOURCE_TIER = {
  用户自述: '自述',
  证据佐证: '书证',
  系统默认: null,
} as const satisfies Readonly<Record<string, SourceTier | null>>;

/** 算钱器的输入来源标签。**取值集合的正本在上面那张表的键上**，calc 只再导出一次。 */
export type CalcInputSource = keyof typeof CALC_INPUT_SOURCE_TIER;

/** 算钱器输入来源对应的档位；系统取值（系统默认）没有档位，回 null。 */
export function tierOfCalcInputSource(source: CalcInputSource): SourceTier | null {
  return CALC_INPUT_SOURCE_TIER[source];
}
