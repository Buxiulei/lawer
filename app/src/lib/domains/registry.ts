// app/src/lib/domains/registry.ts
// 领域注册表（设计稿 §13）。一个「领域」= 一份配置 + 一组内容，**不是一套新代码**：
// 工具面、表结构、MCP/REST 协议跨领域不变，变的只是这里挂的那个包。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量（词表、阶段名、文书名、口径措辞）。领域内容一律写在
// 同目录下的领域包 `./<key>.ts` 里，本文件只认接口与映射。
// 这条由 lib/capabilities/__tests__/registry-guard.test.ts 机检：写回来一个领域词就红。
// 违反它的形态是——第二个领域接进来时，你以为只要加一个包，实际要去共用层里翻出
// 上一个领域留下的散落硬编码，而它们看起来都很正常。
// ─────────────────────────────────────────────────────

import type { CrisisOpenerText, HotlineFact } from '@/lib/agent/crisis-opener';

import { COUNSELING } from './counseling';
import { LABOR } from './labor';

/**
 * 个案报告一节的**取数口径**。领域包只说"这一节叫什么、从哪一堆数据长出来"，
 * 生成器（lib/cases/report.ts）认的是这里的英文键，不认标题字面——
 * 认标题的形态是：第二个领域把「证据地图」改叫别的名字，生成器就悄悄给它一节空的。
 */
export const REPORT_SECTION_SOURCES = [
  'basics', // 案件抬头与基本字段
  'narrative', // 从时间线长出来的主线
  'disputes', // 争议点：金额主张
  'positions', // 目标与底线
  'evidence', // 材料清单与简报
  'timeline', // 时间线摘要
  'deadlines', // 生效中的期限
  'actions', // 未完成的待办
  'risks', // 缺口与未定项
  'changelog', // 变更日志（只追加）
] as const;

export type ReportSectionSource = (typeof REPORT_SECTION_SOURCES)[number];

/** 个案报告的一节：给人看的标题 + 给生成器看的取数口径。 */
export interface ReportSectionSpec {
  title: string;
  source: ReportSectionSource;
}

/**
 * 事实卡一节的**取数口径**。与 ReportSectionSource 同理：渲染器
 * （lib/agent/case-facts.ts）按这里的英文键取标题，**不写死中文标题**——
 * 写死的形态是：第二个领域接进来，事实卡每一节的抬头都还在讲上一个行当的事，
 * 而每一行数据都是对的，没有一处会报错。
 */
export const FACTS_SECTION_KEYS = [
  'parties', // 当事人（我方身份与实名状态）
  'header', // 案件抬头
  'history', // 本案对话
  'deadlines', // 法定期限
  'basics', // 首诊必填的那几项
  'counterparts', // 对方主体
  'actions', // 未完成的行动卡
  'claims', // 金额主张
  'timeline', // 时间线
  'evidence', // 证据
] as const;

export type FactsSectionKey = (typeof FACTS_SECTION_KEYS)[number];

/** 事实卡的一节：给人看的标题 + 给渲染器看的键。 */
export interface FactsSectionSpec {
  key: FactsSectionKey;
  title: string;
}

/**
 * 本领域里「我方」与「对方」各是谁（设计稿 §13-1）。角色**不写死**：有的领域对面是一家机构，
 * 有的领域对面可能同时有好几方，谁在对面是领域的事，不是工具面的事。
 *
 * 【为什么工具描述要读它，而不是各自写死一个名词】写死的形态是：第二个领域接进来时，
 * 它的用户在工具清单里读到的仍是上一个领域的那个称呼——工具照常可用、回包照常正确，
 * 只是每一句话都在跟他讲另一个行当的事，而没有任何一处会报错。
 */
export interface DomainParties {
  /** 我方：这套工具服务的那一方 */
  self: string;
  /**
   * 对方主体的称呼，**第一个是最典型的那一个**（工具描述取它作单数称呼）。
   * 其余项是同一场纠纷里可能一并出现的其他对方主体。
   */
  counterparts: readonly string[];
  /** 对面是否可能同时不止一方（true 时工具面按「可能有好几家」说话，不按单数说） */
  multiParty: boolean;
}

/** 首诊一个字段的取值形状。校验器按它决定怎么验，首诊页按它决定怎么渲染。 */
export type IntakeFieldKind =
  | 'enum' // 受控词表（取值见 values）
  | 'text' // 一行字
  | 'date' // YYYY-MM-DD
  | 'money' // 金额，单位分（整数、> 0）
  | 'stringList' // 一串字符串（如诉求）
  | 'eventList' // 事件列表（{date?, text}）
  | 'record'; // 若干子问（子字段见 fields）

