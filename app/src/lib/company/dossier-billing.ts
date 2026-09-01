// app/src/lib/company/dossier-billing.ts
// 公司档案的报价与确认扣费（《公司档案模块化方案 v3》报价确认计费流）。三条铁律：
//
//   ① 报价**绝不动钱**。quoteDossier 只读——不 settle、不建档、不占额度。
//      「报个价就被扣了」是本产品最不能出的一类事故，故它有独立的对照测试
//      （余额与 ledger 行数在 quote 前后逐字相等）。
//   ② 公道值一律经 lib/billing 的函数，**不直写 gongdao / gongdao_ledger**。
//      幂等、事务、负余额语义都长在那几个函数里，绕过去就等于把它们全丢了。
//   ③ 没扣钱的单必须能查出为什么。走赠送券的单在 company_dossiers.paid_by 与
//      entitlements.consumed_ref 两处同时留痕——只留一处，事后就分不清是「送的」还是「漏扣的」。
//
// 拆包按模块选购（v2 的"两块打包"作废）：六个一次性模块各自计价、各自扣、各自退。
//   核心四项 venue/entity/graph/docs_list：秒级~分钟级、必定有货（venue 恒 0，是信任锚）；
//   深度两项 docs_stats/patterns：按篇计价、人工接力、可能样本不足（有自动退款兜底）。
// 会员赠送券 dossier_core 只覆盖核心四项一次；深度模块照常扣费（券值域锁死 340，月卡兜得住）。
//
// 【每个模块一笔独立消耗】幂等键 dossier-<档案id>-u<用户id>-<模块>：退一块不牵连另一块，
// 多个买家买同一家公司各自一笔、互不撞键。免费/券覆盖的模块也落一条 delta=0 的标记行
// （gongdaoSettle 对 cost=0 仍写幂等标记、不动余额），所以「这块买过没有」对钱付、券付、免费三种
// 情形是同一个判据（有没有那笔流水），不会出现券付的核心块显示未购买、然后被再卖一次。
import type Database from 'better-sqlite3';

import { ensureGongdaoAmount, SEED } from '../billing/estimate';
import { gongdaoSettle } from '../billing/index';
import { GONGDAO_LEDGER_TYPE, REGISTER_GRANT_GONGDAO } from '../billing/pricing';
import { readPrice } from '../billing/pricing-config';
import {
  ENTITLEMENT_KIND,
  consumeEntitlement,
  listUnconsumed,
} from '../billing/entitlements';
// 合并后归一化入口统一叫 companyKey（两支各写过一版，裁决见 ./normalize 文件头）。
// 本文件里 companyKey 已是一个局部变量名，故按原名引入以免遮蔽——是同一个函数，不是第二个入口。
import { companyKey as companyKeyOf } from './normalize';

/** 六个一次性可售模块（守望订阅 M7 不在此流，归守望工单）。 */
export type DossierModule =
  | 'venue'
  | 'entity'
  | 'graph'
  | 'docs_list'
  | 'docs_stats'
  | 'patterns';

/** 核心四项：会员券 dossier_core 覆盖的范围，也是 ≤700 守卫的钉子。 */
export const CORE_MODULES: readonly DossierModule[] = ['venue', 'entity', 'graph', 'docs_list'];
/** 深度两项：按篇计价、人工接力、可能样本不足（券不覆盖，照常扣费）。 */
export const DEEP_MODULES: readonly DossierModule[] = ['docs_stats', 'patterns'];
/** 全部模块，固定顺序（核心在前、依赖在后：patterns 依赖 docs_stats）。 */
export const DOSSIER_MODULES: readonly DossierModule[] = [...CORE_MODULES, ...DEEP_MODULES];

/** 模块 → gongdao_ledger.feature 键（须与 lib/billing/features.ts 登记的一致，用量明细出中文靠它）。 */
export const DOSSIER_MODULE_FEATURE: Record<DossierModule, string> = {
  venue: 'dossier_venue',
  entity: 'dossier_entity',
  graph: 'dossier_graph',
  docs_list: 'dossier_docs_list',
  docs_stats: 'dossier_docs_stats',
  patterns: 'dossier_patterns',
};

