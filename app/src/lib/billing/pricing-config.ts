// app/src/lib/billing/pricing-config.ts
// pricing_config 表的**唯一读入口**：定额报价、样本门槛、SLA 天数、缓存 TTL 全走这里。
//
// ── 为什么是表而不是常量（这条有一次真实事故路径）──
// 「可调不硬编码」的第一直觉是把服务定额塞进 skus 表。**不能这么做**：
// fulfillment.resolveSkuKind 按 name 判定 SKU 语义，未知 name 一律兜底为「散充」，
// 按 amount_fen×100 入账（有意为之，见该函数注释）。往 skus 里塞一行「档案·主体体检」，
// 用户一旦经下单路径碰到它，就会被当成充值订单履约——**收了钱当充值入账，服务不交付**。
// 所以服务定额走本文件这张独立表；__tests__/pricing-config.test.ts 有结构守卫
// 遍历 skus 全部 name，出现服务名即报红。
//
// ── 常量是兜底，不是事实源 ──
// 表里有行即以表为准（改价改表、不改代码、不重启进程）；缺行才回落常量。
// 反过来写（以常量为准、表做覆盖）就等于改价还得发版，那张表也就白建了。
// 于是「线上现在按多少收」是一个可以查、可以改、可以留 note 说明为什么改的东西，而不是一次发版。
//
// ── 两个读函数，一个读点 ──
// 本表存的不只是价：`dossier.min_sample_outcome` 是篇数、`dossier.litigation_sla_days` 是天数、
// `dossier.ttl_graph_days` 是天数。所以对外有两个函数，语义不同、但**共用同一条 SQL**：
//   · readPrice(db, key)          —— 计费侧用。键必须登记在 PRICE_FALLBACK 里（拼错键名编译不过），
//                                    兜底值随键走；负值/小数当场抛。
//   · readConfigInt(db, key, fb)  —— 采集管线侧用。兜底由**调用方显式给**：不设「全局默认表」，
//                                    否则「这个键没配」与「这个键配成了默认值」在读侧长得一模一样，
//                                    而前者是配置漏了、后者是有人特意设成这个数。
// **不要再写第三个直连 pricing_config 的读法**：一张表多个读入口，改一处忘一处。
// 两侧共用的键（如 dossier.min_sample_outcome / dossier.probe_free_per_day）两处兜底值必须相等，
// 由 __tests__/pricing-config.test.ts 机检——否则同一个键在两条代码路径上是两个数。
import type Database from 'better-sqlite3';

/**
 * 全部可配置键 → 缺行时的兜底值。**新增键必须在这里登记**：readPrice 的入参类型就是本对象的键，
 * 没登记的键连编译都过不去（拼错键名静默回落 0 是一条会直接漏钱的路径，用类型堵死）。
 *
 * 价格档（公道值）取《公司档案模块化方案 v3》§6.4 定稿。六个一次性模块拆包计价：
 *   核心四项 = 仲裁地实操 0 + 主体体检 60 + 关联谱系 200 + 涉诉清单 80 = 340；
 *   深度两项 = 涉诉深度统计 70/篇（cap 30，超 30 不入档）+ HR 套路归纳 240 起（第 21 篇起每篇 +4）。
 * 若 manager 改判，**不需要改这里**——那是往 pricing_config 写几行的事；本文件的值只是「表空着时按什么跑」。
 */
