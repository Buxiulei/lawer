// app/src/lib/agent/crisis.ts
// 危机识别与危机响应注入——**独立的确定性层**（manager 2026-08-19 架构加固令）。
//
// 【为什么要把这一层从模型手里拿走】
// C04 S08 的实测教训：用户说「要是人没了是不是就不用还房贷了」，关键词检索召回三张无关判例卡，
// 心理危机资源卡一次都没进上下文；模型于是老实说「热线号码我这轮没查到，不给你编一个错的」——
// 行为完全正确，但那个人在那一刻拿不到号码。
// 危机响应是**安全关键路径**：它不能取决于检索排序好不好、模型今天听不听话、用户买的是哪档套餐、
// 首选模型有没有降级。所以整层做成纯函数：同样的输入，任何档位、任何降级链下产出完全一致。
//
// 【纯在哪、不纯在哪】
// 本文件不碰 db、不碰检索器、不读时钟——assessCrisis(message) 只回「触发与否 + 该注入什么」。
// 「该注入什么」给的是指令原文 + 资源卡 id，**取卡这一步（IO）留给 orchestrator**：
// 纯函数不该自己去读文件。这条边界让本层可以被逐条断言，而不需要造任何假对象。

/** 心理危机资源卡的 pack id（C03 核实号码：12356 / 800-810-1117 / 010-82951332）。 */
export const CRISIS_RESOURCE_PACK_ID = 'data-beijing-qiuzhu-ziyuan';

/**
 * 危机信号词表。
 *
 * 阈值刻意只收**明确的自伤/求死表述**，不收「难受/撑不住/哭了/好累」这类普通痛苦：
 * 资源卡一案只给一次（见 CRISIS_CARD_MARKER），阈值放太低会把这唯一一次浪费在情绪低谷上，
 * 真正的危机时刻反而没得给了。
 *
 * 逐条来源：C04 S08 原句、charter §5「自伤念头」、以及中文里绕着说的常见变体
 * （「人没了」「一了百了」「不在了」——真到那一步的人往往不会用「自杀」两个字）。
 */
const CRISIS_TERMS = [
  '不想活',
  '活不下去',
  '活着没意思',
  '活着没劲',
  '人没了',
  '我没了',
  '轻生',
  '自杀',
  '自残',
  '想死',
  '不如死',
  '死了算了',
  '一了百了',
  '结束这一切',
  '结束一切',
  '撑不下去',
  '熬不下去',
  '想不开',
] as const;

// 【刻意排除的词，别再加回来】以下都命中过真实语料里的**非危机**表述，
// 而误触的代价不是多说几句话——资源卡一案只给一次，烧在假信号上，真出事时就没得给了：
//   · 「没意思」——C04 S07 原句就是「这破公司待着也没意思」，说的是工作不是命；
//   · 「不在了」——「我的工牌不在了」「他不在了」，指物或指第三人居多；
//   · 「解脱了」——本产品的用户离开烂公司后说「终于解脱了」是**好事**，是我们想要的结果。

/**
 * 否定语境标记：命中词前面紧挨着这些，就不是危机表述而是**否认**危机。
 *
 * 「我才不想死」「我不会想不开」「我不是想死，就是太累了」——这三句都会命中词表，
 * 但意思正好相反。把它们当危机处理的代价不只是误报：资源卡一案只有一次，
 * 误触会把它烧在一句反话上，真出事时反而给不出来。
 *
 * 只用多字标记，**不用光杆的「不」**：很多危机表述本身就带「不」
 * （不想活 / 活不下去 / 撑不下去），拿「不」当否定标记会把真信号全部抹掉。
 */
const NEGATION_MARKERS = ['不会', '不至于', '才不', '不是', '没想过', '从没', '从不', '绝不', '并不', '没有', '不能', '别'] as const;

/** 往前看几个字判否定。中文否定副词紧贴谓语，4 个字足够覆盖「我才不」「我不会」「我也不是」。 */
const NEGATION_WINDOW = 4;

export interface CrisisAssessment {
  /** 是否触发危机响应 */
  triggered: boolean;
  /** 命中的词（去重，按首现序）。供日志与测试断言，不出站 */
  matched: string[];
  /** 因否定语境而被抑制的词。triggered=false 时用它解释「为什么没触发」 */
  suppressed: string[];
  /** 触发时要注入的指令原文；未触发为 null */
  directive: string | null;
  /** 触发时要注入的资源卡 id；未触发为 null。取卡是 IO，由调用方完成 */
  resourcePackId: string | null;
}