/** 模块 → 用户可见中文名（错误文案与退款说明都用它，不露英文模块名）。 */
export const DOSSIER_MODULE_LABEL: Record<DossierModule, string> = {
  venue: '仲裁地实操',
  entity: '主体体检',
  graph: '关联谱系',
  docs_list: '涉诉清单',
  docs_stats: '涉诉深度统计',
  // 规格里的「HR 套路归纳」在用户可见处一律写作纯中文——与 billing/features.ts 的
  // FEATURE_LABELS.dossier_patterns 同名同物，改叫法两处一起改
  // （features.test.ts 有双向机检：只改其中任一处都会红）。
  patterns: '人事套路归纳',
};

/** patterns（M6）依赖 docs_stats（M5）：套路归纳的输入是深度统计抽出的逐字摘录段。 */
const MODULE_DEPENDS_ON: Partial<Record<DossierModule, DossierModule>> = {
  patterns: 'docs_stats',
};

/** 计价口径：免费 / 固定 / 每篇 / 起价+每篇（M6）。 */
export type PriceBasis = 'free' | 'fixed' | 'per_doc' | 'base_plus_per_doc';

const MODULE_BASIS: Record<DossierModule, PriceBasis> = {
  venue: 'free',
  entity: 'fixed',
  graph: 'fixed',
  docs_list: 'fixed',
  docs_stats: 'per_doc',
  patterns: 'base_plus_per_doc',
};

const isCoreModule = (m: DossierModule): boolean => CORE_MODULES.includes(m);
/**
 * 按篇计价（= MODULE_BASIS 里两档带 per_doc 的口径）。**口径只有 MODULE_BASIS 这一处**：
 * 它同时出口到前端的 priceBasis，若这里再手抄一份模块名单，改了口径表就只会让页面上写的口径
 * 与实际走的分支（可售门槛、展开算式）各说各话——两边都不报错，测试也一片绿。
 */
const isPerDoc = (m: DossierModule): boolean =>
  MODULE_BASIS[m] === 'per_doc' || MODULE_BASIS[m] === 'base_plus_per_doc';

/**
 * 扣费幂等键的**唯一生成入口**。格式 `dossier-<档案id>-u<用户id>-<模块>`：
 *   · 含档案 id ⇒ 同一用户买不同公司互不去重；
 *   · 含用户 id ⇒ 第二个买家买同一家公司是另一笔，不会被第一个人的流水挡掉；
 *   · 含模块名 ⇒ 每个模块各自一笔，退一块不牵连另一块。
 * 退款键由 gongdaoRefund 自己拼成 `refund-<本串>`，故本串一变、退款幂等也跟着变——别在别处另拼一份。
 */
export function dossierChargeRef(dossierId: number, userId: number, module: DossierModule): string {
  return `dossier-${dossierId}-u${userId}-${module}`;
}

// ───────────────────────────── 计价 ─────────────────────────────

/**
 * 单模块当前单价（公道值）。全部经 readPrice 读 pricing_config（改价改表、不改代码、不重启）。
 * per_doc / base_plus_per_doc 按 billableDocs 展开：
 *   · docs_stats = min(篇数, cap) × per_doc
 *   · patterns   = base + max(0, min(篇数, cap) − base_docs) × per_extra
 * billableDocs 由报价流按免费探测给的"有公开文书链接的劳动争议篇数"算，见 quoteDossier。
 */
export function modulePrice(db: Database.Database, module: DossierModule, docCount: number): number {
  switch (module) {
    case 'venue':
      return readPrice(db, 'dossier.venue');
    case 'entity':
      return readPrice(db, 'dossier.entity');
    case 'graph':
      return readPrice(db, 'dossier.graph');
    case 'docs_list':
      return readPrice(db, 'dossier.docs_list');
    case 'docs_stats': {
      const cap = readPrice(db, 'dossier.docs_stats_cap_docs');
      const per = readPrice(db, 'dossier.docs_stats_per_doc');
      return Math.min(Math.max(0, docCount), cap) * per;
    }
    case 'patterns': {
      const cap = readPrice(db, 'dossier.docs_stats_cap_docs');
      const base = readPrice(db, 'dossier.patterns_base');
      const baseDocs = readPrice(db, 'dossier.patterns_base_docs');
      const perExtra = readPrice(db, 'dossier.patterns_per_extra_doc');
      const billable = Math.min(Math.max(0, docCount), cap);
      return base + Math.max(0, billable - baseDocs) * perExtra;
    }
  }
}