/**
 * 首诊表的一个字段（设计稿 §13「首诊表 schema」）。
 *
 * 【键名是跨领域不变的对外契约】`key` 与 `IntakeInput` / MCP 入参一一对应，各领域同名，
 * 换的是 description 与校验失败时说的那句话。**不要按领域改键名**——改键名等于换接口，
 * 而用户的 agent 手里握着上一版工具清单。
 *
 * 【必填校验只认 errorCode 在场的字段】没有 errorCode 的字段是可选项：不填不拦。
 * 用「required 为 true 但没给错误码」表达必填的形态是：拦下来之后没有话可说，
 * 于是回一句通用的「参数错误」——调用方照原样重试一次，再收到同一句。
 *
 * ⇒ 所以 `required` 与 `errorCode` **必须同时在场或同时不在场**（assertDomainPack 两向机检）。
 * 它们是同一件事的两个读者：对外说明书（intakeInputSchema）只看 `required`，
 * 服务端校验（validateIntake）只看 `errorCode`。让两者分叉的形态是——
 * 工具清单说这项可省略、服务端不填就拒收，**调用方照着说明书填齐了仍被拒**。
 * 想要"可省略但填了就得合格"的字段时，先把这两个读者统一，别用这两个字段的错配去表达它。
 */
export interface IntakeFieldSpec {
  /** 内部键（IntakeInput 上那个字段名） */
  key: string;
  /**
   * 对外参数名（MCP inputSchema / REST body 上那个名字）。
   * **与 key 可以不同名**：对外收「元」内部存「分」这类换算发生在能力壳里，
   * 两处同名反而会让人以为不用换算。
   */
  param: string;
  kind: IntakeFieldKind;
  required: boolean;
  /** 工具入参描述，逐字对外（MCP inputSchema 里那句话） */
  description: string;
  /** 必填/格式校验不过时的错误码；省略即此字段不做必填校验 */
  errorCode?: string;
  /** 校验不过时逐字回的话。`{values}` 占位符会被换成本字段的取值集合（以 ' / ' 连接） */
  invalidMessage?: string;
  /** kind==='date' 专用：填了一个晚于今天的日子时说的话 */
  futureMessage?: string;
  /** kind==='enum' 专用：取值集合 */
  values?: readonly string[];
  /** kind==='record' 专用：子问（键 + 逐字标签） */
  fields?: readonly { key: string; label: string }[];
}

/**
 * 危机层的领域部分（设计稿 §13「危机」行）。
 *
 * 判定机制（否定语境、窗口冷却、两态首段、出口闸）跨领域共用，写在 lib/agent/crisis.ts；
 * **词表与话**按领域来：同一句「撑不下去」在两个领域里该触发什么、首段该说什么，
 * 完全不是一回事（一个是给当事人的热线，一个是给专业人员的处置骨架）。
 */
export interface DomainCrisis {
  /** 触发词表 */
  lexicon: readonly string[];
  /** 否定语境标记：命中词前面紧挨着这些就不算触发 */
  negations: readonly string[];
  /** 资源卡的 pack id（首段的号码从这张卡的结构化 facts 里取） */
  resourcePackId: string;
  /** 危机轮注入给模型的强制指令原文 */
  directive: string;
  /** 确定性首段的固定文案（骨架由 lib/agent/crisis-opener 拼） */
  openerText: CrisisOpenerText;
  /** 模型段两次都踩线时的确定性兜底正文 */
  safeFallback: string;
  /**
   * 确定性首段。**由领域包自己产出**：第二个领域的首段与第一个领域根本不是同一种东西，
   * 让共用层去 if/else 两种形态的形态是——每加一个领域，共用层就多一个分支，
   * 而分支之间只有作者知道差别在哪。
   */
  firstSegment(ctx: { facts?: { hotlines?: HotlineFact[] }; compact?: boolean }): string;
}

/**
 * 低调模式（DESIGN.md RISK 1）的兜底词典：任何可能被旁人瞥见的文案的替身。
 * 适用范围：document.title、Toast、以及将来接入的系统通知/横幅。
 *
 * 【为什么按领域一份】兜底措辞的全部作用是「看一眼看不出这是什么事」，
 * 而「什么词会暴露」完全取决于领域。共用一份的形态是：第二个领域的用户开着低调模式，
 * 标题栏却写着上一个行当的词——低调模式照常"生效"，只是它挡的不是这个人的事。
 */