export const PRICE_FALLBACK = {
  // ── 一次性模块定额（M1–M4 固定价；M5/M6 的单价与基价，逐篇量由报价流按探测篇数算）──
  /** M1 仲裁地实操：全站共享的预生成辖区卡，用户侧零 LLM 调用，边际零成本 → 0（信任锚）。 */
  'dossier.venue': 0,
  /** M2 主体体检：工商快照明细 + 规则判定卡，秒级必定有货。 */
  'dossier.entity': 60,
  /** M3 关联谱系：股权/对外投资/关系边归纳。低于全站结构线 3.0，每次让利 40（须显式过审）。 */
  'dossier.graph': 200,
  /** M4 涉诉清单：案号级归集，撞墙前最后一块，便宜到没人犹豫。 */
  'dossier.docs_list': 80,
  /** M5 涉诉深度统计：**每篇**单价。总价 = min(篇数, cap) × 本值。 */
  'dossier.docs_stats_per_doc': 70,
  /** M5 计费篇数上限。超出的篇数**不入档、不处理、不计费**（页面明写，堵我方无帽成本敞口）。 */
  'dossier.docs_stats_cap_docs': 30,
  /** M6 HR 套路归纳基价：覆盖到 patterns_base_docs 篇的参考点（骨架锁「20 篇处恰为 240」）。 */
  'dossier.patterns_base': 240,
  /** M6 基价覆盖的篇数。第 (本值+1) 篇起每篇加 patterns_per_extra_doc。 */
  'dossier.patterns_base_docs': 20,
  /** M6 增量单价：第 21 篇起每篇 +4（成本随摘录篇数线性涨，防高篇数处比值跌破成本线）。 */
  'dossier.patterns_per_extra_doc': 4,

  // ── 结构守卫 ──
  /**
   * 核心四项（venue+entity+graph+docs_list）总价硬上限。
   * = REGISTER_GRANT_GONGDAO(1000) − SEED.intake(300) = 700：核心档案花光赠送就把用户堵在首诊门口。
   * 守卫测试读它；核心四项总价 > 本值即报红（见 dossier-billing.coreBundleWithinGuard 与其变异臂）。
   */
  'dossier.core_bundle_guard': 700,

  // ── 可售性门槛 / 退款门槛（红线绑到钱上，缺一它就退回成一句小字文案）──
  /** M5 可判定结果篇数下限：不足则整块不出比例、并自动全额退（保留逐篇明细）。 */
  'dossier.min_sample_outcome': 5,
  /** M5 可售门槛：有公开文书链接的劳动争议篇数 < 本值直接置灰不卖（不明知故犯地收钱再退款）。 */
  'dossier.min_docurl_to_sell': 5,
  /** M3 高置信关系边下限：交付后低于本值全额退（保留低置信节点与边可看，只是不作数）。 */
  'dossier.min_graph_high_conf_edges': 2,
  /** M6 保留 pattern 条目下限：低于本值全额退（含"全部被丢=0"），dropped 计数后台可查。 */
  'dossier.min_patterns_kept': 3,
  /** M5 文书取证 SLA（工作日）：超期未交付自动全额退（保留已入档条目，不退不删 M1–M4）。 */
  'dossier.litigation_sla_days': 7,

  // ── 免费前置探测（获客补贴，非"边际成本为 0"）──
  /**
   * 登录后每用户每日免费探测次数。**这是获客补贴、不是零成本动作**：缓存未命中时要真去采集侧
   * 拉一次（住宅代理 + 外勤工作站在线分摊，量级约 0.1~0.5 元/次，非精算）。v2 的 5 下调为 2，
   * 先把"被竞品白嫖公司库"的未知敞口收窄，采集侧成本表出来后再复核放宽与否。
   * 采集侧经 readConfigInt 读同一个键，兜底常量在 lib/company/probe.ts（两处必须相等，有机检）。
   */
  'dossier.probe_free_per_day': 2,

  // ── 耗算力的内容提取与解读（设计稿 §6；报价→确认→扣费走 lib/billing/service-quotes）──
  // 单位都写在键名里（per_page / per_minute / per_doc / per_item），不靠调用方记得换算：
  // 一个叫 `asr.price` 的键在两个调用点被当成「每分钟」和「每次」是查不出来的账。
  /** 图片/PDF 每页 OCR。 */
  'ocr.per_page': 5,
  /** 录音每分钟转写（含说话人分离）。不足一分钟按一分钟，取整口径只在 unitsFromSeconds 一处。 */
  'asr.per_minute': 8,
  /** 视频每分钟（抽音轨转写 + 关键帧识别）。 */
  'video.per_minute': 12,
  /** 来文解读每份（含 OCR 与审查规则命中）。 */
  'doc_review.per_doc': 20,
  /** 证据简报每件（含在提取价里，单独重生成时才收）。 */
  'brief.per_item': 3,
  /** 报价有效期（分钟）。过了这个点确认一律 QUOTE_EXPIRED，须重新报价。 */
  'quote.ttl_minutes': 30,

  // ── 守望订阅档位（M7；本表登记为价目事实源，计费流由守望工单消费，不在本模块）──
  /** 守望·圈1（每日巡检）月费/主体。 */
  'watch.tier.daily': 199,
  /** 守望·圈2（每周巡检）月费/主体。 */
  'watch.tier.weekly': 60,
  /** 守望·圈3（存档不监控）月费/主体——本就不巡检，收费即欺诈，恒 0。 */
  'watch.tier.archive': 0,
} as const;