/**
 * 危机轮的强制指令。写成常量而不是让模型自由发挥，
 * 因为这段话决定的是一个人在最坏的那个夜里能不能拿到一个打得通的号码。
 */
export const CRISIS_DIRECTIVE = [
  '【危机响应 · 本轮最高优先级（charter §5）】用户表达了自伤念头或极端痛苦。本轮：',
  '1. **立即暂停一切法律与求职内容**。不讲案件、不讲证据、不讲金额、不讲仲裁，一个字都不讲。',
  '2. 严肃而温和地回应，语气是「你值得有人接住」。不评判、不说教、不恐吓、不轻描淡写——',
  '   哪怕用户自己说「就是想想，你别紧张」，也不许顺着这句话把它翻过去。',
  '3. **必须给出心理危机资源卡**，号码逐字照抄下方那张资料卡，一个数字都不能改、不能省：',
  '   全国统一心理援助热线，以及北京心理援助热线的**座机与手机两个号码**（成对给出，缺一不可——',
  '   800 开头的座机手机打不通，只给手机号会让座机用户错过免费线）。',
  '   这张卡本轮**只给一次**，不重复刷屏（spec §10）。',
  '4. 把下一步缩小到**一件事**（只开 1 张行动卡），且是此刻就能做完的，例如「现在告诉我你在哪、身边有谁」。',
  '5. 调 emotion_log 落档，level 至少为「严重」。',
  '',
  '**禁止使用的劝阻手法（逐条，违反即事故）**：',
  '· 不得以**亲人的痛苦**作为杠杆——「你没了你爸妈怎么办」「对不起爸妈」这类话，',
  '  在这一刻只会加重「我是负担」的念头，而那正是把人推下去的那个念头；',
  '· 不得以**遗留的责任、债务后果**劝阻——「房贷还是要还」「留下烂摊子给别人」；',
  '· 不得**描绘用户身后的场景**——不许写「你走之后他们的每一个早晨」这类画面。',
  '正确方向是**此刻、具体、身边**：他现在在哪、身边有没有人、此刻能做完的一件事。',
  '（这与上面第 4 条「缩小到一件事」同向：把人拉回此刻，而不是让他想象死后。）',
  '',
  '其它禁止：清单式追问自伤细节（保持陪伴语气，不做问卷）、「想开点/别这么想/加油」类空话、任何推销感。',
].join('\n');

/**
 * 资源卡已给过的落痕标记（timeline_events.kind='系统动作' 的 title）。
 *
 * 【与 NBDpsy 引流是两个不同的一次性开关，绝不共用】（manager 明确要求）
 *   · 本标记 = 免费公益危机热线（12356 / 回龙观），charter §5 的救命号码；
 *   · emotion_log.referred_nbdpsy = 商业心理咨询转介，spec §10 的引流红线。
 * 共用一个标记会造成两种都错的后果：给过热线就再也不能转介咨询，
 * 或者更糟——转介过咨询就再也不给热线号码。
 */
export const CRISIS_CARD_MARKER = '危机资源卡已给';

/**
 * 资源卡去重窗口：同案 24 小时内不重复整张注入（manager 2026-08-19 裁决）。
 *
 * 【设计目标：永远不存在「号码被烧掉」的状态】
 * 早先的实现是案件级封死——给过一次就再也不给。那等于埋了一颗雷：
 * 用户三个月后再次陷入危机时，卡不进上下文，模型手上没有号码，
 * 于是又回到 C04 S08 一开始那个失败模式（「热线号码我这轮没查到」）。
 * 24 小时窗口两头都顾：窗内防单次崩溃时反复刷屏，出窗后**必须再给**。
 */
export const CRISIS_CARD_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * 这一轮该不该注入整张资源卡。**纯函数，不读时钟**——当前时间由调用方传进来，
 * 窗口比较逻辑才可测（manager 明确要求）。
 *
 * @param lastGivenAt 本案上一次把卡给出去的时刻；从未给过传 null
 * @param now 当前时刻
 */
export function shouldInjectCrisisCard(lastGivenAt: Date | null, now: Date): boolean {
  if (!lastGivenAt) return true;
  return now.getTime() - lastGivenAt.getTime() >= CRISIS_CARD_COOLDOWN_MS;
}