export interface DomainNeutralCopy {
  /** 低调模式下对外显示的中性标题 */
  title: string;
  /** 非低调模式下路由切换瞬间的兜底标题 */
  appTitle: string;
  /** 低调模式下通知/Toast 的兜底措辞 */
  notice: string;
  /**
   * 上面三句里**一个都不许出现**的词：本领域一眼就能被认出来的那些字。
   * 由判据逐条比对（labor-pack.test.ts），不靠人记得。
   */
  forbiddenWords: readonly string[];
}

/** 领域的对外文案。逐字对外的那些话都在这里，共用层只引用、不改写。 */
export interface DomainCopy {
  neutral: DomainNeutralCopy;
  /**
   * 能力注册表里带领域措辞的那几句（工具清单会原样展示给用户的 agent，
   * 改一个字就是接口变更）。键由各领域包自定，消费方按键取。
   */
  capabilities: Readonly<Record<string, string>>;
  /** 站内与落库文案（建档标题、首诊落下来的那几条事件的标题…） */
  site: Readonly<Record<string, string>>;
}

/**
 * 一组**恒常在场**的「这几件事没有律师书面确认之前不许下结论」。
 *
 * 【为什么它是包的一部分，而不是一条条待办】待办做完就消失，而这几项做不完——
 * 它们是这个行当里本来就没有定论的东西，只会由某一位律师针对某一个案子书面确认一次。
 * 做成待办的形态是：模型看见"待办 4 项"，于是替用户把它们逐条"办掉"（给出一个结论），
 * 而每一条结论读起来都很像答案。
 *
 * 【为什么恒常在场而不是"命中才提"】它防的是**模型的默认行为**，不是某种输入。
 * 只在用户问到时才提的形态是：用户没问、模型自己顺口断言了一句，没有任何东西会拦它。
 */
export interface DomainLawyerReview {
  /** 这一节的抬头（事实卡与个案报告共用同一份措辞） */
  title: string;
  /** 逐条：**待核的是什么、为什么没定论**。一条一件事，不合并 */
  items: readonly string[];
  /** 统一纪律，逐字对外——这句话才是这一节的作用，条目只是它的适用范围 */
  discipline: string;
}

/**
 * 敏感级：本领域的档案里写着**第三人**的敏感个人信息（个保法 §28 那一类）。
 *
 * 【它约束的是三个出口】每轮喂给模型的事实卡、免登录分享页、转介数据包。
 * 三处各写一遍"记得脱敏"的形态是——总有一个出口忘了，而它照常返回 200、页面上什么都不缺。
 * 所以三处读同一份声明；要改口径只改这里。
 */
export interface DomainSensitivity {
  /** 被保护的是谁（「来访者」）。脱敏提示与分享页的措辞取它，不在共用层写死一个称呼 */
  subject: string;
  /**
   * 事实卡里逐字写给模型的那段纪律。写在卡里而不是 prompt 里，
   * 因为它要与"这一条证据长什么样"挨着出现——隔开的形态是，模型读到明细时早忘了那句话。
   */
  factsNotice: string;
  /** 分享 / 导出页上逐字给读者的那句话（说明这里被脱敏过、以及要核对该找谁） */
  redactNotice: string;
}

