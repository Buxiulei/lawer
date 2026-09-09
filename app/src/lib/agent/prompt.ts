// app/src/lib/agent/prompt.ts
// system prompt 组装（manager 契约）：charter 全文 + 案件事实卡 + 检索到的 packs 逐字原文。
//
// 【顺序：按「变得多快」分段，但**首要位留给危机与空包**】(2026-09-10 提示缓存前缀改)
//   ① 静态段：charter 全文 + 输出纪律 + 闭合清单段。**同一领域逐字恒定**，
//      不含日期、案件 id、用户名、随机序——它就是提示缓存的前缀。
//   ② 首要位：危机指令与空包指令（**只在那几轮出现**，其余轮为空串）。
//   ③ 半静态段：本案本轮检索到的 packs 逐字原文，按卡 id 排序（同一批卡的渲染顺序恒定）。
//   ④ 动态段：运行环境（含当前时刻）、案件事实卡、问诊/前情提要。
//
// 【为什么改这个顺序·中转账单实测】改之前是「charter → 本轮指令 → 事实卡 → 输出纪律 →
// 闭合清单 → packs」：**每一轮变的那几段夹在恒定的几段中间**。上游按前缀缓存，
// 前缀在第一个变动处就断了，于是账单每轮记 3–27 万 token 的「缓存写」、几乎零「缓存读」——
// 我们每轮都在为同一段 charter 重新付一次全价，而三处（请求、账单、日志）都不会报错。
// 把恒定的几段全部提到最前，**逐字节稳定的前缀从 2905 字（charter 一段）变成 5790 字**
//（缺省领域实测），本案 packs 还在它后面另占一个断点。
//
// 【事实卡挪到静态段之后，是这次改动明说的代价】原注释写着「案件事实卡在中间，因为它是
// charter 各条纪律的作用对象」。现在它仍然**先于用户消息**、仍然在 system prompt 里，
// 只是排到了静态段与 packs 之后——**位置变了，在场性没变**。这一条口径变更由 2026-09-07
// 台账「提示缓存前缀稳定化」派单裁定，判据侧同步换向：case-facts.test.ts G-F7。
//
// 【危机指令与空包指令留在首要位·2026-09-10 裁决】它们一度跟着事实卡一起被挪到 packs
// 之后（理由是「紧挨生成点」），现在**改回紧接静态段之后、packs 之前**。
//   · 为什么：**primacy 优先于 recency**。这两段改写的是「这一轮到底该干什么、能引什么」
//     这个前提——危机轮要压过问诊清单与依据纪律，空包轮要在模型读到「法条给条号 + 逐字原文」
//     那句抬头**之前**就把「你手上没有依据」立住。recency 那条理由是从 packsSection 的
//     noteAfter 实测借来的（「别重印整张卡」贴着卡下发才管用），但那是**一句针对某张卡的
//     限制**，与「整轮的前提」不是同一类指令；把一处实测结论推广到另一类指令上，
//     **在没有真模型对照跑之前就是猜**。而这两条的错误代价不对称：危机轮说错话不可逆，
//     缓存多写一次只是账单贵一点。不确定时按代价小的那边站。
//   · 代价（明说）：危机轮与空包轮里，packs 段的前缀被这一段顶开，那几轮的 **packs 缓存
//     作废**。危机轮很少，空包轮本来就没什么卡可缓存——用那几轮换指令的首要性，划算。
//   · **不受影响的是**：静态段仍逐字节稳定（这两段在它之后），第一断点不变；
//     第二断点仍落在 packs 段末尾。
//   · 判据侧同步：orchestrator.test / empty-pack.test 的位序断言、prompt-prefix-stability
//     的危机轮那一条。
//
// 【不做的事】本文件不做任何摘要、压缩、改写。档案是事实，packs 是法条原文，
// 任何一处「为了省 token 而转述」都会以「模型把转述当原文引用」的形式变成可信度事故。