/** 计费篇数（= min(候选篇数, cap)）。超 cap 的篇数不入档、不处理、不计费（页面明写）。 */
export function billableDocs(db: Database.Database, docCount: number): number {
  return Math.min(Math.max(0, docCount), readPrice(db, 'dossier.docs_stats_cap_docs'));
}

/** 展开算式串（给 UI，不给黑盒总数）：per_doc 与 base_plus_per_doc 才有意义。 */
function priceFormula(db: Database.Database, module: DossierModule, docCount: number): string | undefined {
  const billable = billableDocs(db, docCount);
  if (MODULE_BASIS[module] === 'per_doc') {
    return `${billable} 篇 × ${readPrice(db, 'dossier.docs_stats_per_doc')} = ${modulePrice(db, module, docCount)}`;
  }
  if (MODULE_BASIS[module] === 'base_plus_per_doc') {
    const base = readPrice(db, 'dossier.patterns_base');
    const baseDocs = readPrice(db, 'dossier.patterns_base_docs');
    const perExtra = readPrice(db, 'dossier.patterns_per_extra_doc');
    const extra = Math.max(0, billable - baseDocs);
    const price = modulePrice(db, module, docCount);
    // 未超基线篇数时**不印那个增量项**：印成「240 起（含前 20 篇）+ (5−20)×4 = 240」的话，
    // 式子里挂着一个 −60 的项、右边却还是 240，用户照着算一遍必然对不上。展开算式存在的
    // 全部意义就是让人能自己验算，一条算不通的式子比干脆不给式子更坏。
    if (extra === 0) return `${base} 起（含前 ${baseDocs} 篇，本次 ${billable} 篇）= ${price}`;
    return `${base} 起（含前 ${baseDocs} 篇）+ (${billable}−${baseDocs})×${perExtra} = ${price}`;
  }
  return undefined;
}

/** 核心四项当前总价（venue+entity+graph+docs_list）。守卫与赠送额守护都读它。 */
export function coreBundleTotal(db: Database.Database): number {
  return CORE_MODULES.reduce((sum, m) => sum + modulePrice(db, m, 0), 0);
}

export interface CoreBundleGuard {
  ok: boolean;
  /** 核心四项当前总价。 */
  total: number;
  /** pricing_config 的硬上限（dossier.core_bundle_guard）。 */
  guard: number;
  /** 赠送额可承受的天花板 = REGISTER_GRANT_GONGDAO − SEED.intake（1000 − 300 = 700）。 */
  grantCeiling: number;
}

/**
 * 结构守卫（《方案 v3》§7.2 G1）：核心四项总价 ≤ core_bundle_guard，且该上限 ≤ 赠送额 − 首诊 gate。
 * 违反即 ok=false——守卫测试据此变红（把 dossier.graph 调到 700 ⇒ total 940 > 700 ⇒ 红）。
 * 用途是**测试期钉死配置**，不做运行时 500：调价越线要在 CI 就被拦下，别等上线。
 */
export function coreBundleWithinGuard(db: Database.Database): CoreBundleGuard {
  const total = coreBundleTotal(db);
  const guard = readPrice(db, 'dossier.core_bundle_guard');
  const grantCeiling = REGISTER_GRANT_GONGDAO - SEED.intake;
  return { ok: total <= guard && guard <= grantCeiling, total, guard, grantCeiling };
}

// ───────────────────────────── 库读写 ─────────────────────────────

/** company_dossiers 的一行（本模块只读它的这几列）。 */
export interface DossierRow {
  id: number;
  company_key: string;
  name: string;
  uscc: string | null;
  status: string;
  paid_by: string | null;
  paid_ref: string | null;
  charge_ref: string | null;
  ordered_by_user_id: number | null;
  created_at: string;
}

