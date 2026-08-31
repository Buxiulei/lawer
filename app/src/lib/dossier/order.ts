// app/src/lib/dossier/order.ts
// 报价页（方案 v3 §6：探测 → 模块勾选 → 合计 → 确认）的**纯逻辑与措辞**。
//
// 【为什么这一层要单独存在】页面上要回答四个问题，每个都有一条不能含糊的判据：
//   ① 这一块现在能不能买（探测的四个计数说了算，见 lib/company/probe 文件头）
//   ② 这一块凭什么这个价（priceBasis / formula 逐块摊开，不给黑盒总数）
//   ③ 拿不到货怎么办（退款承诺在**扣费前**就摆出来，不是付完再说）
//   ④ 选中这些一共扣多少、够不够（合计与缺口）
// 把它们写成组件里的三元表达式，就是「独立写 N 次忘 N 次」——那不是疏忽，是默认形态。
//
// 【本文件只 import type，不 import 值】lib/company/* 在运行时会拖进 better-sqlite3，
// 而这份逻辑要被客户端组件用。类型是编译期的，值不是——这条别改成普通 import。
//
// 【前端不参与定价】每一个金额都来自 quote 响应里那一行；本文件只做加法与筛选。
// 合计口径（total / coreSubtotal / payableGongdao / shortfall）与服务端 quoteDossier
// 逐字相同，且由 __tests__/order.test.ts 拿**真的 quoteDossier** 对账（同一份库、同一批子集，
// 两边算出来的四个数必须相等）——不是各写一遍然后互相点头。
import type {
  DossierModule,
  DossierQuote,
  DossierQuoteItem,
  PriceBasis,
} from '@/lib/company/dossier-billing';
import type { ProbePayload } from '@/lib/company/probe';
import type { DossierRefundReason } from '@/lib/company/refund';

/* ── 六模块目录 ───────────────────────────────────────── */

export interface ModuleCard {
  module: DossierModule;
  label: string;
  isCore: boolean;
  /** 这一块交付什么。一句话，不吹。 */
  delivers: string;
}

/**
 * 六个模块的界面目录。
 *
 * 【为什么这里有一份 label 而 lib/company/dossier-billing 也有一份】那一份在服务端
 * （文件里 import 了 better-sqlite3 一路的东西），客户端组件 import 不进来。
 * 两份不许各自演化：`__tests__/order.test.ts` 双向咬住——本目录的模块集合与逐条 label、
 * isCore 必须与 DOSSIER_MODULES / DOSSIER_MODULE_LABEL / CORE_MODULES 完全相等，
 * 任一处改了名而另一处没改，测试会**点名说是哪个模块**，不是只说"对不上"。
 *
 * 顺序照 DOSSIER_MODULES（核心四项在前、patterns 依赖 docs_stats 排最后）。
 */
export const MODULE_CATALOG: readonly ModuleCard[] = [
  {
    module: 'venue',
    label: '仲裁地实操',
    isCore: true,
    delivers: '这个仲裁委怎么立案、要带什么、当地怎么判——只出已逐字核实过的辖区。',
  },
  {
    module: 'entity',
    label: '主体体检',
    isCore: true,
    delivers: '工商状态、注册资本实缴、法定代表人与股东，看它还在不在、赔不赔得起。',
  },
  {
    module: 'graph',
    label: '关联谱系',
    isCore: true,
    delivers: '签合同的、发工资的、背后控股的，常常不是同一家；这一块把它们的关系画出来。',
  },
  {
    module: 'docs_list',
    label: '涉诉清单',
    isCore: true,
    delivers: '这家公司已入档的劳动争议条目清单（案号、阶段、时间）。',
  },
  {
    module: 'docs_stats',
    label: '涉诉深度统计',
    isCore: false,
    delivers: '逐篇取全文后算的结果分布与各阶段耗时，每个数字都带样本量与数据截止日。',
  },
  {
    module: 'patterns',
    label: '人事套路归纳',
    isCore: false,
    delivers: '它惯用哪几套说法，每条都挂着案号与文书里的逐字引文；举不出引文的那条不出现。',
  },
];