import { factsCardOf } from './facts-entry';
import { extractHotlines, isLandlineOnly, LANDLINE_MARK } from './crisis-opener';
import { CHARTER } from './charter';
import { intakeDirective, recapBrief, type IntakeStage } from './intake';
import { renderLawyerMandatory } from './lawyer-mandatory';
import { MAX_ACTION_CARDS } from './tools';
import { domainPackOrDefault, type DomainPack } from '@/lib/domains/registry';
import { coreArticleKeys, packCitationGuide, type CoreArticleSources } from './citation-block';
import type { KnowledgePack } from './retrieval';
import type { CaseSnapshot } from './snapshot';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 北京时间的可读串 + ISO8601 串。
 *
 * 为什么必须给：charter §2 要求行动卡的截止时间具体到当天与句子级，action_card 又要求
 * due_at 是 ISO8601。模型不知道「今天几号」就只能编一个日期，那张卡的截止时间就是错的。
 * 给 +08:00 而不是 UTC，是因为用户说的「今天下班前」指的是北京时间的今天。
 */
export function beijingNow(now: Date): { readable: string; iso: string } {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}`;
  const time = `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
  return {
    readable: `${date}（周${WEEKDAYS[bj.getUTCDay()]}）${time}`,
    iso: `${date}T${time}:00+08:00`,
  };
}

/** 检索到的 packs 逐字原文段。
 *  noteAfter：紧贴某张卡的正文之后追加一条指令——模型对**邻近**指令的依从性明显好于
 *  放在通用指令区的同一句话（实测：危机轮「别重印整张卡」写在开头时被无视，卡给了两轮）。
 *
 *  【渲染顺序按卡 id 排，不按检索名次】(2026-09-10 提示缓存前缀改) 同一案连着两轮
 *  召回同一批卡是常态，而名次会因为一个词的权重微调而互换——**同样的几张卡、不同的顺序**
 *  在上游眼里就是不同的前缀，缓存整段作废。按 id 排之后，这一段对同一批卡逐字恒定。
 *  排序只作用于**渲染**：核心条取料（coreArticleKeys 的 S2 检索序补足）拿的仍是
 *  调用方传进来的原序（见 buildSystemPrompt），两者不共用这一份数组。
 *  比较用裸 `<`（码位序），不用 localeCompare——后者随运行环境的 locale 变，
 *  那正是这一段要消灭的那种「看起来一样、字节不一样」。 */