function findDossierByKey(db: Database.Database, companyKey: string): DossierRow | undefined {
  return db.prepare('SELECT * FROM company_dossiers WHERE company_key=?').get(companyKey) as
    | DossierRow
    | undefined;
}

export function findDossierById(db: Database.Database, id: number): DossierRow | undefined {
  return db.prepare('SELECT * FROM company_dossiers WHERE id=?').get(id) as DossierRow | undefined;
}

/** 这一模块该用户是否已扣过费（消耗流水按幂等键精确命中，含钱付 / 券付 / 免费三种——都落了标记行）。 */
export function isModuleCharged(
  db: Database.Database,
  dossierId: number,
  userId: number,
  module: DossierModule,
): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM gongdao_ledger WHERE type=? AND ref_id=?')
    .get(GONGDAO_LEDGER_TYPE.consume, dossierChargeRef(dossierId, userId, module)) as
    | { hit: number }
    | undefined;
  return row !== undefined;
}

// ───────────────────────────── 报价 ─────────────────────────────

export interface DossierQuoteItem {
  module: DossierModule;
  label: string;
  isCore: boolean;
  priceBasis: PriceBasis;
  /** 本模块单价（公道值）。已付过的为 0。 */
  gongdao: number;
  /** 展开算式（per_doc / base_plus_per_doc 才有；固定价为 undefined）。 */
  formula?: string;
  /**
   * 该用户已为这块付过费（或已用赠送券覆盖）。再次 confirm 不会二次扣费。
   * **注意这不等于「已交付」**——交付进度看采集管线侧，本模块不猜。
   */
  alreadyPaid: boolean;
}

export interface DossierQuote {
  companyKey: string;
  name: string;
  uscc: string | null;
  /** 已有存档则为其 id；从未建过档为 null。 */
  dossierId: number | null;
  /** 计费篇数（= min(探测篇数, cap)）；超 cap 的不入档，不计费。 */
  billableDocs: number;
  items: DossierQuoteItem[];
  /** 本次实际需付原价合计（已付过的不计入；未扣券前）。 */
  total: number;
  /** 核心四项在本单里的应付小计（券可抵扣的额度）。 */
  coreSubtotal: number;
  /** 有未核销的会员赠送券：核心四项本次可全额抵扣。 */
  membershipCreditAvailable: boolean;
  /** 真正会走公道值扣的额（券可用时 = total − coreSubtotal，否则 = total）。gate 与缺口按它算。 */
  payableGongdao: number;
  balance: number;
  /** 余额缺口（够则为 0），按 payableGongdao 算。 */
  shortfall: number;
  /** 发起一次首诊所需的预留（= SEED.intake，300）。赠送额守护黄条用它，不阻断。 */
  intakeReserve: number;
  /** M5 文书取证 SLA（工作日）。 */
  litigationSlaDays: number;
  /** M5 可售门槛（有公开文书链接篇数 < 本值即不卖）。 */
  minDocurlToSell: number;
}

export interface DossierOrderInput {
  name: string;
  uscc?: string | null;
  /** 要买哪几个模块。允许只买核心、或只加深度，不打包硬卖。 */
  modules: readonly DossierModule[];
  /**
   * 有公开文书链接的（可计费）劳动争议篇数，来自免费探测（§2.3）。M5/M6 计价与可售性判据；缺省 0。
   * ⚠️ 权威来源应是服务端探测缓存（company_probe_cache，采集工单）。该表落地前由路由层透传，
   * 是**已知的取数缝**：篇数低于门槛只会被置灰不卖，篇数高只会让用户付更多，两个方向都不放行低价套利。
   */
  docCount?: number;
}

/** 领域层失败（形状与 lib/cases 的 DomainFailure 一致，路由用 domainFailure() 直转 HTTP）。 */
export interface DossierFailure {
  ok: false;
  status: number;
  errorCode: string;
  message: string;
}

export type DossierResult<T> = ({ ok: true } & T) | DossierFailure;

function fail(status: number, errorCode: string, message: string): DossierFailure {
  return { ok: false, status, errorCode, message };
}

/** 去重并按固定顺序（核心在前）排列请求的模块。 */
function normalizeModules(modules: readonly DossierModule[]): DossierModule[] {
  return DOSSIER_MODULES.filter((m) => modules.includes(m));
}