/** 一个领域包要提供的东西。**每一项都必填**：缺项由 assertDomainPack 在启动时点名。 */
export interface DomainPack {
  /** 领域键，与 cases.domain 落库值同一份取值 */
  key: string;
  /** 给人看的领域名 */
  label: string;
  /** 我方与对方各是谁；工具面的「对方主体」措辞取自它，不在工具面写死 */
  parties: DomainParties;
  /** 案件阶段枚举。**唯一真源**：stage 校验读它，不再各处引 CASE_STAGES */
  stages: readonly string[];
  /**
   * 并行轨（设计稿 §16）：可在任一主线阶段进入、处置完回主线的那些轨道。
   *
   * 【为什么不是多加几个 stage】stage 是**单值**的当前态，而并行轨的语义正是
   * 「主线不动，另一条线同时在走」。塞进 stages 的形态是：一进并行轨，主线走到哪一步
   * 这件事就被覆盖掉了，出轨时没有任何地方记得该回到哪。
   *
   * 主线本身是线性的领域给空数组——**空数组是「本领域没有并行轨」这个事实**，
   * 不是「还没填」。
   */
  tracks: readonly string[];
  /**
   * 驾驶舱那条轨道的格子（页面上「案件进度」那一条）。
   *
   * 【与 stages 是两种东西，不许合并】stages 是**可变可回退的当前态**，
   * 轨道格子是**只追加的既成事实**：案子从这一格退回上一格时，stage 变了，
   * 而走过的格子仍然走过。拿 stages 当轨道画的形态是——谈崩退回上一步，
   * 页面上已经点亮的后几格会被抹回未到，用户以为自己白走了一趟。
   *
   * **省略 = 本领域还没有单独的轨道词表**，页面退回按 `stages` 摆格子
   * （见 app/_ui/domain.ts 的 journeyOf）。退回是有代价的：那条轨道会跟着 stage 回退，
   * 所以这一项只是没填时的兜底，不是等价物。
   */
  journey?: readonly string[];
  /** 首诊表 schema：字段、必填、校验规则与问法 */
  intakeSchema: readonly IntakeFieldSpec[];
  /**
   * 首诊要不要顺手落一条法定期限，以及落哪一条。
   *
   * **省略 = 本领域首诊不自动落任何期限**——这是一个结论，不是待填项：
   * 拿不到真起算点还硬落一条的形态是，到期日被算得比真实的晚，
   * 等于告诉用户他还有时间。宁可没有，不可晚。
   */
  intakeLimitation?: {
    /** 落哪一类（取值须在 deadlineKinds 里） */
    kind: string;
    /** 只有案件处在这几个阶段才落（其余阶段还没有可指认的侵害日，落了就是编） */
    stages: readonly string[];
    /** 追加在 derived_from 后面的说明；`{anchor}` 换成实际锚点日 */
    note: string;
  };
  /** 事实卡分节（顺序即渲染顺序） */
  factsSections: readonly FactsSectionSpec[];
  /**
   * 个案报告的分节骨架（顺序即渲染顺序）。
   *
   * 【为什么不复用 factsSections】那份钉的是事实卡渲染器的分区标题（有判据逐条比对），
   * 是「服务端读出来的原始事实」；报告是**整理过的长期记忆**，两者分节本来就不同
   * （报告有「争议焦点」「谈判纪律」「变更日志」，事实卡没有）。混用一个数组的形态是：
   * 谁先改谁赢，而另一边的判据仍然绿着。
   */
  reportSections: readonly ReportSectionSpec[];
  /** 法定期限的种类 */
  deadlineKinds: readonly string[];
  /** 文书种类 */
  docKinds: readonly string[];
  /** 这些文书是**会交到对方手里的**：少了发送后果就拒收（charter 红线 5） */
  outboundDocKinds: readonly string[];
  /**
   * 金额主张（claims 表）能登记的种类。**与 calculatorKinds 不是一回事**：
   * 这份是"能记一笔账的名目"，那份是"服务端能替你算的那几项"。
   * 混成一个数组的形态是：能算的算不进来、能记的算不出来，而两侧各自看都正常。
   */
  claimKinds: readonly string[];
  /** 算钱器：claim_calc 能算的那几项 */
  calculatorKinds: readonly string[];
  /** 危机词表与首段 */
  crisis: DomainCrisis;
  /**
   * 「未经律师书面确认不得作为结论输出」的固定条目。**省略 = 本领域没有这类条目**，
   * 是一个结论不是待填项。
   */
  lawyerReview?: DomainLawyerReview;
  /** 敏感级。**省略 = 本领域不按敏感级处理**（同上，是结论不是待填项）。 */
  sensitive?: DomainSensitivity;
  /** 对外文案（低调模式词典 + 能力文案 + 站内文案） */
  copy: DomainCopy;
}

/** key → 领域包。加一个领域 = 加一个包 + 在这里挂一行。 */
export const DOMAINS: Record<string, DomainPack> = {
  [LABOR.key]: LABOR,
  [COUNSELING.key]: COUNSELING,
};