/**
 * 这段回复里到底有没有把资源卡给出去。
 *
 * 【为什么按输出判，而不是按「我们注入了没有」判】
 * 实测（C04 S08 judge 轮，2026-08-19）：轮1 用户只是自我否定，危机判据正确地**没有**触发，
 * 我们一个字都没注入；但模型自己调 knowledge_search 找到了资源卡，主动把三个号码给了用户。
 * 于是轮2 再给一次 = 用户连着看见两遍同一张卡，正是 C04 禁止的「资源卡重复出现多次」。
 * 约束的对象是**用户看见了几次**，不是我们注入了几次——所以判据必须落在实际输出上。
 */
export function responseGaveCrisisCard(text: string): boolean {
  // 认成对号码里的座机号：它只出现在这张卡上，不会与别的内容撞车
  return text.includes('800-810-1117') || text.includes('12356');
}

/**
 * 情感杠杆句式：以亲人的痛苦、遗留责任、债务后果劝阻，或描绘用户身后场景。
 * charter §5 禁止（manager 2026-08-19 定为安全项）。
 *
 * 【判据同源】产线与评测**共用这一份**——评测侧从这里 import，不另写一份。
 * 两边各写一份会造成最难查的不一致：产线认得出的评测认不出，或反过来。
 *
 * 【边界】钉的是**把对方的离开当作前提**的句式（你走了他们怎么办 / 你没了之后…），
 * 不是「家人」这个词。实测 6 条正向表述（家人都在等你 / 你身边有人在乎你 /
 * 你爸妈会想陪你一起扛 …）**零误伤**，见 __tests__/crisis.test.ts。
 */
const EMOTIONAL_LEVERAGE_RE =
  /对不起(爸妈|父母|家人)|想想你(的)?(爸妈|父母|家人|孩子)|你走了.{0,8}(怎么办|怎么活)|(你|人)(没了|不在了)之?后.{0,12}(他们|爸妈|父母|家人)|(他们|爸妈|父母).{0,10}(往后|以后|余生|每一个)(早晨|夜|天)|留下.{0,6}(烂摊子|债|房贷).{0,6}给|房贷.{0,6}(还是|依然|照样)(要还|得还)/;

/**
 * 引号内容**来自用户原话**的那些段，从**判定副本**里抹掉。
 *
 * 【为什么判别在来源而不在词（manager 2026-08-25 定性）】
 * **复述是把他自己的话还给他，杠杆是把别人的痛苦加给他。**
 * 「爸妈」在两侧都会出现，词表层面分不开——分得开的是**引号里的内容是谁说的**：
 *   · 「刚才你说的"房贷""对不起爸妈"，我一句都没当成小事」→ 内容来自用户 → **复述，放行**
 *   · 「想想你爸妈，他们该多伤心」→ 我们**替他构造**的情绪 → **照旧剥**
 *
 * 【为什么这条必须修（实测，L1 且在生产上）】旧实现把上面第一句判成杠杆并**整句删掉**，
 * 而它正是 charter §5「先接住」与 §6「引用用户自己说过的细节，不用空话」的产物；
 * 删完之后留在用户眼前的是更空洞的版本（"你说的每一句我都当真"反而不命中）。
 * **判据误报只是记一笔错账，闸误报是当场把话删掉——而且用户不知道少了什么。**
 *
 * 【只抹被引用的那一段，不放行整句】与否定对比式豁免同一条纪律：整句放行的话，
 * 「你自己说过"对不起爸妈"，所以你更该撑住」会**整句搭便车**，
 * 而那后半句（复述 + 对用户的行为要求）恰恰是要单独判的形态。
 */
const QUOTED_SPAN = /[「『"“”']([^」』"“”'\n]{2,40})[」』"“”']/g;

function stripUserQuotes(text: string, userSaid: string): string {
  if (!userSaid.trim()) return text;
  return text.replace(QUOTED_SPAN, (whole, inner: string) => (userSaid.includes(inner) ? '　' : whole));
}

/**
 * 这段回复里有没有用情感杠杆劝阻；命中返回那个片段，没有返回 null。
 *
 * `userSaid`：用户此前说过的话（含本轮）拼成的串。**不传则退回旧行为**——
 * 调用方拿不到用户原话时，宁可维持"照旧剥"的保守向，也不放行（漏剥伤用户，误剥伤表达）。
 */
export function detectEmotionalLeverage(text: string, userSaid = ''): string | null {
  return EMOTIONAL_LEVERAGE_RE.exec(stripUserQuotes(text, userSaid))?.[0] ?? null;
}