/**
 * 报价。**只读，绝不动钱**（无 settle、无建档、无占额）。
 * 未建过档的公司 dossierId 为 null，此时任何模块都是「未付」。
 * 深度模块（docs_stats/patterns）的可售性与依赖在此校验：不满足直接失败，不静默按默认值报一个数。
 */
export function quoteDossier(
  db: Database.Database,
  userId: number,
  input: DossierOrderInput,
): DossierResult<{ quote: DossierQuote }> {
  const modules = normalizeModules(input.modules);
  if (modules.length === 0) {
    return fail(
      400,
      'DOSSIER_MODULES_EMPTY',
      '没有选择要购买的模块：档案分六个模块（仲裁地实操 / 主体体检 / 关联谱系 / 涉诉清单 / ' +
        '涉诉深度统计 / 人事套路归纳），至少选一个。核心四项与深度两项可分开买。',
    );
  }

  let companyKey: string;
  try {
    companyKey = companyKeyOf(input);
  } catch (err) {
    return fail(400, 'COMPANY_NAME_EMPTY', err instanceof Error ? err.message : String(err));
  }

  const existing = findDossierByKey(db, companyKey);
  const docCount = Math.max(0, Math.trunc(input.docCount ?? 0));
  const minDocurlToSell = readPrice(db, 'dossier.min_docurl_to_sell');

  const wantsDeep = modules.some((m) => isPerDoc(m));
  // M5/M6 可售门槛：有公开文书链接篇数 < 门槛直接置灰不卖（§4.5：不明知故犯地收钱再退款）。
  if (wantsDeep && docCount < minDocurlToSell) {
    return fail(
      409,
      'DOSSIER_DOCS_BELOW_SELL_FLOOR',
      `涉诉深度统计与人事套路归纳暂不可售：该主体有公开文书链接的劳动争议为 ${docCount} 篇，` +
        `低于可售门槛 ${minDocurlToSell} 篇。连样本门槛都够不着就收费再退款是明知故犯，故直接不卖——` +
        '核心四项（仲裁地实操 / 主体体检 / 关联谱系 / 涉诉清单）不受影响，可正常购买。',
    );
  }

  // 依赖：patterns 需要 docs_stats 同单选购、或此前已购。不静默替用户加勾（那会扣走没打算买的钱）。
  for (const m of modules) {
    const dep = MODULE_DEPENDS_ON[m];
    if (!dep) continue;
    const depSelected = modules.includes(dep);
    const depPaid = existing ? isModuleCharged(db, existing.id, userId, dep) : false;
    if (!depSelected && !depPaid) {
      return fail(
        409,
        'DOSSIER_DEPENDENCY_UNMET',
        `「${DOSSIER_MODULE_LABEL[m]}」的输入是「${DOSSIER_MODULE_LABEL[dep]}」抽出的逐字摘录段，` +
          `必须先有它：请把「${DOSSIER_MODULE_LABEL[dep]}」一并勾选，或先单独购买它。`,
      );
    }
  }

  const items: DossierQuoteItem[] = modules.map((module) => {
    const alreadyPaid = existing ? isModuleCharged(db, existing.id, userId, module) : false;
    return {
      module,
      label: DOSSIER_MODULE_LABEL[module],
      isCore: isCoreModule(module),
      priceBasis: MODULE_BASIS[module],
      gongdao: alreadyPaid ? 0 : modulePrice(db, module, docCount),
      formula: isPerDoc(module) ? priceFormula(db, module, docCount) : undefined,
      alreadyPaid,
    };
  });

  const total = items.reduce((sum, it) => sum + it.gongdao, 0);
  const coreSubtotal = items.reduce((sum, it) => sum + (it.isCore ? it.gongdao : 0), 0);
  const membershipCreditAvailable =
    listUnconsumed(db, userId, ENTITLEMENT_KIND.dossierCore).length > 0;
  const payableGongdao = membershipCreditAvailable ? total - coreSubtotal : total;
  const gate = ensureGongdaoAmount(db, userId, payableGongdao);

  return {
    ok: true,
    quote: {
      companyKey,
      name: existing?.name ?? input.name,
      uscc: existing?.uscc ?? input.uscc ?? null,
      dossierId: existing?.id ?? null,
      billableDocs: billableDocs(db, docCount),
      items,
      total,
      coreSubtotal,
      membershipCreditAvailable,
      payableGongdao,
      balance: gate.balance,
      shortfall: gate.ok ? 0 : gate.shortfall,
      intakeReserve: SEED.intake,
      litigationSlaDays: readPrice(db, 'dossier.litigation_sla_days'),
      minDocurlToSell,
    },
  };
}