/**
 * 缺省领域键：一条数据没说自己属于哪个领域时，按它算。
 *
 * 【为什么要有缺省，而不是要求处处显式声明】领域字段是**后加**的：库里既有的案件行、
 * 既有的知识卡都没有它（cases.domain 由迁移按默认值补齐；知识卡的 domain 只在卡片
 * 自己声明时才写进 index.json）。没有缺省就只能把"没声明"读成"不属于任何领域"，
 * 而那会让全部既有内容在按领域过滤的那一刻整批消失——返回 200、一条卡都不给。
 *
 * 【取值同源】写死取 LABOR.key，与 lib/db/migrate.ts 给 cases.domain 的 DDL 默认值同值。
 * 两处不一致的形态是：同一个存量案件按 A 包校验阶段、按 B 域检索知识，而两边都返回
 * 200、都不报错。**不取 `Object.keys(DOMAINS)[0]`**：注册第二个包之后，那个写法把
 * "缺省领域是哪个"绑在了对象字面量的书写顺序上——挪一下 counseling 的位置，
 * 全部存量案件与存量知识卡的归属当场易主，而 TypeScript 与既有判据都看不见。
 */
export const DEFAULT_DOMAIN: string = LABOR.key;

/**
 * 取领域包。取不到回 undefined 而不是回落到某个包——回落的形态是：
 * 一个 domain 写错的案件，会安安静静地按别的领域的阶段枚举被校验。
 *
 * 【它不看灰度开关，这是刻意的】灰度关掉的是「还能不能**新建**这个领域的案件」，
 * 不是「已经存在的案件还能不能读」。让它跟着开关走的形态是：临时把某个领域从
 * `LAWER_DOMAINS_ENABLED` 里摘掉，已建档用户的案件当场变成 500——
 * 一个本该只影响新用户的开关，把老用户的档案锁在了外面。
 */
export function getDomainPack(key: string): DomainPack | undefined {
  return DOMAINS[key];
}

/**
 * **读路径**的领域包：给一行 `cases.domain`，取它的包；取不到退回缺省领域。
 *
 * 【读写两条路径的政策不同，且都是刻意的】
 *   · **写 / 选领域**（建案、首诊、stage 与文书种类校验）走 `getDomainPack` /
 *     `requireEnabledDomain`：取不到就**拒绝**（UNKNOWN_DOMAIN）。按另一个领域的词表
 *     把一行数据写进库之后，没有任何东西还能把它认出来。
 *   · **读**（事实卡抬头、危机词表与首段、站内注入按领域过滤）走本函数：取不到
 *     **退回缺省领域**。一行 domain 写坏的案件不该让用户连自己的档案都读不出来，
 *     更不该在危机轮里因为一个配置错误而拿不到号码。
 *
 * 【为什么收成一个函数，而不是各处写 `DOMAINS[x] ?? DOMAINS[缺省]`】散着写的形态是：
 * 某一处忘了 `??`，那一处就在未知 domain 上炸在属性访问上；或者反过来——将来要把
 * 这条政策改成「读路径也拒绝」时，得先去把散落的每一处翻出来，而漏掉的那一处不会报错。
 * **独立写 N 次就会忘掉其中某一次**，所以只留一个入口，改政策只改这里。
 */
export function domainPackOrDefault(key: string | null | undefined): DomainPack {
  return (key ? DOMAINS[key] : undefined) ?? DOMAINS[DEFAULT_DOMAIN];
}

/**
 * 这个领域的轨道格子。**读 journey / 退回 stages 这条规矩只写在这一处**：
 * 散着写 `pack.journey ?? pack.stages` 的形态是——某一处忘了兜底，
 * 没给 journey 的领域在那一处炸在属性访问上；或者将来要改这条规矩时，
 * 得先把散落的每一处翻出来，而漏掉的那一处不会报错。
 */
export function journeyOfPack(pack: DomainPack): readonly string[] {
  return pack.journey ?? pack.stages;
}

// ========== 灰度开关（设计稿 §16 分期：LAWER_DOMAINS_ENABLED=labor,counseling）==========

/** 灰度开关的环境变量名。缺省只开缺省领域。 */
export const DOMAINS_ENABLED_ENV = 'LAWER_DOMAINS_ENABLED';

/**
 * 当前启用了哪些领域（逗号分隔，缺省 = 只有缺省领域）。
 *
 * **每次现读 env，不进程级缓存**：缓存的形态是——同一个进程里改了开关不生效，
 * 而它不报错，只是行为停在启动那一刻，运维会以为开关没写对而反复改。
 *
 * 环境变量里写了但注册表里没有的 key 一律忽略：那是配置写错，不是"有一个我不认识的领域"。
 * 忽略而不是抛错，是因为这个开关常常先于代码发布（先配好再上线包）。
 */