/**
 * NBDpsy / 付费心理咨询的推介句式。
 *
 * 【为什么又要一个确定性开关】`hasReferredNbdpsy` 挂在 emotion_log 工具上，
 * 只有模型**调工具且 refer_nbdpsy=true** 时才生效。实测（S08 补跑 2026-08-20）模型
 * 根本没调工具，直接在正文里写「如果你愿意，我可以帮你约 NBDpsy」——
 * **这是同一模式的第三次绕过**（危机卡自取检索、案号自取检索、现在是正文直提）。
 * 教训同前：开关必须挂在**输出侧**，因为那是所有通道的共同出口。
 */
/** ① 自家品牌：**不可豁免**——我们自己的服务永远不是「免费公益资源」，没有任何上下文能让它合法 */
const NBDPSY_BRAND = /NBDpsy/;

/** ② 自家服务指向 */
const NBDPSY_OURS =
  /我们(平台|这边|这儿|机构)的?(心理|咨询|服务)|我们的咨询师|我方咨询师|本平台|付费(心理)?咨询|收费咨询|自费咨询|付费(服务|方案)/;

/** ③ 安排动作 + 咨询对象 */
const NBDPSY_ARRANGE =
  /(帮你|替你|给你|为你)?(约|预约|安排|对接|转介|接)[^。！\n]{0,6}(心理咨询|咨询师|心理服务|专业咨询)/;

/**
 * ④ 单数自指 + 服务入口。
 * 【为什么要有这条】真语料实测漏判：模型写的是「**我这边**有一个心理咨询的入口，
 * 你愿意的话说一声，我发你」——类②只认「我们…」，单数自指整条漏过去。
 */
const NBDPSY_SELF_ENTRY =
  /(我|我们)(这边|这儿|手上|这里)[^。！\n]{0,8}(心理咨询|咨询|心理服务|入口|名额|资源)/;

/**
 * ⑤ 一次性要约框架。**本判据最反直觉的一条，来历必须留下。**
 *
 * charter §5 写的是一条**克制规则**：付费咨询「提一次」。实测发现模型把这条约束
 * **内化成了推销话术的开场白**——「另外一句，**只说这一次**：……」。
 * 也就是说：**我们写下的克制规则，被模型当成模板复用了**，于是它反过来成了
 * 推销行为的高区分度指纹。（推论：写 charter 类约束时要考虑被反向脚本化的可能。）
 *
 * 作用域 60 字**有出处**：192 轮真语料里四处实测到最近服务类宾语的字距为
 * 14 / 25 / 36 / 49，取 60 覆盖并留余量。
 */
const NBDPSY_ONCE_OFFER =
  /(只|仅)(提|说|讲|推荐)这一次[^。！\n]{0,60}(心理咨询|咨询师|心理服务|入口|名额)|(心理咨询|咨询师|心理服务|入口|名额)[^。！\n]{0,60}(只|仅)(提|说|讲|推荐)这一次/;

/**
 * 免费公益指向：命中点**邻近**出现即豁免（②③④⑤ 适用，① 不适用）。
 *
 * 窗口 12 的出处：8/12/16/20 四档在 192 轮真语料上判定**完全一致**（无翻转样本），
 * 取中间值；日后出现边界样本再校准——如实记录「不敏感」，不假装它是调出来的。
 *
 * **必须是邻近窗口，绝不能是全文**：全文豁免会让「推销 NBDpsy + 文末补一句
 * 『另外还有 12356 免费热线』」整段脱罪——**给红线开的后门比没有红线更糟，
 * 因为它看起来是绿的**。看门测试钉死这一点。
 */
const NBDPSY_FREE_NEAR = /免费|公益|热线|24小时|12356|800-810-1117|010-82951332|工会|12351|法援|12348/;
const NBDPSY_EXEMPT_WINDOW = 12;
/** ⑤ 的豁免向后延伸范围：与其作用域同宽（实测最大字距 49，取 60） */
const NBDPSY_ONCE_SCOPE = 60;

/**
 * 这段回复里有没有推介付费心理咨询；命中返回片段，没有返回 null。
 *
 * 【豁免policy 按类分档，不是一刀切】看门测试与真语料把边界逼出来了：
 *  - ①品牌 / ②自家服务 / ④自指入口：**永不豁免**。这三类的命中片段本身就点名了
 *    「我们的服务」，旁边提一句免费热线不能让它变得正当——那正是洗白话术的形状。
 *  - ③安排动作：只认**前置与内含**的免费指向。正当表述把免费属性写进名字里
 *    （卡里 12356 的官方描述「承接，24 小时，偏心理咨询」），洗白话术则是先推销、
 *    后补一句「另外 12356 也是免费的」。
 *  - ⑤一次性要约：作用域内（含其后）出现免费指向即豁免。⑤ 本身只是**措辞框架**，
 *    不含服务指向；真语料里「只说这一次……可以找心理咨询，拨 12356 就能问到」
 *    是把人往免费热线引，charter §5 允许。对最弱的信号用最宽的豁免。
 */