// ───────────────────────────── 确认扣费 ─────────────────────────────

export interface DossierConfirmed {
  dossierId: number;
  /** 'gongdao'=扣了公道值；'membership_credit'=核销了核心券（深度模块仍可能同时扣了钱）；'none'=全已付。 */
  paidBy: 'gongdao' | 'membership_credit' | 'none';
  /** 本次实际扣的公道值（券覆盖的核心为 0，深度按价）。 */
  charged: number;
  /** 核销掉的赠送券 id（未用券为 null）。 */
  entitlementId: number | null;
  quote: DossierQuote;
}

/**
 * 确认下单：扣费（核心可用赠送券核销）并建档。
 *
 * 【建档、核销券、扣费在同一个事务里，任一步不成整笔回滚】早先那版把余额闸放在事务外面，
 * 「有券但券刚被并发抢走」这条路径上，档案已经插进去了、钱却扣不成——留下一条已建未付的行，
 * 它长得和付过钱的档案一模一样，只能靠对账才发现。现在全在一个事务内：consumeEntitlement 走
 * 内层 SAVEPOINT，外层一抛就连它一起回滚，「没券」与「券被抢走」是同一段代码、不多一条并发分支。
 *
 * 幂等：同一用户对同一家公司重复 confirm，每个模块走同一个 dossierChargeRef，
 * gongdao_ledger 的 (type, ref_id) 唯一索引挡下第二次扣费，第二次 confirm 判为全已付、paidBy='none'。
 * ⚠️ 已知边界：TTL 到期后"再买一次刷新"当前不成立（撞同一幂等键判重放），二次刷新要成立需给每次购买
 * 一个自己的身份，那是另一张工单的事；在它落地前，本函数宁可判重放也不冒「同键扣两次」的险。
 */
