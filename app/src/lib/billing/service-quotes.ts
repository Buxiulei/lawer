// app/src/lib/billing/service-quotes.ts
// 耗算力服务的「报价 → 确认 → 扣费」统一流（设计稿 §4.2）。
//
// 本文件是 lib/company/dossier-billing.ts 那套三段式的**泛化**：那边的六个模块写死在
// 公司档案里，这边只认「一个服务 × 一个计价单位 × 一个数量」。三条铁律逐字沿用：
//
//   ① 报价**绝不动钱**。quoteService 只落一行 service_quotes，不 settle、不占额度、
//      不核销券——「报个价就被扣了」是本产品最不能出的一类事故，有独立对照判据
//      （余额与 gongdao_ledger 行数在 quote 前后逐字相等）。
//   ② 扣费一律经 lib/billing 的 gongdaoSettle，**不直写 gongdao / gongdao_ledger**。
//      幂等、事务、负余额语义都长在那几个函数里，绕过去就等于把它们全丢了。
//   ③ 没扣钱的单必须能查出为什么：券付的单在 service_quotes.entitlement_id 与
//      entitlements.consumed_ref 两处同时留痕。只留一处，事后分不清是「送的」还是「漏扣的」。
//
// 【为什么报价要落库，不是签一个自证 token】报价上写的价必须与确认时扣的价是同一个数。
// 中途有人改了 pricing_config，token 里那个数就成了「用户看到的价」与「实际扣的价」的分歧点，
// 而两边都不会报错。落一行、确认时按 id 取回，价就只有一处。
//
// 【dossier / watch 为什么在值域里却不在这里计价】service_quotes.service 的值域覆盖全部
// 走报价流的服务，好让后台一张表看全部订单；但公司档案与守望订阅今天各有自己的计价逻辑
// （模块拆包 / 按 tier 月费），迁过来是 P3 的事。所以**类型上分成两层**：ServiceKind 是
// 列的值域，PricedService 是本文件真能计价的那五个——传 'dossier' 进 quoteService 编译不过，
// 不必在运行时写一条「这个服务本函数不接」的分支去挡一个类型已经挡住的入参。
import type Database from 'better-sqlite3';

import { ensureGongdaoAmount } from './estimate';
import { ENTITLEMENT_KIND, consumeEntitlement } from './entitlements';
import { featureLabel } from './features';
import { gongdaoExhaustedMessage, gongdaoSettle } from './index';
import { readPrice, type PriceKey } from './pricing-config';
import { nowSql, toSql } from '../db/time';

/** service_quotes.service 的值域（= 全部走报价流的服务，含尚未迁到本文件的两个）。 */
export type ServiceKind =
  | 'ocr'
  | 'asr'
  | 'video'
  | 'doc_review'
  | 'brief'
  | 'dossier'
  | 'watch';

/** 本文件真能计价的服务。dossier / watch 见文件头说明。 */
export type PricedService = 'ocr' | 'asr' | 'video' | 'doc_review' | 'brief';

export const PRICED_SERVICES: readonly PricedService[] = [
  'ocr',
  'asr',
  'video',
  'doc_review',
  'brief',
];

/**
 * 服务 → gongdao_ledger.feature 键（须与 lib/billing/features.ts 登记的一致，用量明细出中文靠它）。
 * 用户可见的中文名**不在这里再抄一份**，一律 featureLabel(SERVICE_FEATURE[s]) 取——
 * 抄第二份就会出现同一个服务在报价页叫一个名、在账单里叫另一个名，两处都不报错。
 */
export const SERVICE_FEATURE: Record<PricedService, string> = {
  ocr: 'ocr',
  asr: 'asr',
  video: 'video',
  doc_review: 'doc_review',
  brief: 'brief',
};

/**
 * 服务 → 计价键与单位名。单位写在键名里（per_page / per_minute / per_doc / per_item），
 * 报价的算式也照它印给用户看：「录音分析 8 公道值/分钟 × 12 分钟 = 96」。
 */
const SERVICE_PRICING: Record<PricedService, { priceKey: PriceKey; unitLabel: string }> = {
  ocr: { priceKey: 'ocr.per_page', unitLabel: '页' },
  asr: { priceKey: 'asr.per_minute', unitLabel: '分钟' },
  video: { priceKey: 'video.per_minute', unitLabel: '分钟' },
  doc_review: { priceKey: 'doc_review.per_doc', unitLabel: '份' },
  brief: { priceKey: 'brief.per_item', unitLabel: '件' },
};