export function enabledDomainKeys(): readonly string[] {
  const raw = process.env[DOMAINS_ENABLED_ENV];
  if (raw === undefined || raw.trim() === '') return [DEFAULT_DOMAIN];
  const wanted = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const known = wanted.filter((k) => k in DOMAINS);
  // 一个都没对上时回缺省领域：把全站置成"没有任何可用领域"不是灰度，是停业。
  return known.length > 0 ? known : [DEFAULT_DOMAIN];
}

/** 启用中的领域包，顺序照 enabledDomainKeys。给注册流程/建案的领域选择用。 */
export function listDomains(): DomainPack[] {
  return enabledDomainKeys().map((k) => DOMAINS[k]);
}

export function isDomainEnabled(key: string): boolean {
  return enabledDomainKeys().includes(key);
}

/** 领域不可用时的自述错误（缺什么 / 为什么缺 / 怎么办），形状同 lib/cases 的 DomainFailure。 */
export interface DomainNotEnabled {
  ok: false;
  status: number;
  errorCode: string;
  message: string;
}

/**
 * 建案/首诊/注册这类**选领域**的入口用它：传进来的 key 必须既注册过、又在灰度开关里。
 * 回包是自述错误——裸回一句「不支持」会让调用方原样重试，然后再收到同一句。
 */
export function requireEnabledDomain(key: string): DomainPack | DomainNotEnabled {
  const enabled = enabledDomainKeys();
  if (enabled.includes(key)) return DOMAINS[key];
  const known = Object.keys(DOMAINS);
  return {
    ok: false,
    status: 400,
    errorCode: known.includes(key) ? 'DOMAIN_NOT_ENABLED' : 'UNKNOWN_DOMAIN',
    message: known.includes(key)
      ? `领域「${key}」这套代码里有，但当前环境没有开：${DOMAINS_ENABLED_ENV} 只开了 ${enabled.join('、')}。` +
        `现在能用的是 ${enabled.join(' / ')}；要开它，把 ${key} 加进 ${DOMAINS_ENABLED_ENV} 再重启。`
      : `没有「${key}」这个领域：lib/domains 里注册过的是 ${known.join('、')}，当前开启的是 ${enabled.join('、')}。` +
        `请从开启的这几个里选一个（${enabled.join(' / ')}），或先补上这个领域包。`,
  };
}

// ========== 结构守卫 ==========

/**
 * 领域包必须**实现全部字段**。编译期由 `DomainPack` 类型管漏字段；这一层管的是
 * 编译期看不出来的那些：空数组、空串、把 `parties.counterparts` 写成空、
 * 或者 `firstSegment` 挂了个不返回字符串的函数。
 *
 * 【为什么运行时也要查一遍】漏一项的形态不是崩溃，是**静默降级**：
 * 空的危机词表 = 危机永不触发；空的 factsSections = 事实卡整张空白；
 * 空的 stages = 任何 stage 都校验不过。三者都不报错，只是那一块从此不工作。
 *
 * `tracks` 是**唯一允许为空**的数组（空 = 本领域没有并行轨，是事实不是缺项）。
 *
 * @throws 缺项时抛出，把缺的项一次列全（不要挤牙膏式一次报一个）
 */