/** 可配置键（= PRICE_FALLBACK 的键集）。 */
export type PriceKey = keyof typeof PRICE_FALLBACK;

/** 全部可配置键（供遍历/结构守卫测试用）。 */
export const PRICE_KEYS = Object.keys(PRICE_FALLBACK) as PriceKey[];

/**
 * 采集管线侧读的键（兜底由调用方给，故不登记在 PRICE_FALLBACK 里）。
 * 与 PriceKey 有交集（min_sample_outcome / probe_free_per_day 两支都读），交集处两边兜底必须一致。
 */
export type PipelineConfigKey =
  | 'dossier.min_sample_outcome'
  | 'dossier.min_sample_duration'
  | 'dossier.litigation_sla_days'
  | 'dossier.ttl_graph_days'
  | 'dossier.ttl_litigation_days'
  | 'dossier.probe_free_per_day'
  | 'dossier.probe_ttl_hours';

/** 本仓用到的全部键（值集与 docs 同步；TEXT 主键不加 CHECK，值集由本层把关）。 */
export type PricingConfigKey = PriceKey | PipelineConfigKey;

/**
 * 表里那一行的原始值；缺行返回 undefined。
 * **全仓读 pricing_config 的唯一一条 SQL**——readPrice 与 readConfigInt 都从这里取，
 * 各自做各自的合法性判断与文案。多写一条 SELECT 就等于多一个改一处忘一处的入口。
 */
function readRawValue(db: Database.Database, key: string): number | undefined {
  const row = db.prepare('SELECT value_int FROM pricing_config WHERE key = ?').get(key) as
    | { value_int: number }
    | undefined;
  return row?.value_int;
}

/**
 * 读一个定额/阈值：表里有行即用表值，缺行回落 PRICE_FALLBACK。
 *
 * 负值直接抛而不是回落：一个负的价目会在结算时**给用户加钱**，
 * 而回落到常量会让这条配置错误彻底看不见——运维改错一个数，账面上什么都不会发生，
 * 直到有人对账才发现。宁可这个端点当场 500，也不要静默按错价跑。
 */
export function readPrice(db: Database.Database, key: PriceKey): number {
  const value = readRawValue(db, key);
  if (value === undefined) return PRICE_FALLBACK[key];
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `价目配置非法：pricing_config 里「${key}」的 value_int = ${value}。` +
        `该列必须是非负整数（公道值/天数/篇数都没有负数与小数语义），负值会在结算时反向给用户加钱。` +
        `请把该行改成合法值，或直接删掉该行——删行即回落代码兜底值 ${PRICE_FALLBACK[key]}。`,
    );
  }
  return value;
}

/**
 * 读一个整数配置：表里有行取表，缺行取调用方给的 fallback。**每次调用都查库**——
 * 不做进程内缓存：改表要立刻生效，不能要求重启（重启才生效的配置等于没有配置）。
 *
 * 表里存了非整数（被人手工写脏）时当场抛错，不静默取整：一个被悄悄截断的门槛
 * 会让「样本不足不出数」这条红线在某个边界上安静失效。
 */
export function readConfigInt(
  db: Database.Database,
  key: PricingConfigKey | string,
  fallback: number,
): number {
  const value = readRawValue(db, key);
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) {
    throw new Error(
      `pricing_config 的 ${key} 不是整数（读到 ${JSON.stringify(value)}）：` +
        '本表只存整数（公道值 / 篇数 / 天数），非整数多半是人工改表时写错了列；' +
        `请把该行改成整数，或删掉该行让它回落代码常量（${fallback}）。`,
    );
  }
  return value;
}