export const MODULE_LABEL: Record<DossierModule, string> = MODULE_CATALOG.reduce(
  (acc, c) => {
    acc[c.module] = c.label;
    return acc;
  },
  {} as Record<DossierModule, string>,
);

/* ── 计价口径的人话 ───────────────────────────────────── */

/** priceBasis → 界面上那一行口径说明。不解释口径的价就是一个黑盒数。 */
export const PRICE_BASIS_TEXT: Record<PriceBasis, string> = {
  free: '不计费（全站共享的预生成辖区卡，是信任锚不是赠品）',
  fixed: '固定价，与篇数无关',
  per_doc: '按篇计价，篇数由上面那次免费探测数出来',
  base_plus_per_doc: '起价含前若干篇，超出的部分每篇加价',
};

/* ── 退款承诺（扣费前就要摆出来的那一句）─────────────── */

/**
 * 退款事由 → 它退的是哪个模块。
 *
 * 这张表是本文件与 `lib/company/refund.ts` 之间的**咬合点**：那边每加一条退款路径就要
 * 加一个 DossierRefundReason，这里没跟上就会在测试里当场变红并点名那个新事由
 * （`__tests__/order.test.ts` 拿 DOSSIER_REFUND_REASON_TEXT 的键集双向比）。
 * 不这样咬的话，新开一条退款路径而报价页只字不提，是**没人会发现**的那种漏——
 * 页面照常渲染、测试照常绿，只有用户永远不知道这块本来能退。
 */
export const REFUND_REASON_MODULE: Record<DossierRefundReason, DossierModule> = {
  sample_insufficient: 'docs_stats',
  sla_expired: 'docs_stats',
  graph_low_confidence: 'graph',
  patterns_insufficient: 'patterns',
};

/**
 * 扣费**之前**给出的退款承诺（未来时）。
 *
 * 与 refund.ts 的 DOSSIER_REFUND_REASON_TEXT 不是同一句话，也不该是：那边是退完之后
 * 解释「为什么退了」，这边是买之前承诺「什么情况下会退」。两者措辞不同、时态不同，
 * 但覆盖的模块集合必须一致——由 REFUND_REASON_MODULE 咬住。
 */
export const MODULE_REFUND_PROMISE: Record<DossierModule, string | null> = {
  venue: null,
  entity: null,
  docs_list: null,
  graph: '高置信关系边不足门槛时，这一块全额退还；已画出的低置信节点与边仍然保留可看。',
  docs_stats:
    '样本不足（可判定结果的文书篇数够不着门槛）或超期未交付，这一块全额退还；逐篇结构化明细保留可查。',
  patterns: '可用套路条目不足门槛时，这一块全额退还；被丢弃的条目计数照样对你可见。',
};

/** 按篇计价的两块要真人登录取证，快慢不由服务器决定——SLA 与退款承诺都只对它们成立。 */
const PER_DOC_BASIS: readonly PriceBasis[] = ['per_doc', 'base_plus_per_doc'];

export interface ModuleDisclosure {
  priceBasis: PriceBasis;
  basisText: string;
  /** 展开算式（服务端给的，前端不重算）。固定价没有。 */
  formula: string | null;
  /** 工作日上限；null = 无时延承诺（几分钟内出）。 */
  slaWorkdays: number | null;
  refundPromise: string | null;
}

/**
 * 一块的逐项披露。SLA 取自 quote 的 `litigationSlaDays`（**界面不写死 7**），
 * 只挂在按篇计价的两块上：核心四项是秒级~分钟级出货，给它挂一个工作日上限是编承诺。
 */
export function moduleDisclosure(item: DossierQuoteItem, quote: DossierQuote): ModuleDisclosure {
  const perDoc = PER_DOC_BASIS.includes(item.priceBasis);
  return {
    priceBasis: item.priceBasis,
    basisText: PRICE_BASIS_TEXT[item.priceBasis],
    formula: item.formula ?? null,
    slaWorkdays: perDoc ? quote.litigationSlaDays : null,
    refundPromise: MODULE_REFUND_PROMISE[item.module],
  };
}