export function confirmDossier(
  db: Database.Database,
  userId: number,
  input: DossierOrderInput,
): DossierResult<DossierConfirmed> {
  const quoted = quoteDossier(db, userId, input);
  if (!quoted.ok) return quoted;
  const { quote } = quoted;

  const payable = quote.items.filter((it) => !it.alreadyPaid);

  try {
    return db.transaction((): DossierResult<DossierConfirmed> => {
      // 建档：company_key 唯一，并发下两个请求只落一条，另一条走 SELECT 拿到同一行。
      db.prepare(
        `INSERT OR IGNORE INTO company_dossiers (company_key, name, uscc, ordered_by_user_id)
         VALUES (?,?,?,?)`,
      ).run(quote.companyKey, quote.name, quote.uscc, userId);
      const row = findDossierByKey(db, quote.companyKey);
      if (!row) {
        throw new TxAbort(
          fail(
            500,
            'DOSSIER_CREATE_FAILED',
            `建档失败：company_key「${quote.companyKey}」写入后查不到对应行。` +
              '本次未扣任何费用，可以直接重试；反复出现请把这条错误连同公司名报给我们。',
          ),
        );
      }

      if (payable.length === 0) {
        return { ok: true, dossierId: row.id, paidBy: 'none', charged: 0, entitlementId: null, quote };
      }

      const chargeRefBase = `dossier-${row.id}-u${userId}`;
      const payableCore = payable.filter((it) => it.isCore);
      const payableDeep = payable.filter((it) => !it.isCore);

      // 会员券只覆盖核心四项，且仅当本单确有应付的核心模块时才动用。没券与「券刚被并发抢走」
      // 在这里是同一件事：consumeEntitlement 返回 null，核心照常走公道值扣费。**不静默免单**。
      let entitlementId: number | null = null;
      if (payableCore.length > 0) {
        entitlementId = consumeEntitlement(db, userId, ENTITLEMENT_KIND.dossierCore, `dossier-${row.id}`);
      }
      const usedCredit = entitlementId !== null;

      // 走公道值的模块：券可用时 = 深度模块；券不可用时 = 全部应付模块。
      const gongdaoItems = usedCredit ? payableDeep : payable;
      const chargeTotal = gongdaoItems.reduce((sum, it) => sum + it.gongdao, 0);

      // 余额闸在事务内、在真正扣费之前判：不够就整笔回滚，刚插的档案与刚核销的券一起消失。
      const gate = ensureGongdaoAmount(db, userId, chargeTotal);
      if (!gate.ok) {
        throw new TxAbort(
          fail(
            402,
            'GONGDAO_INSUFFICIENT',
            `公道值不足：本次需要 ${gate.estimate}，当前余额 ${gate.balance}，还差 ${gate.shortfall}。` +
              '差额可以充值补上，也可以只买核心四项（券可抵扣时甚至不花钱）。' +
              '本次没有建档、没有扣任何费用。',
          ),
        );
      }

      let charged = 0;
      // 券覆盖的核心模块：落 delta=0 标记行（不动余额），让「买过没有」对券付也成立。
      if (usedCredit) {
        for (const it of payableCore) {
          gongdaoSettle(userId, 0, dossierChargeRef(row.id, userId, it.module), DOSSIER_MODULE_FEATURE[it.module], null, db);
        }
      }
      // 走公道值的模块：逐块各扣一笔（含 venue 的 0，也落标记行）。退一块不牵连另一块。
      for (const it of gongdaoItems) {
        gongdaoSettle(userId, it.gongdao, dossierChargeRef(row.id, userId, it.module), DOSSIER_MODULE_FEATURE[it.module], null, db);
        charged += it.gongdao;
      }

      const paidBy: 'gongdao' | 'membership_credit' = usedCredit ? 'membership_credit' : 'gongdao';
      stampPayment(db, row, paidBy, usedCredit ? String(entitlementId) : chargeRefBase, chargeRefBase);

      return { ok: true, dossierId: row.id, paidBy, charged, entitlementId, quote };
    })();
  } catch (err) {
    if (err instanceof TxAbort) return err.failure;
    throw err;
  }
}

// ───────────────────────────── 计费实况视图 ─────────────────────────────

export interface DossierModuleBilling {
  module: DossierModule;
  label: string;
  isCore: boolean;
  /** 该用户已为这块付过费（钱付/券付/免费都算；已退款的仍算付过——退款是另一件事）。 */
  paid: boolean;
  /** 实扣公道值（券付/免费为 0）。 */
  charged: number;
  /** 已退回公道值（未退为 0）。退了就说明这块没交付或没达标。 */
  refunded: number;
}

export interface DossierBillingView {
  dossier: DossierRow;
  modules: DossierModuleBilling[];
  /** 该用户在本档案上的净支出（扣费合计 − 退款合计）。 */
  netGongdao: number;
  /** 本单核心走的是会员赠送券（该用户名下有一张核销去向指向本档案的券）。 */
  paidByMembershipCredit: boolean;
}

/**
 * 谁能看这条档案：下单人本人、为它付过任一模块的人、或用赠送券换过它核心的人。
 * 档案是**公司维度的平台资产**（同一家公司全站一条），归属判据不照抄 cases 的 user_id 相等——
 * 那样第二位付费的用户会被挡在门外。
 */
export function hasDossierAccess(db: Database.Database, dossierId: number, userId: number): boolean {
  const row = findDossierById(db, dossierId);
  if (!row) return false;
  if (row.ordered_by_user_id === userId) return true;
  if (DOSSIER_MODULES.some((m) => isModuleCharged(db, dossierId, userId, m))) return true;
  const credit = db
    .prepare('SELECT 1 AS hit FROM entitlements WHERE user_id=? AND kind=? AND consumed_ref=?')
    .get(userId, ENTITLEMENT_KIND.dossierCore, `dossier-${dossierId}`) as { hit: number } | undefined;
  return credit !== undefined;
}