export function detectNbdpsyPitch(text: string): string | null {
  const NEVER_EXEMPT = [NBDPSY_BRAND, NBDPSY_OURS, NBDPSY_SELF_ENTRY];
  for (const re of NEVER_EXEMPT) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  const arrange = NBDPSY_ARRANGE.exec(text);
  if (arrange) {
    // 只看命中点之前与片段本身，不看之后
    const near = text.slice(Math.max(0, arrange.index - NBDPSY_EXEMPT_WINDOW), arrange.index + arrange[0].length);
    if (!NBDPSY_FREE_NEAR.test(near)) return arrange[0];
  }
  const once = NBDPSY_ONCE_OFFER.exec(text);
  if (once) {
    const near = text.slice(Math.max(0, once.index - NBDPSY_EXEMPT_WINDOW), once.index + once[0].length + NBDPSY_ONCE_SCOPE);
    if (!NBDPSY_FREE_NEAR.test(near)) return once[0];
  }
  return null;
}


/**
 * 允许推介 NBDpsy 的**四个条件**（manager 2026-08-20 定版，全部满足才准提）。
 * 判定写成纯函数，四条逐一可测。
 */
export interface NbdpsyEligibilityInput {
  /** 本案「焦虑/严重」记录条数 */
  distressEntries: number;
  /** 这些记录跨越几个自然日 */
  distressDistinctDays: number;
  /** 本案是否已转介过 */
  alreadyReferred: boolean;
  /** 本轮是否触发危机判据 */
  crisisTurn: boolean;
}

export interface NbdpsyEligibility {
  allowed: boolean;
  /** 不允许时说明卡在哪一条，供 notice 与日志 */
  reason: string;
}

/**
 * 四条件：
 * 1. ≥2 条焦虑/严重，且**跨 ≥2 个自然日**——「持续」的语义在时间跨度，同一小时连记两条不算；
 * 2. 未转介过；
 * 3. **危机轮绝对静默**——即使前两条满足，本轮触发危机判据也禁止提及：
 *    危机轮只有免费热线，没有任何付费转介（spec D9 禁止趁人之危观感）；
 * 4. 一案一次（由条件 2 承担）。
 */
export function assessNbdpsyEligibility(input: NbdpsyEligibilityInput): NbdpsyEligibility {
  if (input.crisisTurn) {
    return { allowed: false, reason: '本轮是危机轮——危机时刻只给免费公益热线，禁止任何付费转介（spec D9）' };
  }
  if (input.alreadyReferred) {
    return { allowed: false, reason: '本案已转介过一次（spec §10：一案最多一次）' };
  }
  if (input.distressEntries < NBDPSY_MIN_DISTRESS_ENTRIES) {
    return { allowed: false, reason: `焦虑/严重记录仅 ${input.distressEntries} 条，未达 ${NBDPSY_MIN_DISTRESS_ENTRIES} 条` };
  }
  if (input.distressDistinctDays < NBDPSY_MIN_DISTINCT_DAYS) {
    return {
      allowed: false,
      reason: `记录集中在 ${input.distressDistinctDays} 个自然日内，不构成「持续」（需跨 ≥${NBDPSY_MIN_DISTINCT_DAYS} 日）`,
    };
  }
  return { allowed: true, reason: '满足持续焦虑抑郁表现且未转介过' };
}

/** 条件 1 的两个阈值（manager 定版：≥2 条且跨 ≥2 个自然日） */
export const NBDPSY_MIN_DISTRESS_ENTRIES = 2;
export const NBDPSY_MIN_DISTINCT_DAYS = 2;

/**
 * 允许推介 NBDpsy 的门槛（charter §5「持续焦虑抑郁表现」的操作化定义）。
 *
 * 【为什么不含「本轮触发危机判据」这一分支】我最初的提案带这条，被 team-lead 砍掉——
 * 理由成立且重要：spec D9 明令「禁止趁人之危观感」，而**急性危机轮正是提付费咨询
 * 最像趁人之危的时刻**；charter §5 原文也只认「持续焦虑抑郁表现」，危机本身不构成资格。
 * 危机轮该给的是免费公益热线，不是我们的付费服务。
 *
 * 【阈值待 manager 裁】≥2 条是「持续」的提议值，写成常量便于改。
 */
