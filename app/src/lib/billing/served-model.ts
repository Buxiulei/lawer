// app/src/lib/billing/served-model.ts
// 「请求的型号」与「实际服务的型号」对账——记账点的最后一道关（评测遗留②）。
//
// 【为什么必须有这一层】routing.config.ts 文件头早就写下了这条残留风险：
//   「别名日后被厂商重新指向新快照时，priced 会与实际计费口径脱节。这一层 API 侧堵不住，
//     只能靠对账发现——流式响应会回显实际 model，billing 侧建议存下来与 api 串比对。」
// 而中转（providers/relay.ts 文件头实测）比这更活跃：**同一个 model 名在不同请求可能落到
// 不同上游渠道**。于是「请求 opus」和「拿到 opus」是两件事，中间隔着一个我们不控制的路由器。
// 在此之前，记账一律按**请求**的型号计价——中转把 opus 请求路由到 sonnet 返回，
// 我们照 opus 的价（$5/$25）向用户收钱，而用户拿到的是 sonnet（$2/$10）。那是 2.5 倍的错账，
// 且方向朝着用户吃亏——这是钱的地基上唯一不能容忍的方向。
//
// 【方向铁律：两个方向都偏向用户——billed = min(rate(requested), rate(served))】
// 换型号有两个方向，铁律只有一条「宁可少扣不可多扣」(billing/index.ts 铁律4)，落到计价上就是取两者较低价：
//   · 降档（served 比 requested 便宜，如请求 opus 回 sonnet）：按 **served** 收——用户不为没拿到的高档付费；
//   · 升档（served 比 requested 贵，如请求 sonnet 回 opus）：按 **requested** 收——用户不为中转擅自的升档买单，
//     多出的成本由我们/中转吃。「照 served 收」在升档方向同样是那 2.5 倍错账里「朝用户吃亏」的另一半，一样不容忍。
// 判「哪个便宜」要有费率，故本层收一个 rateOf 解析器（生产侧查 model_rates，单测传桩）：四档逐档比，
// 只有 served 全部 ≤ requested 才降到 served。缺 rateOf 时退回「按 served 计价」的身份口径（只解析实际服务了谁、
// 不做方向裁决）——生产两个记账点(orchestrator/backfill)都必须传 rateOf，才谈得上升档那一半的封堵。
//
// 【认不出时为什么不按兜底价计，而是维持请求价】DEFAULT_RATES 是「没配费率也要记账」的下限，
// 不是定价（pricing.ts 原话）。认不出的回显串绝大多数是**同族的日期快照**
//（厂商给 claude-opus-5 追加了日期后缀），拿最便宜的兜底档去计它，等于每一次 opus 调用
// 都漏收一个数量级——那不是谨慎，是拿兜底值当价格用。我们不知道就不猜价，
// 维持请求价并把这一轮**标记出来**（api_model 落列 + ledger meta + notice + 对账探针），
// 让它以「可复算的一批」而不是「一个静默的错数」存在。
//
// 【留给读者的 trade-off】因此 'unrecognized' 这一档确实可能让用户多付——
// 代价换的是不制造一个凭空的低价。真出现时该做的是把新串登记进 MODELS，而不是改这里的兜底。

import { MODELS, RELAY_BILLING_PREFIX } from '@/lib/llm/routing.config';
import type { Variant } from '@/lib/llm/routing.config';
import type { TokenRates } from './pricing';

/** 厂商 API 别名 → 计费锁定串。MODELS 是唯一登记处，这里只做反查，不另立一套型号表。 */
const PRICED_OF_API: ReadonlyMap<string, string> = new Map(
  Object.values(MODELS).map((m) => [m.api, m.priced] as const),
);

/** 计费键里允许出现的变体后缀。只认这两个词，避免把 priced 串里本来就有的冒号当成变体切掉。 */
const VARIANT_SUFFIXES: readonly Variant[] = ['think', 'nothink'];

/**
 * 对账结论：
 *  - 'absent'       本次流没回显型号（保活行/老网关/非流式降级）→ 按既有口径计价，不告警。
 *  - 'match'        回显与请求一致 → 原样计价，不告警。
 *  - 'substituted'  回显是**另一个我们认得的型号** → 按 requested/served 两者较低价计价 + 落痕（billed 记较低那个）。
 *  - 'unrecognized' 回显是我们没登记过的串 → 维持请求价 + 落痕（见文件头 trade-off）。
 */
export type ServedVerdict = 'absent' | 'match' | 'substituted' | 'unrecognized';

/** 落进 gongdao_ledger.meta_json 的审计痕。字段名短且稳定：对账脚本要按它们查。
 *  写成 type 而非 interface 是有意的：它要直接当 gongdaoSettle 的
 *  `Record<string, unknown>` 传进去，而 interface 拿不到隐式索引签名。 */
export type ServedModelTrace = {
  /** 我们本来要记的计费键（没有这次对账的话就按它收钱了） */
  requested: string;
  /** 厂商回显的实际服务型号串 */
  served: string;
  /** 本轮实际用于计价的计费键 */
  billed: string;
  verdict: Extract<ServedVerdict, 'substituted' | 'unrecognized'>;
};