/* ── 可售性（置灰）───────────────────────────────────── */

export type Availability = { sellable: true } | { sellable: false; reason: string };

const SELLABLE: Availability = { sellable: true };
const no = (reason: string): Availability => ({ sellable: false, reason });

/** 深度两块（按篇计价、可能样本不足）。 */
const DEEP: readonly DossierModule[] = ['docs_stats', 'patterns'];

/**
 * 一块现在能不能买。判据全部来自那次免费探测的四个计数（§2.3 / §6，
 * 口径见 lib/company/probe 的 ProbePayload 注释：relation_count=0 → 关联谱系置灰；
 * litigation_count=0 → 涉诉清单置灰；doc_url_count < 门槛 → 深度两块置灰）。
 *
 * 【置灰必须带原因句，且句里带着那个数】「暂不可用」四个字等于没说：用户不知道是
 * 这家公司真没有、还是我们没查到、还是系统坏了。原因句里写出探测到的数，
 * 用户才判断得了要不要换个写法再查一次。
 *
 * 【没探测过 ≠ 不可售】没有探测数据时**不说这块不可售**——那是我们不知道，不是它没有。
 * 核心四项照常可买（它们不依赖篇数）；深度两块给不出价（按篇计价，没有篇数就没有价），
 * 原因句照实说是"还没查"，不是"没有"。
 *
 * @param deepBlockedReason 服务端 409 DOSSIER_DOCS_BELOW_SELL_FLOOR 的原话。有它就用它——
 *   门槛与篇数的判据在服务端，前端复述一遍只会多一处会漂的口径。
 */
export function moduleAvailability(
  module: DossierModule,
  probe: ProbePayload | null,
  deepBlockedReason: string | null,
): Availability {
  const isDeep = DEEP.includes(module);

  if (!probe) {
    if (!isDeep) return SELLABLE;
    return no(
      '还没查过这家公司：这两块按篇计价，没有篇数就报不出价，也判断不了够不够样本。' +
        '先在上面免费查一次。',
    );
  }

  if (!probe.entity_matched) {
    return no(
      '这次没有匹配到这个主体：关联主体、涉诉记录、有公开文书链接的篇数都是 0，' +
        '没有可归属的记录可查。核对一下工商登记的公司全称，或直接填统一社会信用代码再查一次。',
    );
  }

  if (isDeep) {
    if (deepBlockedReason) return no(deepBlockedReason);
    return SELLABLE;
  }

  if (module === 'graph' && probe.relation_count === 0) {
    return no(
      '这次探测到关联主体 0 个：没有可画的关系，这一块不卖。' +
        '（这不等于它没有关联公司，只表示公开渠道这次一条都没查到。）',
    );
  }

  if (module === 'docs_list' && probe.litigation_count === 0) {
    return no(
      '这次探测到涉诉记录 0 条：没有可列的条目，这一块不卖。' +
        '（这不等于它没被告过，只表示公开渠道这次一条都没查到。）',
    );
  }

  return SELLABLE;
}

/* ── 依赖（patterns 要 docs_stats）─────────────────────── */

/** 模块依赖：套路归纳的输入是深度统计抽出的逐字摘录段。与服务端 MODULE_DEPENDS_ON 同源同物。 */
export const MODULE_DEPENDS_ON: Partial<Record<DossierModule, DossierModule>> = {
  patterns: 'docs_stats',
};

/**
 * 当前这个勾选组合下，这一块还差什么才能下单。null = 不缺。
 *
 * **不静默替用户加勾**：自动帮他把依赖那块勾上，等于扣走他没打算买的钱。
 * 这一条与服务端 409 DOSSIER_DEPENDENCY_UNMET 是同一条规则的两次表达，
 * 由 order.test.ts 对着真的 quoteDossier 双向对齐（前端说能下单、服务端就不许 409，反之亦然）。
 */