/** 某笔幂等键对应的实扣额（无该笔返回 0）。 */
function chargedAmount(db: Database.Database, chargeRef: string): number {
  const row = db
    .prepare('SELECT -delta AS amount FROM gongdao_ledger WHERE type=? AND ref_id=?')
    .get(GONGDAO_LEDGER_TYPE.consume, chargeRef) as { amount: number } | undefined;
  return row?.amount ?? 0;
}

/** 某笔幂等键对应的已退额（无退款返回 0）。退款键由 gongdaoRefund 拼成 `refund-<chargeRef>`。 */
function refundedAmount(db: Database.Database, chargeRef: string): number {
  const row = db
    .prepare('SELECT delta AS amount FROM gongdao_ledger WHERE type=? AND ref_id=?')
    .get(GONGDAO_LEDGER_TYPE.refund, `refund-${chargeRef}`) as { amount: number } | undefined;
  return row?.amount ?? 0;
}

/**
 * 一条档案对某个用户的**计费实况**（逐模块：付了多少、退了多少）。
 * 【本视图不含采集进度】「哪个模块跑到哪一步了」归采集管线侧，本函数一个字都不猜——
 * 在这里编一个进度字段出来，会让前端拿到一个永远停在某状态、看起来却完全正常的假进度。
 */
export function getDossierBillingView(
  db: Database.Database,
  dossierId: number,
  userId: number,
): DossierBillingView | null {
  const dossier = findDossierById(db, dossierId);
  if (!dossier || !hasDossierAccess(db, dossierId, userId)) return null;

  const modules = DOSSIER_MODULES.map((module) => {
    const ref = dossierChargeRef(dossierId, userId, module);
    return {
      module,
      label: DOSSIER_MODULE_LABEL[module],
      isCore: isCoreModule(module),
      // paid 看**有没有那笔流水**，不看金额是否 > 0：券付/免费也落 delta=0 标记行，那也是「买过了」。
      // 按金额判会让这种单显示成「未购买」，然后被再卖一次。
      paid: isModuleCharged(db, dossierId, userId, module),
      charged: chargedAmount(db, ref),
      refunded: refundedAmount(db, ref),
    };
  });

  const credit = db
    .prepare('SELECT 1 AS hit FROM entitlements WHERE user_id=? AND kind=? AND consumed_ref=?')
    .get(userId, ENTITLEMENT_KIND.dossierCore, `dossier-${dossierId}`) as { hit: number } | undefined;

  return {
    dossier,
    modules,
    netGongdao: modules.reduce((sum, b) => sum + b.charged - b.refunded, 0),
    paidByMembershipCredit: credit !== undefined,
  };
}

/**
 * 事务内的失败必须**抛**出去，不能 return。
 * better-sqlite3 的 db.transaction() 只在回调抛异常时回滚；直接 return 一个失败对象，
 * 前面刚插进去的 company_dossiers 那一行会被照常提交——留下一条已建档、没付钱、
 * 与正常档案长得一模一样的行。本类就是把「失败」包成异常，让回滚和返回值两件事都对。
 */
class TxAbort extends Error {
  constructor(readonly failure: DossierFailure) {
    super(failure.message);
    this.name = 'TxAbort';
  }
}

/**
 * 在档案上盖付款留痕。**只盖第一次**（`paid_by IS NULL` 守卫）：
 * 档案是公司维度的共享资产，同一条档案可以先后被多个用户付费，而这三列只有一份。
 * 后来者的凭据在各自的 gongdao_ledger 流水（ref_id 含自己的用户 id）与 entitlements.consumed_ref 里，
 * 不会丢；但若每次都覆写，第一位付款人的凭据就被抹掉了——那是真正会丢的那一份。
 */
function stampPayment(
  db: Database.Database,
  row: DossierRow,
  paidBy: 'gongdao' | 'membership_credit',
  paidRef: string,
  chargeRef: string,
): void {
  db.prepare(
    'UPDATE company_dossiers SET paid_by=?, paid_ref=?, charge_ref=? WHERE id=? AND paid_by IS NULL',
  ).run(paidBy, paidRef, chargeRef, row.id);
}