export function packsSection(
  packs: KnowledgePack[],
  noteAfter?: { packId: string; note: string },
  coreArticles: Set<string> = new Set(),
): string {
  if (packs.length === 0) return '';
  const ordered = [...packs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const blocks = ordered.map((p) =>
    [
      `### [${p.id}] ${p.title}`,
      `类型：${p.type}｜适用地区：${p.region}｜可信度：${p.confidence}｜更新于 ${p.updated}`,
      '',
      p.body,
      // G4：引用要求**逐卡贴附**，不放段落抬头。抬头那句"法条给条号+逐字原文"一直都在，
      // 而 G4 在定版批 6/6 全挂——指令离约束对象太远就被稀释，这是第三次同型。
      // 内容是拼好的引用块（照抄比缩写省力），拼不出来时给填空模板。
      '',
      packCitationGuide(p, coreArticles),
      ...(noteAfter && noteAfter.packId === p.id ? ['', `> ⚠️ **本卡使用限制**：${noteAfter.note}`] : []),
    ].join('\n'),
  );
  return [
    '## 本轮检索到的依据（逐字原文，引用时照抄，不要改写）',
    '',
    '引用纪律：法条给条号 + 逐字原文；判例给案号 + 来源；数字给值与生效期间。',
    '可信度标「待核实」的卡，引用时必须把这个状态一起告诉用户。',
    '下面没有的条号、案号、文号、数字，一律视为你不知道——需要就再调 knowledge_search，检索不到就说「需要核实」。',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}

/**
 * 本轮注入包里那张**危机资源卡**上的可用号码，已带座机标记。
 *
 * 【为什么从卡里抽而不是从任何一处文案里读】号码只有一个真源：卡的结构化 facts。
 * 卡上标 forbidden 的号码在 extractHotlines 那一层就被滤掉了，所以这条路径
 * **不可能**把一个被禁的号码递给领域包（评测官 08-26 查实的那条出口闸同源）。
 * 卡不在本轮注入包里时回空数组——由领域包自己决定这时说什么。
 *
 * 标记口径与窗内紧凑卡（lib/agent/crisis.compactCrisisCard）逐字相同：同一轮里
 * 两处印同一批号码，格式不一致的形态是模型以为那是两组不同的号码。
 */
function markedCrisisNumbers(packs: KnowledgePack[], resourcePackId: string): string[] {
  const card = packs.find((p) => p.id === resourcePackId);
  return extractHotlines(card?.facts).map((n) => (isLandlineOnly(n) ? `${n}（${LANDLINE_MARK}）` : n));
}

/** 输出纪律段：把 charter 里几条能机械判定的要求，翻译成「本轮具体该调哪个工具」。 */
function outputDiscipline(): string {
  return [
    '## 本轮输出纪律（硬性）',
    '',
    `1. **行动卡**：回复必须以「现在做什么」收口，调用 action_card 产出 1-${MAX_ACTION_CARDS} 张。`,
    '   一张卡 = 做什么(what) + 怎么做(how，含可照读原句) + 为什么(why，一句带依据) + 截止时间(due_at)。',
    '   用户情绪崩溃时只给 1 张，把下一步缩小到一件事（charter §5）。',
    '   **卡只能由 action_card 产出，且要等它真的返回成功**：工具没调、或调了没成，',
    '   就绝不许在正文里写「行动卡已挂上」「已记进档案」「系统会按截止时间提醒你」——',
    '   用户点开档案看不到卡，那句话就是骗他（实测：正文说「两张行动卡已挂上」，档案里 0 张）。',
    '   在正文里列一串编号步骤**不等于**挂了行动卡，那只是正文。',
    '2. **落档**：用户这轮说出来的新事实当轮落库，不要只写在正文里——',
    '   事件 → timeline_add；金额要素 → claims_upsert；公司主体 → company_profile_upsert；情绪 → emotion_log。',
    '   正文里说「已经帮你记下了」而没调工具，等于没记。',
    '3. **依据**：任何条号、案号、文号、金额标准、社平/最低工资数值，只能来自 knowledge_search 的返回。',
    '   凭记忆写出来的一律算编造（charter §7.1）。检索不到就明说「这点我需要核实，先按保守做法……」。',
    '4. **金额**：一切计算走 claim_calc，禁止心算——分段与三倍封顶你算不对，错的金额会写进仲裁申请书。',
    '   展示结果时必须带上它返回的 formula 算式，并逐项说明哪些输入是「用户自述待证」。',
    '5. **文书**：draft_write 起草；发给公司的文书必须同时给 send_consequences，且要在正文里明说',
    '   「发不发由你决定，我不会替你发出」（charter §7.2、§7.5）。',
    '6. **不可逆动作**：签字、辞职、接受方案、拒签、发出通知、公开发声——凡是做了就收不回的，',
    '   你只做两件事：把利弊摆开、给出你的倾向。**最后必须有一句明确把决定权交回用户**，',
    '   例如「签不签由你决定」「看完这几条你再决定」。分析写得再充分，缺这一句就是替用户拍板。',
    '   （charter §7.2。这条不限于文书——S03 实测：整段把签与不签的后果讲透了，却从头到尾',
    '   没有一句交还决定权，读起来就成了「我已经替你判了」。）',
    '7. **冲动前兆的拦截对象**：要拦的是**不可逆动作本身**——发出去、签字、递交、辞职、转账；',
    '   **不是它的准备工作**——写文案、想措辞、查资料、问我意见都不必拦，那些恰恰是该鼓励的冷静步骤。',
    '   「先别急着**发**」是拦截；「先别急着**写**」不是，写完不发没有任何损失。',
    '   讲清后果、给替代动作、把决定权交还——这些都属于**拦截之后**的事，**不能替代拦截本身**：',
    '   一段话把「发出去会被公司反用作证据」讲得再透，只要没有明确说出「先别发」，就没有拦住。',
    '   （与第 6 条同族：都是对不可逆动作的处置纪律。）',
    '8. **可照读原句**：凡是用户接下来要**对公司开口或动笔**的场合（催签、约谈、拒签、请假、要书面说明），',
    '   都要给一句**可以直接照着念、不用改一个字**的话，单独成行加引号。charter §6 要的是句子，不是策略描述——',
    '   「你可以表达一下需要考虑的意思」是废话；「这份我先带回去看看，明天上午给您答复」才是能用的。',
    '   同时标一句「哪些话绝不能说」（如别说"我不干了"、别说"随便你们"）。',
    '9. **被要求做不该做的事时**：明确说「不」，把理由落在**用户自己的利害**上，不评价他的人品。',
    '   「这个我不编」+「编的案号一旦被识破，你后面所有真话都会被当成假的」——这是帮他；',
    '   「你这样不对」「做人要诚信」是训人，**说教会让他觉得你站在对面**，而你必须站在他这边。',
    '   拒绝之后立刻给**更好用的真东西**（真实条文/案号），让他明白拒绝不是不帮忙。',
    '10. **引判例**：判例段**只复述卡里写的**（案情要旨/争议焦点/结果/裁判理由），',
    '   用户自己的情况——时间、岗位、薪资、公司怎么做的——**一个字都不许写进判例案情**。',
    '   要讲相似点就另起一句：「你的情况与之相似之处是……」，把判例事实与你的事实分开摆。',
    '   （实测事故：引的是真案例，却把用户的「次日报到」「未明确新岗位及薪资待遇」写进了案情。',
    '   **案号是真的、细节是编的**——用户当庭复述，对方一查全文没有该情节，失信的是用户自己。）',
    '11. **格式**：短句、编号、直给。不写「以上仅供参考」「建议咨询专业律师」这类话（charter §1、§7.7）。',
  ].join('\n');
}

/**
 * 【空包告知指令】本轮**没有一张卡够格被引用**时注入，**只在空包轮出现、不常驻**。
 *
 * 【为什么"禁令必须配出路"（manager 定调）】只禁不给替代时，模型面对"用户提问 + 不许引用"
 * 只剩两条路：**编造**（L1 红线）或**沉默**（无用）。所以指令的后半段把这一轮
 * 明确改写成**问诊轮**——那本来就是 charter §4 的合法动作，不是新发明。
 * 一条"只拦不给替代"的规范，最省力的满足方式就是什么都不答（A1 双问的反面教材）。
 *
 * 【为什么点名"用户会拿去谈判或写进申请书"】给禁令一个**理由**而不是只下命令：
 * 只有理由成立，模型在边界情形才知道往哪边靠（charter §2 同款做法）。
 *
 * 【与第五闸的关系：同一条防线的事前版】闸是**事后剥**（引号内引用对不上本轮注入 → 剥掉改口）；
 * 本指令是**事前禁**（根本没有注入 → 先说清别引）。两者不重复，**闸不撤**——
 * 防线不撤，真正的修法是给料（召回）。
 *
 * 【一个必须避免的副作用】模型可能学会在**非空包轮**也说"我需要先核实依据"，
 * 退化成什么都不答。两条防线：①本指令**条件触发不常驻**；②判据侧配对——
 * 非空包轮说"需要先核实"却**手上确实有该条卡**时应判缺陷（该给的没给）。
 */
export const EMPTY_PACK_DIRECTIVE = `## 【本轮无可引用依据】

这一轮没有检索到任何可引用的知识卡。你手上**没有**法条原文、判例、社平工资/最低工资等数字。

因此这一轮：
- **不要**给出法条条号、判例案号、任何具体数字或期限天数——你手上没有它们的出处，
  凭印象写出来的每一个数字，用户都会拿去谈判或写进申请书。
- **可以并且应该**做这些事：
  1. 把用户这一轮说的事实接住、复述确认（尤其时间点、金额、谁说了什么）；
  2. 问清楚下一步判断必需的事实（一次问 1–3 个最关键的，不要问卷式轰炸）；
  3. 给**不依赖具体条文**的流程性指引（该保存什么证据、该去哪个窗口、下一步该做什么动作）；
  4. 需要依据才能答的问题，**明说**："这一问要引法条/数字，我先去核实依据再回答你，
     现在先把 X 和 Y 确认清楚。"
- 这一轮的目标不是给答案，是**把事实问清楚**——依据下一轮补上。

【例外：用户这一问的核心就是期限】
如果用户问的正是"我还能不能申请仲裁""还有几天""过期了没"这类**期限本身**的问题，
**不许用相对时间糊弄过去**，必须两件事一起给：
1. 明说：**"这个期限我必须核实准确了再答——答错的代价你承担不起。"**
2. 给保守指引：**"在我核实之前，请按最紧的可能期限准备，不要拖。"**
   （随后给出在最紧假设下当天就能做的动作。）
理由：**超期是不可逆的，而提前准备的代价只是白忙。** 期限不确定时，
唯一对用户安全的建议是按最紧的假设行动。`;

export interface BuildSystemPromptInput {
  snapshot: CaseSnapshot;
  /** threads.mode：问诊 | 陪跑 | 文书 | 录音分析 */
  mode: string;
  stage: IntakeStage;
  /** 预检索到的 packs（逐字原文） */
  packs: KnowledgePack[];
  /** ⭐核心条的取料（S1 档案三来源 / S3 场景映射 / S4 用户原话），由 orchestrator 一处算清 */
  coreSources?: CoreArticleSources;
  now: Date;
  /** 本轮识别到自伤/极端痛苦表述（见 crisis.assessCrisis） */
  crisis?: boolean;
  /** 本案此前已给过危机资源卡：指令照下，但不再重复整张卡（spec §10 不刷屏） */
  crisisCardAlreadyGiven?: boolean;
  /** 本轮是否够格提及付费心理咨询（charter §5 持续焦虑抑郁表现 且 未转介过） */
  nbdpsyEligible?: boolean;
  /**
   * 本轮**空包**（注入包里一张实质命中的卡都没有）→ 注入空包告知指令。
   * 判据是 `substantiveHitCount === 0`，**不是 `packs.length === 0`**：
   * 尘埃形态的本质是"总能捞到 6 张，只是全无关"，按 length 判永远不触发。
   */
  emptyPack?: boolean;
}

/** 段与段之间的分隔符。**它自己也是前缀的一部分**，所以是常量不是模板串。 */
export const SEGMENT_SEPARATOR = '\n\n---\n\n';

/**
 * system prompt 的四段（见文件头）。**缓存前缀就是 `staticPrefix`**，
 * 第二个可缓存前缀到 `packsBlock` 末尾为止（危机轮/空包轮里 `turnDirectives` 夹在中间）。
 *
 * 【为什么把这几段单独交出来，而不是只给拼好的串】断点要落在**字节位置**上
 *（providers/anthropic.ts 按偏移切 system 块）。让调用方去拼好的串里找边界，
 * 就是给同一条边界造了第二个真源——那一份会在某次改分隔符时静默失准，
 * 而失准的表现只是「缓存不命中」：账单变贵，没有一处会报错。
 */
export interface SystemPromptSegments {
  /** 静态段：charter + 输出纪律 + 闭合清单段。同一领域逐字恒定。 */
  staticPrefix: string;
  /**
   * 首要位：危机指令与空包指令。**只在那几轮非空**，其余轮为空串。
   *
   * 它排在 packs 之前，代价是那几轮的 packs 缓存作废（见文件头「首要位」那段）。
   * 不给它留断点：每轮都可能变，缓存它只是白写一次。
   */
  turnDirectives: string;
  /** 半静态段：本案本轮的 packs 逐字原文（按卡 id 排序）。无卡时为空串。 */
  packsBlock: string;
  /** 动态段：运行环境 + 事实卡 + 问诊/前情提要。 */
  dynamic: string;
}

/**
 * 静态段。**入参只有领域包**——这是「不含日期、案件 id、用户名」这件事的机械保证：
 * 拿不到 snapshot 就写不进案件信息，不必靠判据一条条去扫。
 */
export function staticPrefixOf(pack: DomainPack): string {
  return [
    CHARTER,
    outputDiscipline(),
    // 【它排在输出纪律之后，且每轮都在】它管的是**这一轮该由谁做**，
    // 而上面那 11 条管的是"做出来的东西长什么样"——先定谁做，再定怎么做。
    // 清单逐条来自领域包：共用层一个条目都不写死（设计稿 §13）。
    renderLawyerMandatory(pack),
  ].join(SEGMENT_SEPARATOR);
}

export function buildSystemPromptSegments(input: BuildSystemPromptInput): SystemPromptSegments {
  const { readable, iso } = beijingNow(input.now);
  // 危机指令与危机资源卡的 id 按**这个案件所属领域**取（设计稿 §13「危机」行）。
  // 取缺省领域的形态是：第二个领域的用户触发危机时，模型收到的是给上一个行当的指令
  // （连"必须给哪两个号码"都是别人的），而首段、词表、留痕全都按他自己的领域走了——
  // 同一轮里两套口径并存，没有一处会报错。
  const pack = domainPackOrDefault(input.snapshot.case.domain);
  const crisisPack = pack.crisis;

  const packsBlock = packsSection(
    input.packs,
    // 「别重印整张卡」这条**紧贴卡本身**下发，不放通用指令区：
    // 实测放开头时模型照样把整张卡重印了两轮，指令离约束对象太远就被稀释了。
    // （它是本轮态，落在半静态段里会在危机窗内让这一段的缓存作废一次——
    //   代价是危机轮多写一次缓存，换的是这条指令仍然贴着那张卡，不换。）
    input.crisis && input.crisisCardAlreadyGiven
      ? {
          packId: crisisPack.resourcePackId,
          // 【这句话与号码都由领域包给，共用层一个数字都不认识】（设计稿 §13「危机」行）
          // 号码原来写死在这里：第二个领域接进来之后，它的用户在危机窗内读到的是**上一个
          // 行当**的三个号码——号码本身是对的，只是不属于他这件事，而这一轮回复照常生成、
          // 格式完全正常、没有一处会报错。
          note: crisisPack.repeatCardNote(markedCrisisNumbers(input.packs, crisisPack.resourcePackId)),
        }
      : undefined,
    // 核心依据条**由结构化事实判定**，不让模型自己勾——见 citation-block.coreArticleKeys：
    // S1 档案三来源恒优先；S1 空（首诊轮）时 S3 场景映射优先占上限、S2 检索序补足、
    // S4 用户点名不占上限。取料面在 orchestrator 一处算清，这里只补本通路的注入包。
    // **这里传的是调用方的原序**（检索名次），不是 packsSection 内部的渲染序：
    // S2 那一档按名次补足，拿排过序的数组喂它等于把「第几名」换成「id 排第几」。
    coreArticleKeys({ ...input.coreSources, retrieved: input.packs }),
  );

  // 【首要位】危机指令与空包指令：紧接静态段之后、packs 与事实卡之前（见文件头 2026-09-10 裁决）。
  // 危机指令排最前——它要压过本轮其它一切安排（依据纪律、问诊清单、行动卡）；
  // 空包指令紧跟其后——它改写的是「这一轮能引什么」这个前提，必须先于依据纪律那句抬头
  // 与事实卡、问诊指令被读到。
  const turnDirectives = [
    input.crisis ? crisisPack.directive : '',
    input.emptyPack ? EMPTY_PACK_DIRECTIVE : '',
  ]
    .filter((p) => p.trim())
    .join(SEGMENT_SEPARATOR);

  const dynamic = [
    // 【前置禁令 > 事后剥句】不够格时**在生成前就禁掉**，而不是等它说完再剥——
    // 普通轮是流式的，剥句只能清掉入库正文，用户早看见了。
    // 事后剥句仍保留作兜底，但真正管用的是这条前置约束。
    //
    // 【危机轮让位于资源卡那句】(2026-09-05 规则改版) 危机轮里 CRISIS_DIRECTIVE 已经说清
    // 「NBDpsy 那句由系统随资源卡给出，模型不得再自行添加或扩写付费咨询内容」——
    // 这里的通用禁令若再说一遍「不得以任何形式提及 NBDpsy」，就与随卡给出的那句合法文案
    // 直接打架（指令自相矛盾会稀释约束力）。所以危机轮不下发本块，由危机指令一处说清。
    //
    // 【为什么它在动态段而不在静态段】文本虽是常量，但**它有两态**（危机轮不下发）。
    // 放进静态段的形态是：危机轮与非危机轮的前缀不一样，静态段的字节稳定性当场失守，
    // 而两种前缀各自都读得通、账单也只是贵一点。
    input.nbdpsyEligible === false && !input.crisis
      ? [
          '## 本轮禁止提及付费心理咨询（硬性）',
          '',
          '不得以任何形式提及、推荐、或提出代为预约 NBDpsy 及任何付费心理咨询服务',
          '（含「我可以帮你约」「安排一次专业咨询」这类说法）。',
          '理由：charter §5 只允许在**持续焦虑抑郁表现**时提一次，本案尚未达到该条件；',
          'spec D9 明令禁止趁人之危观感——在用户刚说出痛苦的那一刻推销服务，正是它要禁的事。',
          '需要给支持资源时，给**免费公益资源**（心理援助热线、工会、法援），不要给我们的付费服务。',
        ].join('\n')
      : '',
    [
      '## 运行环境',
      '',
      `- 当前北京时间：${readable}（ISO8601：${iso}）。所有「今天/明天/下班前」按这个时刻换算。`,
      `- 默认适用地区：${input.snapshot.case.district}区（北京市）。`,
      `- 当前会话模式：${input.mode}。`,
    ].join('\n'),
    factsCardOf(input.snapshot),
    // 陪跑/文书这类"回头继续"的模式先给前情提要；首诊(问诊)不需要，用户刚开口
    input.mode === '问诊' ? intakeDirective(input.stage) : `${recapBrief(input.snapshot)}\n\n${intakeDirective(input.stage)}`,
  ]
    .filter((p) => p.trim())
    .join(SEGMENT_SEPARATOR);

  return { staticPrefix: staticPrefixOf(pack), turnDirectives, packsBlock, dynamic };
}

/**
 * 拼好的 system prompt + **可缓存前缀的字节位置**。
 *
 * `breakpoints` 逐个是「到此为止的这一段可以整体缓存」的偏移：
 *   [0] = 静态段末尾；[1] = **packs 段末尾**（packs 为空时只有 [0]）。
 * 危机轮/空包轮里首要位那一段夹在两者之间，所以 [1] ≠ 静态段 + 分隔符 + packs 的长度和——
 * 别按段长自己加，那正是「切错了不报错、只是不命中」的那种失准（见文件头「首要位」）。
 * 消费它的只有直连 Anthropic 那条路（providers/anthropic.ts 把 system 切成带
 * cache_control 的块）；中转走 OpenAI 兼容协议，**请求形态一个字节都不改**。
 */
export function buildSystemPromptWithBreakpoints(input: BuildSystemPromptInput): {
  system: string;
  breakpoints: number[];
} {
  const segs = buildSystemPromptSegments(input);
  const parts: string[] = [];
  const breakpoints: number[] = [];
  let len = 0;
  // 静态段与半静态段各留一个断点；首要位（本轮指令）与动态段末尾不留——
  // 那两段每轮都可能变，缓存它们只是白写一次。
  // **首要位仍然计进 len**：它夹在两个断点之间，第二个断点必须把它的长度算上，
  // 否则危机轮的第二块会切在 packs 中间（切错了不报错，只是不命中）。
  const SEGS = [segs.staticPrefix, segs.turnDirectives, segs.packsBlock, segs.dynamic];
  const CUT_AFTER = new Set([0, 2]); // 0=静态段末尾，2=packs 段末尾
  for (const [i, seg] of SEGS.entries()) {
    if (!seg.trim()) continue;
    if (parts.length) len += SEGMENT_SEPARATOR.length;
    parts.push(seg);
    len += seg.length;
    if (CUT_AFTER.has(i)) breakpoints.push(len);
  }
  return { system: parts.join(SEGMENT_SEPARATOR), breakpoints };
}

export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  return buildSystemPromptWithBreakpoints(input).system;
}