export function dependencyUnmet(
  module: DossierModule,
  selected: readonly DossierModule[],
  items: readonly DossierQuoteItem[],
): string | null {
  const dep = MODULE_DEPENDS_ON[module];
  if (!dep) return null;
  if (selected.includes(dep)) return null;
  if (items.some((it) => it.module === dep && it.alreadyPaid)) return null;
  return `「${MODULE_LABEL[module]}」的输入是「${MODULE_LABEL[dep]}」抽出的逐字摘录段，必须先有它：请把「${MODULE_LABEL[dep]}」一并勾选，或先单独购买它。`;
}

/**
 * 真正会进合计与下单的那些块 = 勾选 ∩ 可售。
 *
 * 【为什么要有这一步，而不是"勾选的时候就不让勾"】置灰的块在界面上根本没有勾选框，
 * 所以正常路径下勾不上它——但 selected 还有一条来路：默认勾选，以及"换了一家公司重新探测后
 * 上一次的勾还留着"。那两条路径上，一个界面显示「暂不可售」的块可以躺在 selected 里被一起下单，
 * 用户为一个页面明写着买不到的东西付了钱，而且没有任何一处会报错。
 * 把「不可售 ⇒ 不进账」做成一道**与勾选无关的**过滤，这条路就堵死了。
 */
export function billableSelection(
  selected: readonly DossierModule[],
  probe: ProbePayload | null,
  deepBlockedReason: string | null,
): DossierModule[] {
  return MODULE_CATALOG.map((c) => c.module)
    .filter((m) => selected.includes(m))
    .filter((m) => moduleAvailability(m, probe, deepBlockedReason).sellable);
}

/* ── 合计 ─────────────────────────────────────────────── */

export interface SelectionSummary {
  /** 本次勾选（按目录顺序去重后的） */
  modules: DossierModule[];
  /** 本次应付原价合计（已付过的那些行本身就是 0，不重复收） */
  total: number;
  /** 其中核心四项小计——赠送券能抵扣的就是这一段 */
  coreSubtotal: number;
  /** 其中深度两项小计（券不覆盖，照常扣） */
  deepSubtotal: number;
  /** 真正走公道值扣的额：有券时 = total − coreSubtotal */
  payableGongdao: number;
  balance: number;
  /** 余额缺口（够则 0），按 payableGongdao 算，不是按 total */
  shortfall: number;
  /** 扣完之后还剩多少（缺口存在时为负，如实给） */
  balanceAfter: number;
  intakeReserve: number;
  /**
   * 扣完之后余额撑不起一次首诊。**只出黄条，不阻断下单**——
   * 用户有权把钱花在他认为更要紧的地方，我们的责任是让他先知道这个顺序问题。
   */
  intakeAtRisk: boolean;
}

/**
 * 把服务端给的那几行加起来。**全部是加法与筛选，没有一处定价**。
 * 四个关键数（total / coreSubtotal / payableGongdao / shortfall）与服务端 quoteDossier
 * 对同一个子集算出来的必须逐字相等——order.test.ts 拿真库真函数对账。
 */
export function summarizeSelection(
  quote: DossierQuote,
  selected: readonly DossierModule[],
): SelectionSummary {
  const modules = MODULE_CATALOG.map((c) => c.module).filter((m) => selected.includes(m));
  const picked = quote.items.filter((it) => modules.includes(it.module));

  const total = picked.reduce((sum, it) => sum + it.gongdao, 0);
  const coreSubtotal = picked.reduce((sum, it) => sum + (it.isCore ? it.gongdao : 0), 0);
  const deepSubtotal = total - coreSubtotal;
  const payableGongdao = quote.membershipCreditAvailable ? total - coreSubtotal : total;
  const shortfall = Math.max(0, payableGongdao - quote.balance);
  const balanceAfter = quote.balance - payableGongdao;

  return {
    modules,
    total,
    coreSubtotal,
    deepSubtotal,
    payableGongdao,
    balance: quote.balance,
    shortfall,
    balanceAfter,
    intakeReserve: quote.intakeReserve,
    intakeAtRisk: shortfall === 0 && balanceAfter < quote.intakeReserve,
  };
}