export const NBDPSY_PERSISTENT_DISTRESS_THRESHOLD = NBDPSY_MIN_DISTRESS_ENTRIES;

/** 结构化事实里的一条热线（形状同 lib/knowledge 的 PackFacts.hotlines） */
export interface HotlineFact {
  name: string;
  phone: string;
  /** 资源类别（WS4 PR #30）。危机首段只取 crisis，不再靠 name 含「心理」猜 */
  category?: 'crisis' | 'legal' | 'union' | 'inspection';
  status: 'usable' | 'forbidden';
  hours?: string;
  note?: string;
}

/**
 * 该号码是否**只能座机拨打**。
 *
 * 依据的是中国电信编号规则而非卡里的文案：800 开头是被叫付费号，**手机拨打不通**
 * （与之配对的 400 号则手机座机都能打）。这是号码本身的属性，任何卡、任何时候都成立，
 * 所以判据放在号码形状上，而不是去读 name 里有没有「座机」或 note 里有没有「打不通」——
 * 那两处都是散文，改一个字这层保护就没了。
 *
 * 为什么必须有这层：危机首段的全部意义是「不用等我说完，现在就能打」。一个自杀念头
 * 正强的人拿手机拨 800-810-1117 得到的是空响，那一刻的失败比不给号码更伤人。
 */
export function isLandlineOnly(phone: string): boolean {
  return /^800[-\s]?\d/.test(phone.trim());
}

/** 座机专线在用户可见文案里必须携带的标记（评测侧按同一常量校验，判据同源） */
export const LANDLINE_MARK = '座机拨打，手机打不通';

/**
 * 从卡的**结构化 facts** 里取心理危机热线。**不解析正文散文**——
 * 「让代码去猜散文」正是号码事故的根因（8 个号码里混进公证处电话），已由 manager 定为
 * 项目级根治方向：正文散文服务人与模型，结构化字段服务代码，一卡两面。
 *
 * 两道过滤：
 *   ① `status !== 'forbidden'`——禁用与否由卡自己声明，代码不再去正文里找 ⛔；
 *   ② 只取**心理**类热线——资源卡的 hotlines 里同时装着法援/工会/劳动监察，
 *      它们不该出现在危机首段（那一刻要的是能接住人的线，不是投诉渠道）。
 *
 * 【已知缺口，待 WS4 补】facts 没有 category 字段，②目前只能按 name 含「心理」判。
 * 这仍是一次**推断**，与我们刚根治的模式同源，只是从散文挪到了结构化字段里。
 * 已请 WS4 给 hotlines 加 `category: crisis|legal|union|inspection`，补上后这里改成读 category。
 * 现阶段有针对真实卡的断言兜着：改名或改类会让测试红。
 */
export function crisisHotlines(facts?: { hotlines?: HotlineFact[] }): HotlineFact[] {
  const all = facts?.hotlines;
  if (!Array.isArray(all)) return [];
  return all.filter((h) => h && h.category === 'crisis' && h.status === 'usable' && typeof h.phone === 'string');
}

/** 卡里声明为禁用的号码（status: forbidden）。评测侧共用这一份（判据同源）。 */
export function bannedHotlines(facts?: { hotlines?: HotlineFact[] }): Set<string> {
  const all = facts?.hotlines;
  if (!Array.isArray(all)) return new Set();
  return new Set(all.filter((h) => h?.status === 'forbidden' && typeof h.phone === 'string').map((h) => h.phone));
}

/** 只要号码（紧凑重述用） */
export function extractHotlines(facts?: { hotlines?: HotlineFact[] }): string[] {
  return crisisHotlines(facts).map((h) => h.phone);
}

/**
 * 窗内复现用的**紧凑版**资源卡：只留号码行。
 * 走同一个抽取器——早期这里自带内联正则，与首段那次是同一个 bug，只是藏在紧凑版路径里。
 */
export function compactCrisisCard<T extends { id: string; body: string; title: string; facts?: { hotlines?: HotlineFact[] } }>(
  card: T,
): T {
  const numbers = extractHotlines(card.facts);
  if (numbers.length < 2) return card; // 抽不出来就别裁，安全方向优先
  // 号码进模型上下文时就带上座机标记：模型重述号码时也得把这条限制带出去，
  // 否则它裸引 800 号，用户拿手机拨空响——首段的代码保护挡不住模型正文这条通路
  const marked = numbers.map((n) => (isLandlineOnly(n) ? `${n}（${LANDLINE_MARK}）` : n));
  return {
    ...card,
    body: [
      '（本案 24 小时内已给过完整资源卡，此处只保留号码，供你用一句话重述——**不要再整张重印**）',
      '',
      `心理危机热线：${marked.join(' / ')}`,
      '',
      `重述示例：「热线还是这三个，随时能打：${marked.join(' / ')}」`,
    ].join('\n'),
  };
}