export function assertDomainPack(pack: DomainPack): void {
  const missing: string[] = [];
  const str = (name: string, v: unknown) => {
    if (typeof v !== 'string' || v.trim() === '') missing.push(name);
  };
  const arr = (name: string, v: readonly unknown[] | undefined) => {
    if (!Array.isArray(v) || v.length === 0) missing.push(name);
  };

  str('key', pack.key);
  str('label', pack.label);
  str('parties.self', pack.parties?.self);
  arr('parties.counterparts', pack.parties?.counterparts);
  if (typeof pack.parties?.multiParty !== 'boolean') missing.push('parties.multiParty');
  arr('stages', pack.stages);
  // tracks 允许为空数组，但必须是数组——undefined 是"忘了填"，[] 是"没有并行轨"
  if (!Array.isArray(pack.tracks)) missing.push('tracks');
  arr('intakeSchema', pack.intakeSchema);
  arr('factsSections', pack.factsSections);
  arr('reportSections', pack.reportSections);
  arr('deadlineKinds', pack.deadlineKinds);
  arr('docKinds', pack.docKinds);
  arr('outboundDocKinds', pack.outboundDocKinds);
  arr('claimKinds', pack.claimKinds);
  arr('calculatorKinds', pack.calculatorKinds);

  arr('crisis.lexicon', pack.crisis?.lexicon);
  arr('crisis.negations', pack.crisis?.negations);
  str('crisis.resourcePackId', pack.crisis?.resourcePackId);
  str('crisis.directive', pack.crisis?.directive);
  str('crisis.safeFallback', pack.crisis?.safeFallback);
  arr('crisis.openerText.head', pack.crisis?.openerText?.head);
  str('crisis.openerText.tail', pack.crisis?.openerText?.tail);
  if (typeof pack.crisis?.firstSegment !== 'function') missing.push('crisis.firstSegment');

  // lawyerReview / sensitive 都是**可选**的（省略 = 本领域没有这回事）。但一旦声明，
  // 就不许半张：空的 items = 一节只有抬头没有内容；空的 discipline = 列了四件事却没说
  // 「不许下结论」——而那句话才是这一节存在的理由，缺了它这一节读起来像四条待办。
  if (pack.lawyerReview) {
    str('lawyerReview.title', pack.lawyerReview.title);
    arr('lawyerReview.items', pack.lawyerReview.items);
    str('lawyerReview.discipline', pack.lawyerReview.discipline);
  }
  if (pack.sensitive) {
    str('sensitive.subject', pack.sensitive.subject);
    str('sensitive.factsNotice', pack.sensitive.factsNotice);
    str('sensitive.redactNotice', pack.sensitive.redactNotice);
  }

  str('copy.neutral.title', pack.copy?.neutral?.title);
  str('copy.neutral.appTitle', pack.copy?.neutral?.appTitle);
  str('copy.neutral.notice', pack.copy?.neutral?.notice);
  arr('copy.neutral.forbiddenWords', pack.copy?.neutral?.forbiddenWords);
  if (!pack.copy?.capabilities || Object.keys(pack.copy.capabilities).length === 0) {
    missing.push('copy.capabilities');
  }
  if (!pack.copy?.site || Object.keys(pack.copy.site).length === 0) missing.push('copy.site');

  // 分节**必须覆盖全部键**，且一个键只能出现一次。
  // 【为什么这条比"数组非空"更要紧】渲染器按键取抬头：缺一个键的形态不是崩溃，
  // 而是那一节顶着一个英文键名出现在 prompt 里，或者干脆退回上一个领域的抬头——
  // 每一行数据都是对的，只有抬头在讲另一个行当的事。
  const factsKeys = (pack.factsSections ?? []).map((x) => x.key);
  const missingFacts = FACTS_SECTION_KEYS.filter((k) => !factsKeys.includes(k));
  const dupFacts = factsKeys.filter((k, i) => factsKeys.indexOf(k) !== i);
  if (missingFacts.length) missing.push(`factsSections 缺键：${missingFacts.join('、')}`);
  if (dupFacts.length) missing.push(`factsSections 键重复：${dupFacts.join('、')}`);
  for (const spec of pack.factsSections ?? []) str(`factsSections[${spec.key}].title`, spec.title);

  // 报告分节同理：生成器按 source 取数，缺一个 source 就是缺一节，而报告照常生成。
  const reportSources = (pack.reportSections ?? []).map((x) => x.source);
  const missingReport = REPORT_SECTION_SOURCES.filter((k) => !reportSources.includes(k));
  const dupReport = reportSources.filter((k, i) => reportSources.indexOf(k) !== i);
  if (missingReport.length) missing.push(`reportSections 缺 source：${missingReport.join('、')}`);
  if (dupReport.length) missing.push(`reportSections source 重复：${dupReport.join('、')}`);

  // 对外文书必须是文书种类的子集：不在 docKinds 里的对外种类永远不会被命中，
  // 于是那道「少了发送后果就拒收」的闸对它形同虚设，而两份清单各自看都正常。
  const strayOutbound = (pack.outboundDocKinds ?? []).filter((k) => !(pack.docKinds ?? []).includes(k));
  if (strayOutbound.length) missing.push(`outboundDocKinds 不在 docKinds 里：${strayOutbound.join('、')}`);

  // 首诊字段：必填项必须同时给出错误码与那句话——拦下来却没有话可说的形态是
  // 回一句通用「参数错误」，调用方照原样重试一次，再收到同一句。
  for (const f of pack.intakeSchema ?? []) {
    str(`intakeSchema[${f.key}].key`, f.key);
    str(`intakeSchema[${f.key}].param`, f.param);
    str(`intakeSchema[${f.key}].description`, f.description);
    if (f.required && (!f.errorCode || !f.invalidMessage)) {
      missing.push(`intakeSchema[${f.key}] 必填却没给 errorCode/invalidMessage`);
    }
    // 反过来也要拦：`required` 与 `errorCode` 是**同一件事的两个读者**，不许各说各的。
    //   · 对外说明书（intakeInputSchema → MCP inputSchema 的 required 列表）只看 `required`；
    //   · 服务端校验（lib/cases/intake.validateIntake）只看 `errorCode` 在不在场。
    // 写成「required:false + errorCode」的形态是：工具清单说这项可省略，服务端不填就拒收——
    // 调用方**照着说明书填齐了仍被拒**，而两边各自看都是对的。
    if (!f.required && (f.errorCode || f.invalidMessage)) {
      missing.push(
        `intakeSchema[${f.key}] 不必填却给了 errorCode/invalidMessage` +
          '（对外说明书按 required 说可省略，服务端按 errorCode 照样拒收）',
      );
    }
    if (f.kind === 'enum' && (!Array.isArray(f.values) || f.values.length === 0)) {
      missing.push(`intakeSchema[${f.key}] 是 enum 却没给 values`);
    }
  }

  // 声明了首诊期限，却落一个本领域期限词表里没有的种类 ⇒ 那条期限存不进库，
  // 而首诊照常返回成功、只是 deadlinesAdded 恒为 0。
  const lim = pack.intakeLimitation;
  if (lim) {
    if (!(pack.deadlineKinds ?? []).includes(lim.kind)) {
      missing.push(`intakeLimitation.kind「${lim.kind}」不在 deadlineKinds 里`);
    }
    const strayStages = lim.stages.filter((st) => !(pack.stages ?? []).includes(st));
    if (strayStages.length) missing.push(`intakeLimitation.stages 不在 stages 里：${strayStages.join('、')}`);
  }

  // 低调模式的兜底措辞里出现了本领域一眼能认出来的词 ⇒ 低调模式照常"生效"，
  // 只是它挡的不是这个人的事。
  const neutral = pack.copy?.neutral;
  if (neutral) {
    for (const word of neutral.forbiddenWords ?? []) {
      for (const [name, text] of [
        ['title', neutral.title],
        ['appTitle', neutral.appTitle],
        ['notice', neutral.notice],
      ] as const) {
        if (typeof text === 'string' && text.includes(word)) {
          missing.push(`copy.neutral.${name} 里出现了本领域的显眼词「${word}」`);
        }
      }
    }
  }

  // 轨道格子给了就不许是空数组：空数组画出来是一条**没有任何格子的进度条**，
  // 页面照常渲染、一个报错都没有，只是这个领域的用户从此看不见自己走到哪一步。
  // 「本领域没有单独的轨道词表」的表达方式是**不给这一项**（页面退回按 stages 摆），
  // 不是给一个空数组。
  if (pack.journey !== undefined && (!Array.isArray(pack.journey) || pack.journey.length === 0)) {
    missing.push('journey 给了却是空的（不写这一项才是「本领域没有单独的轨道词表」）');
  }

  // 声明了并行轨却与主线阶段重名，说明这一项被当成阶段填了——两套词表混用时，
  // 「当前轨」与「当前阶段」会互相覆盖，而两边各自看都正常。
  const overlap = (pack.tracks ?? []).filter((t) => (pack.stages ?? []).includes(t));
  if (overlap.length > 0) missing.push(`tracks 与 stages 重名：${overlap.join('、')}`);

  if (missing.length > 0) {
    throw new Error(
      `领域包「${pack.key || '(无 key)'}」不完整，缺 ${missing.length} 项：${missing.join('、')}。\n` +
        '缺项不会让程序崩溃，只会让对应那一块静默不工作（空词表 = 那类判定永不触发）。\n' +
        `照 lib/domains/registry.ts 的 DomainPack 接口把这几项补齐，再对着已有的 ${DEFAULT_DOMAIN} 包看一眼取值形状。`,
    );
  }
}

// 每个挂进注册表的包在**模块加载时**就过一遍结构守卫：晚一步发现的形态是，
// 缺项要等到真有用户走到那条路径才暴露，而那条路径恰好是危机首段这种最不能失败的。
for (const pack of Object.values(DOMAINS)) assertDomainPack(pack);