/* ── 扣费前必须说的那几句 ─────────────────────────────── */

/**
 * 契约 docs/contracts/dossier-billing-api.md §二 绑死的四句诚实红线。
 * **不是可选文案**：它们要在用户点确认之前就在屏幕上，付完再说等于卖了个我们控制不了的承诺。
 * 第四句只在"探测到的篇数超过计费上限"时出现（没超时说它是句废话）。
 */
export function preChargeDisclosures(quote: DossierQuote, probedDocs: number): string[] {
  const lines = [
    '每一块的价都摊开给你看，核心四项与深度两项可以分开买——深度两项可能样本不足，' +
      '所以不打包硬卖，也不给打包折扣（折扣会诱导你连带买下那个可能拿不到的块）。',
    `文书部分需人工登录取证，最长 ${quote.litigationSlaDays} 个工作日。`,
    '样本不足或超期未交付，自动全额退还该模块费用。',
  ];
  if (probedDocs > quote.billableDocs) {
    lines.push(
      `探测到 ${probedDocs} 篇有公开文书链接的劳动争议，超出 ${quote.billableDocs} 篇的部分不入档、不处理、也不收费。`,
    );
  }
  return lines;
}

/* ── 默认勾选 ─────────────────────────────────────────── */

/**
 * 默认只勾**可售且没买过的核心四块**。
 * 深度两块按篇计价、单价高、且可能样本不足，默认替用户勾上等于诱导消费——
 * 它们要用户自己伸手勾。
 *
 * 两层过滤各自防一件事，缺任一层都不会有人报错：
 *   · 可售（`sellable`）：探测到 0 关联的公司，默认把「关联谱系」勾上，用户一路点下去
 *     就为一个页面上明写着「暂不可售」的块付了钱（billableSelection 是第二道，
 *     但那道只拦扣费，屏幕上仍会显示成"已选"）；
 *   · 没买过（`!alreadyPaid`）：已付过的块默认再勾一次，合计里它是 0 元、看着无害，
 *     可它会跟着进 confirm 的 modules——把「买过了」显示成「这次也要买」。
 */
export function defaultSelection(
  quote: DossierQuote,
  probe: ProbePayload | null,
  deepBlocked: string | null,
): DossierModule[] {
  return MODULE_CATALOG.filter((c) => c.isCore)
    .filter((c) => moduleAvailability(c.module, probe, deepBlocked).sellable)
    .filter((c) => quote.items.some((it) => it.module === c.module && !it.alreadyPaid))
    .map((c) => c.module);
}

/* ── 报价与输入框对不对得上 ───────────────────────────── */

/** 报价是替谁报的：公司名 + 代码。用来认出"输入框改过了，屏幕上的价不是这一家的"。 */
export function subjectKey(name: string, uscc: string): string {
  return `${name.trim()}|${uscc.trim()}`;
}

/**
 * 屏幕上那份价是不是**上一家**的。
 *
 * 【为什么它必须是一个能被直接断言的函数】这个判定的唯一去处是确认按钮的 disabled，
 * 而按钮的失效形态是静默的：把 `stale` 从 disabled 里删掉，页面照常渲染、
 * 那条黄色提示照常显示，只是按钮变成可点——用户拿着 A 家的报价下单，
 * 服务端按 B 家重新算钱，两边各自看着都对，而他看到的数与实扣的数不是一个数。
 * 判定写在组件里的一行表达式上时，整套测试删掉它也全绿（本仓 2026-08-31 实测）。
 *
 * 【为什么把 quote 也收进来】"还没报过价"与"报的是别家的价"是两件事，
 * 前者不该让按钮失效。把这一半留在调用方写成 `quote !== null && …`，
 * 判定就又被劈成两处，而只有其中一处受判。
 *
 * @param quotedFor 拿到这份报价时的 subjectKey
 */
export function isQuoteStale(
  quote: DossierQuote | null,
  quotedFor: string,
  name: string,
  uscc: string,
): boolean {
  if (quote === null) return false;
  return quotedFor !== subjectKey(name, uscc);
}