/**
 * 秒 → 计费分钟数（不足一分钟按一分钟）。**向上取整的口径只在这一处**：
 * 让每个调用点自己 Math.ceil，就会有人写 Math.round，于是 89 秒的录音在一条路径上收 2 分钟、
 * 在另一条路径上收 1 分钟，而两处都跑得通。
 */
export function unitsFromSeconds(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

/**
 * 扣费幂等键的**唯一生成入口**。格式 `svc-<报价id>-u<用户id>`：
 *   · 含报价 id ⇒ 同一用户对同一份材料再报一次价是另一笔，不会被上一笔挡掉；
 *   · 含用户 id ⇒ 报价 id 与用户绑定后仍显式写进键里，读账本的人不必回查 service_quotes。
 * 退款键由 gongdaoRefund 自己拼成 `refund-<本串>`，故本串一变退款幂等也跟着变——别在别处另拼一份。
 */
export function serviceChargeRef(quoteId: number, userId: number): string {
  return `svc-${quoteId}-u${userId}`;
}

// ───────────────────────────── 结果类型 ─────────────────────────────

export interface ServiceFailure {
  ok: false;
  status: number;
  errorCode: string;
  message: string;
}

export type ServiceResult<T> = ({ ok: true } & T) | ServiceFailure;

function fail(status: number, errorCode: string, message: string): ServiceFailure {
  return { ok: false, status, errorCode, message };
}

class TxAbort extends Error {
  constructor(readonly failure: ServiceFailure) {
    super(failure.message);
    this.name = 'TxAbort';
  }
}

// ───────────────────────────── 报价 ─────────────────────────────

export interface ServiceQuotePayload {
  /** 计费单位数量（页 / 分钟 / 份 / 件），正整数。分钟一律经 unitsFromSeconds 取整。 */
  units: number;
  /** 这次针对哪件证据。只为对账留痕（payload_json 要能复算这个价），计价不读它。 */
  evidenceId?: number;
}

export interface QuoteServiceInput {
  userId: number;
  caseId: number;
  service: PricedService;
  payload: ServiceQuotePayload;
}

/** 报价的算式，逐项印给用户看——只给一个总数的报价，用户没法判断贵在哪。 */
export interface ServiceQuoteBreakdown {
  service: PricedService;
  /** 用户可见中文名，取自 features 的单一事实源。 */
  label: string;
  unitPrice: number;
  units: number;
  unitLabel: string;
  /** 这个价读的是 pricing_config 的哪个键（改价的人照它去改表，不必翻代码）。 */
  priceKey: PriceKey;
}

export interface ServiceQuote {
  /** 对外（MCP / REST）字段名是 quote_id，转换在工具壳里做，本层保持仓内 camelCase 风格。 */
  quoteId: number;
  amount: number;
  breakdown: ServiceQuoteBreakdown;
  /** canonical 串（见 lib/db/time）。对外字段名是 expires_at。 */
  expiresAt: string;
}

/**
 * 报价。**只读钱、不动钱**：本函数唯一的写入是往 service_quotes 落一行报价，
 * 既不 settle、也不核销券、也不占额度。
 *
 * 案件归属在这里就判：报价单上带着 case_id，让不是本人的案件也能报出价来，
 * 等于把「这个案件存不存在」变成一个可探测的信号（同 CASE_NOT_FOUND 那条：
 * 「不存在」与「不是你的」刻意不区分）。
 */
export function quoteService(
  db: Database.Database,
  input: QuoteServiceInput,
): ServiceResult<{ quote: ServiceQuote }> {
  const { userId, caseId, service, payload } = input;
  const units = payload.units;
  if (!Number.isInteger(units) || units <= 0) {
    return fail(
      400,
      'INVALID_UNITS',
      `计费数量不合法：收到 ${JSON.stringify(units)}，必须是正整数` +
        `（${SERVICE_PRICING[service].unitLabel}数）。录音与视频的分钟数请经 unitsFromSeconds 取整后再传。`,
    );
  }

  const owns = db
    .prepare('SELECT id FROM cases WHERE id=? AND user_id=?')
    .get(caseId, userId) as { id: number } | undefined;
  if (!owns) {
    return fail(
      404,
      'CASE_NOT_FOUND',
      `案件 ${caseId} 不存在，或不属于本人（两者刻意不区分）。先取本人名下真实的案件编号再报价。`,
    );
  }

  const { priceKey, unitLabel } = SERVICE_PRICING[service];
  const unitPrice = readPrice(db, priceKey);
  const amount = unitPrice * units;
  const ttlMinutes = readPrice(db, 'quote.ttl_minutes');
  const expiresAt = toSql(new Date(Date.now() + ttlMinutes * 60_000));

  const id = Number(
    db
      .prepare(
        `INSERT INTO service_quotes (user_id, case_id, service, payload_json, amount, expires_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(userId, caseId, service, JSON.stringify(payload), amount, expiresAt).lastInsertRowid,
  );

  return {
    ok: true,
    quote: {
      quoteId: id,
      amount,
      breakdown: {
        service,
        label: featureLabel(SERVICE_FEATURE[service]),
        unitPrice,
        units,
        unitLabel,
        priceKey,
      },
      expiresAt,
    },
  };
}

// ───────────────────────────── 确认扣费 ─────────────────────────────

interface QuoteRow {
  id: number;
  user_id: number;
  case_id: number;
  service: string;
  amount: number;
  entitlement_id: number | null;
  expires_at: string;
  confirmed_at: string | null;
  order_ref: string | null;
}

const SELECT_QUOTE =
  `SELECT id, user_id, case_id, service, amount, entitlement_id, expires_at, confirmed_at, order_ref
     FROM service_quotes WHERE id=?`;

/**
 * 只读一张报价（不动钱、不改状态）。给调用方在**确认之前**核对「这张报价买的是不是这件事」——
 * 核对放在 confirmService 之后就晚了：钱已经扣走，才发现这张报价买的是另一份材料。
 * 不是本人的报价回 null，与不存在同码（同 confirmService 的口径）。
 */
export function peekServiceQuote(
  db: Database.Database,
  userId: number,
  quoteId: number,
): { service: ServiceKind; caseId: number; amount: number; payload: ServiceQuotePayload } | null {
  const row = db
    .prepare('SELECT user_id, case_id, service, amount, payload_json FROM service_quotes WHERE id=?')
    .get(quoteId) as
    | { user_id: number; case_id: number; service: string; amount: number; payload_json: string }
    | undefined;
  if (!row || row.user_id !== userId) return null;
  let payload: ServiceQuotePayload = { units: 0 };
  try {
    payload = JSON.parse(row.payload_json) as ServiceQuotePayload;
  } catch {
    // 报价的载荷解不动不该让确认路径崩：金额以 amount 列为准，载荷只用于核对与对账
  }
  return { service: row.service as ServiceKind, caseId: row.case_id, amount: row.amount, payload };
}

export interface ServiceConfirmed {
  quoteId: number;
  service: ServiceKind;
  caseId: number;
  /** 报价上写的价（券抵扣时照记原价，不改成 0——「多少钱的服务被券抵了」是对账要的数）。 */
  amount: number;
  /** 本次真扣走的公道值。券抵扣或重放时为 0。 */
  charged: number;
  paidBy: 'gongdao' | 'entitlement';
  entitlementId: number | null;
  /** 扣费幂等键，退款按它原路退。 */
  orderRef: string;
  /** true = 这张报价此前已确认过，本次是重放，没有产生第二笔扣费。 */
  deduped: boolean;
}

function replay(row: QuoteRow): ServiceResult<ServiceConfirmed> {
  return {
    ok: true,
    quoteId: row.id,
    service: row.service as ServiceKind,
    caseId: row.case_id,
    amount: row.amount,
    charged: 0,
    paidBy: row.entitlement_id === null ? 'gongdao' : 'entitlement',
    entitlementId: row.entitlement_id,
    orderRef: row.order_ref ?? serviceChargeRef(row.id, row.user_id),
    deduped: true,
  };
}

/**
 * 确认下单：扣费（有会员券则核销券、不扣钱）。
 *
 * 【幂等靠两道，不是一道】
 *   ① `UPDATE ... WHERE id=? AND confirmed_at IS NULL` 抢占：抢输的那次 changes=0，
 *      当场判重放、charged=0、deduped=true——**不再往下走**。
 *   ② 真扣费那步走 gongdaoSettle 的 (type, ref_id) 唯一索引兜底。
 * 两道都要：只有 ①，进程在 ① 与扣费之间死掉会留下「标了已确认、其实没扣」的单；
 * 只有 ②，重放会返回 charged=报价额，调用方据此告诉用户「已扣 96」而账上根本没这一笔——
 * 钱没错，说出去的话错了。
 *
 * 【建单、核销券、扣费在同一个事务里】任一步不成整笔回滚。余额闸也在事务内、在真正扣费之前判：
 * 不够就把刚抢占的确认标记和刚核销的券一起回滚，不留「已确认未付」的行。
 */
export function confirmService(
  db: Database.Database,
  userId: number,
  quoteId: number,
): ServiceResult<ServiceConfirmed> {
  const row = db.prepare(SELECT_QUOTE).get(quoteId) as QuoteRow | undefined;
  // 不是本人的报价与不存在的报价同码：报价 id 是连号的，区分开就能拿它探测别人下过什么单。
  if (!row || row.user_id !== userId) {
    return fail(
      404,
      'QUOTE_NOT_FOUND',
      `报价 ${quoteId} 不存在或不属于本人。请重新报价后再确认——报价是免费的。`,
    );
  }
  if (row.confirmed_at) return replay(row);

  const now = nowSql();
  if (row.expires_at <= now) {
    return fail(
      409,
      'QUOTE_EXPIRED',
      `这张报价已于 ${row.expires_at}（UTC）过期，不能再据它扣费。` +
        '为什么：价目会被调整，过期的报价再确认就等于按一个已经不作数的价收钱。' +
        '怎么办：重新报一次价（报价免费、不扣任何费用），拿新的报价编号确认。',
    );
  }

  const orderRef = serviceChargeRef(row.id, userId);
  const feature = SERVICE_FEATURE[row.service as PricedService] ?? row.service;

  try {
    return db.transaction((): ServiceResult<ServiceConfirmed> => {
      // ① 抢占确认位。并发下只有一个请求的 changes=1，另一个当场判重放。
      const claimed = db
        .prepare(
          `UPDATE service_quotes SET confirmed_at=?, order_ref=?
            WHERE id=? AND confirmed_at IS NULL`,
        )
        .run(now, orderRef, row.id);
      if (claimed.changes === 0) {
        const fresh = db.prepare(SELECT_QUOTE).get(row.id) as QuoteRow;
        return replay(fresh);
      }

      // ② 会员券：有就核销、这单不扣钱。没券与「券刚被并发抢走」在这里是同一件事
      //    （consumeEntitlement 返回 null），照常走公道值扣费。**不静默免单**。
      const entitlementId = consumeEntitlement(
        db,
        userId,
        ENTITLEMENT_KIND.serviceExtract,
        orderRef,
      );
      if (entitlementId !== null) {
        db.prepare('UPDATE service_quotes SET entitlement_id=? WHERE id=?').run(entitlementId, row.id);
        // 券覆盖的单照落一条 delta=0 的标记行（gongdaoSettle 对 cost=0 仍写幂等标记、不动余额），
        // 于是「这单买过没有」对钱付与券付是同一个判据（有没有那笔流水）。
        gongdaoSettle(userId, 0, orderRef, feature, null, db);
        return {
          ok: true,
          quoteId: row.id,
          service: row.service as ServiceKind,
          caseId: row.case_id,
          amount: row.amount,
          charged: 0,
          paidBy: 'entitlement',
          entitlementId,
          orderRef,
          deduped: false,
        };
      }

      // ③ 余额闸在事务内、扣费之前：不够就整笔回滚（确认标记一并消失）。
      const gate = ensureGongdaoAmount(db, userId, row.amount);
      if (!gate.ok) {
        throw new TxAbort(fail(402, 'GONGDAO_EXHAUSTED', gongdaoExhaustedMessage(gate.balance)));
      }

      gongdaoSettle(userId, row.amount, orderRef, feature, null, db);
      return {
        ok: true,
        quoteId: row.id,
        service: row.service as ServiceKind,
        caseId: row.case_id,
        amount: row.amount,
        charged: row.amount,
        paidBy: 'gongdao',
        entitlementId: null,
        orderRef,
        deduped: false,
      };
    })();
  } catch (err) {
    if (err instanceof TxAbort) return err.failure;
    throw err;
  }
}