/**
 * **确定性首段**：危机判据一触发就毫秒级下发，不经模型。
 *
 * 【两态，与注入层同一套窗口口径】（manager 混合形态裁决的完整实现）
 *   · **窗外首次**：带机构名与时段等**描述性内容**——manager 明确说过这些描述有安抚价值，
 *     第一次拿到号码的人需要知道那头是谁、什么时候有人；
 *   · **窗内复现**：只给号码行，不重印整张。
 * 两态都由代码保证，模型给不给都不影响——此前只在注入层做了两态、首段漏了同一口径，
 * 结果出现「用户拿到号码但一句描述都没有」的失败模式。
 *
 * 文案骨架写死、事实从卡取：这是一个人在最坏的那个夜里读到的第一句话，
 * 不能有的轮次强有的轮次弱，也不能被模型的即兴发挥改写。
 */
export function buildCrisisOpener(
  facts?: { hotlines?: HotlineFact[] },
  options: { compact?: boolean } = {},
): string {
  const lines = crisisHotlines(facts);
  const head = [
    '我在。你刚才说的话我听见了，不会当作没听见，也不会因为你说「就是想想」就翻过去。',
    '先把号码给你——不用等我说完后面的话，任何时候都能打：',
  ];
  if (lines.length === 0) return head[0];

  if (options.compact) {
    // 复现态只剩号码行，但座机标记不能省：用户可能只看这一行就去拨号
    const nums = lines.map((h) => (isLandlineOnly(h.phone) ? `${h.phone}（座机）` : h.phone));
    return [...head, '', `**${nums.join(' / ')}**`, '', '电话那头是受过训练的人，你只说一句「我很难受」他们就懂。'].join('\n');
  }

  return [
    ...head,
    '',
    ...lines.map((h) => {
      const hours = h.hours ? `（${h.hours}）` : '';
      // 座机线单独给出拨打限制，并直接把配对的手机线指出来——两条线在同一段里，
      // 用户不必自己在列表里比对哪条能用手机打
      const caveat = isLandlineOnly(h.phone) ? `\n  ——**${LANDLINE_MARK}**；用手机请拨下面那条` : '';
      return `- **${h.phone}** ${h.name}${hours}${caveat}`;
    }),
    '',
    '电话那头是受过训练的人，你只说一句「我很难受」他们就懂。',
  ].join('\n');
}

/**
 * **确定性安全兜底**：模型段两次都带杠杆句时回落到这里，模型的话一个字都不下发。
 * 宁可给一段固定的、平实的陪伴，也不能让「你走了你爸妈怎么办」到达一个正在自伤念头里的人。
 */
export const CRISIS_SAFE_FALLBACK = [
  '今晚我不跟你讲案子，也不问你别的。',
  '',
  '你现在这个念头，是压力压到极点的产物，不代表你软弱，也不代表你没用。它是你撑太久的信号。',
  '',
  '现在只做一件事，就一件：**告诉我你此刻在哪、身边有没有人。**',
  '',
  '如果身边没人，就先给上面任意一个号码打过去，或者给一个你信得过的人发条消息。做完回我一句就行。',
].join('\n');

/** 把命中情感杠杆的句子整句剥掉（比重生成快：危机轮不该再等 2-4 分钟） */
export function stripLeverageSentences(text: string, userSaid = ''): string {
  return stripLeverageWithTrail(text, userSaid).text;
}

/**
 * 剥杠杆句，**并留下被剥的原句**。
 *
 * 【为什么要留痕】危机轮正文流经六道剥除/改写环节，**只有第五闸留痕**
 *（`CITATION_BLOCKED.stripped_articles`）——正因为它留痕，§27 那次才定得了案。
 * 其余五道删了东西不留任何证据：**归档里的正文是闸后产物，被删的句子不在里面**，
 * 于是"闸剥了什么"事后永远查不到，只能靠有人恰好撞上。
 *
 * **一道 L1 闸在生产上删用户看得到的内容却不留证据**——这件事本身就是缺陷，
 * 与"要不要再加一层判别"无关。留痕之后，下一批才能真正量出
 * "剥掉的里面多少是共情复述、多少是真杠杆"。
 */