export interface ServedReconciliation {
  verdict: ServedVerdict;
  /** 本轮该用的计费键（查 model_rates 用它，也写进 token_usage.model） */
  billingModel: string;
  /** 需要落审计痕时的 meta；一致或未回显时为 null（不给正常轮塞噪声） */
  trace: ServedModelTrace | null;
}

/**
 * 把请求的计费键换成「服务型号的计费键」，前缀与变体后缀原样保留。
 * `relay/claude-opus-5` + served priced `claude-sonnet-5` → `relay/claude-sonnet-5`。
 *
 * 前缀保留是因为**它经的还是中转那条线路**，中转的价是「上游官方价 × 倍率」，
 * 换了型号不等于换回直连价（routing.config.RELAY_BILLING_PREFIX 原话）。
 * 变体后缀保留是因为变体是我们**下发的请求参数**（如 enable_thinking:false），
 * 换谁来服务这个参数都照样发出去了。
 */
function swapPriced(requestedBillingModel: string, servedPriced: string): string {
  const hasRelay = requestedBillingModel.startsWith(RELAY_BILLING_PREFIX);
  const body = hasRelay ? requestedBillingModel.slice(RELAY_BILLING_PREFIX.length) : requestedBillingModel;
  const colon = body.lastIndexOf(':');
  const suffix =
    colon > 0 && (VARIANT_SUFFIXES as readonly string[]).includes(body.slice(colon + 1))
      ? body.slice(colon)
      : '';
  return `${hasRelay ? RELAY_BILLING_PREFIX : ''}${servedPriced}${suffix}`;
}

/**
 * requested 与 served 两个计费键里更便宜的那个——四档费率逐档比较（铁律4「宁可少扣不可多扣」）。
 * 只有 served 在四档上**全部 ≤** requested 时才降到 served 计价（降档）；否则维持 requested
 *（升档：requested 更便宜，用户不为中转擅自的升档买单）。四档全比而非只看一档：换型号可能只有
 * 部分档更贵，任一档更贵就不算「整体更便宜」，不降——这样两个方向取的都是不高于任一候选的价。
 */
function cheaperBillingModel(
  requestedBillingModel: string,
  servedBillingModel: string,
  rateOf: (billingModel: string) => TokenRates,
): string {
  const rq = rateOf(requestedBillingModel);
  const sv = rateOf(servedBillingModel);
  const servedNotDearer =
    sv.in <= rq.in && sv.out <= rq.out && sv.cacheRead <= rq.cacheRead && sv.cacheWrite <= rq.cacheWrite;
  return servedNotDearer ? servedBillingModel : requestedBillingModel;
}

/**
 * 记账点的型号对账。**确定性**：不读库、不写库、不抛错——判据只依赖入参（rateOf 是注入的纯查表器，
 * 生产侧包 model_rates、单测传桩），所以它在单测里能被穷举，不需要拉起一整条流。
 *
 * 【为什么只收计费键、不收 API 别名】判「一不一致」的口径必须是**钱**的口径：
 * 真正要紧的不是「回显串和我们发出去的串是否逐字相同」，而是「该按哪个费率收」。
 * 所以两边都换算到计费键再比。附带的好处是回填脚本也能用——
 * 它手里只有落库的 tokens_json（计费键 + 回显串），从来没有 Provider.model 那个别名。
 *
 * @param requestedBillingModel 我们本来要记的计费键（Provider.billingModel / tokens_json.model）
 * @param servedModel           厂商回显的实际服务型号（UsageReport.servedModel），null=未回显
 * @param rateOf                计费键 → 四档费率的查表器（生产侧包 model_rates）。传了才做升/降档方向裁决
 *                              （取两者较低价）；不传则退回「按 served 计价」的身份口径。
 */
export function reconcileServedModel(
  requestedBillingModel: string,
  servedModel: string | null,
  rateOf?: (billingModel: string) => TokenRates,
): ServedReconciliation {
  const served = servedModel?.trim();
  // 未回显：按既有兜底走原价。这是**常态**（不是每个网关都回显），不该产生告警噪声。
  if (!served) return { verdict: 'absent', billingModel: requestedBillingModel, trace: null };

  const servedPriced = PRICED_OF_API.get(served);
  if (servedPriced === undefined) {
    // 认不出：维持请求价，但把这一轮标出来（见文件头）。
    return {
      verdict: 'unrecognized',
      billingModel: requestedBillingModel,
      trace: { requested: requestedBillingModel, served, billed: requestedBillingModel, verdict: 'unrecognized' },
    };
  }

  const servedKey = swapPriced(requestedBillingModel, servedPriced);
  // 换算到同一个计费键 = 钱没算错，就是一致（回显串与请求的 API 别名逐字相同时必然走这条）。
  if (servedKey === requestedBillingModel) {
    return { verdict: 'match', billingModel: servedKey, trace: null };
  }
  // 换了型号：取两者较低价（铁律4）。缺 rateOf 时退回「按 served」的身份口径，不做方向裁决。
  const billed = rateOf ? cheaperBillingModel(requestedBillingModel, servedKey, rateOf) : servedKey;
  return {
    verdict: 'substituted',
    billingModel: billed,
    trace: { requested: requestedBillingModel, served, billed, verdict: 'substituted' },
  };
}