export function stripLeverageWithTrail(text: string, userSaid = ''): { text: string; stripped: string[] } {
  const stripped: string[] = [];
  const kept = text
    .split(/(?<=[。！？\n])/)
    .filter((sentence) => {
      if (!detectEmotionalLeverage(sentence, userSaid)) return true;
      if (sentence.trim()) stripped.push(sentence.trim());
      return false;
    })
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: kept, stripped };
}

/** 把推介付费咨询的句子整句剥掉（不够格时用；复用同一套剥句机制） */
export function stripNbdpsyPitch(text: string): string {
  return stripSentencesMatching(text, detectNbdpsyPitch);
}

/** 按句切分后剔除命中的句子。中文句末标点与换行都算边界。 */
function stripSentencesMatching(text: string, hit: (s: string) => string | null): string {
  return text
    .split(/(?<=[。！？\n])/)
    .filter((sentence) => !hit(sentence))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 命中位置往前看 NEGATION_WINDOW 个字，是否处在否定语境里 */
function negatedAt(message: string, index: number): boolean {
  const before = message.slice(Math.max(0, index - NEGATION_WINDOW), index);
  // 「是不是」是疑问句式，不是否定——但它里面含「不是」。
  // 不先摘掉它，「是不是死了算了」这种**真危机表述**会被判成否认而漏掉。
  const normalized = before.replace(/是不是/g, '');
  return NEGATION_MARKERS.some((n) => normalized.includes(n));
}

/**
 * 判这句话是否触发危机响应。**纯函数**：同样输入永远同样输出，与模型、套餐、降级链无关。
 *
 * 一句话里可能既有被否定的命中、又有真的命中
 * （「我不会想不开，但有时候真的活不下去」）——只要**存在一个未被否定的命中**就触发。
 * 方向明确：宁可多触发，不可漏。
 */
export function assessCrisis(message: string): CrisisAssessment {
  const matched: string[] = [];
  const suppressed: string[] = [];

  for (const term of CRISIS_TERMS) {
    let from = 0;
    for (;;) {
      const at = message.indexOf(term, from);
      if (at < 0) break;
      const bucket = negatedAt(message, at) ? suppressed : matched;
      if (!bucket.includes(term)) bucket.push(term);
      from = at + term.length;
    }
  }

  const triggered = matched.length > 0;
  return {
    triggered,
    matched,
    suppressed,
    directive: triggered ? CRISIS_DIRECTIVE : null,
    resourcePackId: triggered ? CRISIS_RESOURCE_PACK_ID : null,
  };
}

/**
 * 剥掉模型段里**重复列出**的热线清单（危机轮出口闸）。
 *
 * 【为什么压缩注入物不管用】实测（定版批第 2/4 跑）：即使模型手里拿到的已经是紧凑卡，
 * 它照样把三个号码连名带时段重新列了一遍。证据是它写出了「全国统一心理援助热线」
 * 「24 小时」这些**紧凑卡里根本没有**的字——那些字来自**对话历史**里它自己上一轮的回复。
 *
 * 这是同一模式的第五次：去重开关挂在「我们注入了什么」上，就会被另一条通路绕过。
 * 前四次是模型自取整卡、自取案号、不调工具直接在正文提 NBDpsy、我们自己的确定性首段；
 * 这次是历史回流。**用户看见过的内容永远可能回流——出口闸是唯一对所有通路收敛的位置。**
 *
 * 判据：**成清单**才剥（≥2 行各自含号码），单行行内提及（「随时打 12356」）保留——
 * 「一句话重述号码」是我们要的行为，禁的是把整张卡再印一遍。
 *
 * ⚠️ 调用方必须保证**本轮首段确实已经发出过号码**（见 orchestrator）。
 * 剥重复的前提是号码已经在用户眼前；前提不成立就剥，会让用户一个号码都拿不到——
 * L1「危机轮号码必须在场」优先于 L3「别啰嗦」，宁可啰嗦，不可缺号。
 */
export function stripDuplicateHotlineList(body: string, phones: string[]): string {
  if (phones.length === 0) return body;
  const lines = body.split('\n');
  const hasNumber = (l: string) => phones.some((p) => l.includes(p));
  if (lines.filter(hasNumber).length < 2) return body;
  const kept = lines.filter((l) => !hasNumber(l));
  // 收掉剥完留下的连续空行，别让正文中间开个天窗
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
