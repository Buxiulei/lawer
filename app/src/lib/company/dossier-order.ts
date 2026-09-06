// app/src/lib/company/dossier-order.ts
// 公司档案「报价 → 确认」在**统一报价流**上的那一层壳（设计稿 §2 H、§4.2）。
//
// 【为什么是一层壳，而不是把 dossier-billing 迁进 service-quotes】拆包按模块选购的计价
// （六块各自的价基、依赖、可售门槛、券只覆盖核心四项、每块一笔独立流水好单独退）长在
// dossier-billing 里，且有一整套判据钉着。把它拆散重铺到「一个服务 × 一个单价 × 一个数量」
// 的形状上，等于在没有新需求的前提下重写一遍收钱的代码——本层只做两件既有代码没有的事：
//   ① 把报价**落成一行可回查的单**（service_quotes，service='dossier'），给出 quote_id 与有效期；
//   ② 确认按 quote_id 走，且**同一张报价重复确认只算一次**。
// 扣费仍旧原封不动地由 confirmDossier 完成（券、余额闸、每模块一笔流水、整笔回滚都在它里面）。
//
// 【幂等只有一处判据：事务内那句抢占】
//   `UPDATE service_quotes SET confirmed_at=? WHERE id=? AND confirmed_at IS NULL`
//   抢输的那次 changes=0，当场判重放：charged=0、deduped=true，**不再往下走**。
//   底下还有一道兜底（confirmDossier 每块扣费走 (type, ref_id) 唯一索引），但它兜的是钱、
//   不是话：只靠它的话，第二次确认会拿着一份「本次全已付」的结果回去，调用方分不清这是
//   「刚给你买好了」还是「上次就买过了」——钱没错，说出去的话错了（deduped 这个字就是为它存在的）。
//
//   【为什么读到 confirmed_at 也不提前返回】提前返回一句同样的重放，会让上面那句抢占在
//   单线程下永远走不到——判据于是钉不住它：把 `AND confirmed_at IS NULL` 删掉，测试照样绿。
//   一处判据、一条路径，删了就红。
//
// 【报价为什么必须落库】报价上写的价必须与确认时扣的价是同一个数。不落库、让调用方把
// 参数原样再发一遍的形态是：中间价目被调过，用户看到的价与实际扣的价分歧，而两边都不报错。
// 本层落的那行只记「这张单买的是什么」，钱数仍以确认时 dossier-billing 的重算为准（券与
// 已付模块随时可能变），故 amount 列存的是报价那一刻的应付额，仅供对账，不作扣费依据。
import type Database from 'better-sqlite3';

import * as cases from '../cases';
import { toSql, nowSql } from '../db/time';
import { readPrice } from '../billing/pricing-config';

import {
  DEEP_MODULES,
  confirmDossier,
  quoteDossier,
  type DossierModule,
  type DossierQuote,
} from './dossier-billing';
import { findDossierBySubject } from './dossier';
import { companyKey } from './normalize';
import { readProbeCache } from './probe';

/** service_quotes.service 里属于本层的那个值（值域见 lib/billing/service-quotes.ts）。 */
const SERVICE = 'dossier';

export interface DossierOrderFailure {
  ok: false;
  status: number;
  errorCode: string;
  message: string;
}
type Result<T> = ({ ok: true } & T) | DossierOrderFailure;

function fail(status: number, errorCode: string, message: string): DossierOrderFailure {
  return { ok: false, status, errorCode, message };
}

class TxAbort extends Error {
  constructor(readonly failure: DossierOrderFailure) {
    super(failure.message);
    this.name = 'TxAbort';
  }
}

/** 落在 service_quotes.payload_json 里的东西：确认时照它原样重算，调用方不必再传一遍参数。 */
interface DossierQuotePayload {
  name: string;
  uscc: string | null;
  modules: DossierModule[];
  /** 报价时用的可计费篇数，取自服务端探测缓存（**不由调用方传**，见 quoteDossierOrder） */
  docCount: number;
}

// ───────────────────────────── 报价 ─────────────────────────────

export interface DossierOrderQuoteView {
  quote_id: number;
  expires_at: string;
  case_id: number;
  company_key: string;
  name: string;
  uscc: string | null;
  dossier_id: number | null;
  blocks: {
    block: DossierModule;
    label: string;
    is_core: boolean;
    price_basis: string;
    gongdao: number;
    formula?: string;
    already_paid: boolean;
  }[];
  total: number;
  core_subtotal: number;
  membership_credit_available: boolean;
  payable_gongdao: number;
  balance: number;
  shortfall: number;
  billable_docs: number;
  /** 深度两块的取证时限（工作日） */
  litigation_sla_days: number;
  note: string;
}

const QUOTE_NOTE =
  '这一步只出价，没有扣任何费用、也没有建档。把 quote_id 交给 dossier_confirm 才会扣费；' +
  '过了 expires_at 要重新报价（价目会调整，过期报价再确认等于按一个不作数的价收钱）。';

function view(caseId: number, quoteId: number, expiresAt: string, q: DossierQuote): DossierOrderQuoteView {
  return {
    quote_id: quoteId,
    expires_at: expiresAt,
    case_id: caseId,
    company_key: q.companyKey,
    name: q.name,
    uscc: q.uscc,
    dossier_id: q.dossierId,
    blocks: q.items.map((it) => ({
      block: it.module,
      label: it.label,
      is_core: it.isCore,
      price_basis: it.priceBasis,
      gongdao: it.gongdao,
      formula: it.formula,
      already_paid: it.alreadyPaid,
    })),
    total: q.total,
    core_subtotal: q.coreSubtotal,
    membership_credit_available: q.membershipCreditAvailable,
    payable_gongdao: q.payableGongdao,
    balance: q.balance,
    shortfall: q.shortfall,
    billable_docs: q.billableDocs,
    litigation_sla_days: q.litigationSlaDays,
    note: QUOTE_NOTE,
  };
}

/**
 * 报价。**只读，绝不动钱**：本层唯一的写入是往 service_quotes 落一行报价单，
 * 不 settle、不建档、不占额度、不核销券（真正的计价仍由 quoteDossier 完成）。
 *
 * 【可计费篇数为什么不收入参】它直接决定深度两块的价。让调用方传的形态是：
 * 报一个小篇数就能把价压下来，服务端没有任何一处会觉得不对。所以这里只认服务端
 * 探测缓存里那个数（company_probe_cache，由 company_probe 写），缓存不新鲜就不卖深度块。
 */
export function quoteDossierOrder(
  db: Database.Database,
  input: {
    userId: number;
    caseId: number;
    name: string;
    uscc?: string | null;
    blocks: readonly DossierModule[];
  },
): Result<{ quote: DossierOrderQuoteView }> {
  // 归属校验走 lib/cases 的既有入口：「非本人案件一律当作不存在」是条红线，不在这里复制第二份。
  const owned = cases.getCase(db, { caseId: input.caseId, userId: input.userId, timelineLimit: 1 });
  if (!owned.ok) return fail(owned.status, owned.errorCode, owned.message);

  const uscc = input.uscc ?? null;
  let key: string;
  try {
    key = companyKey({ uscc, name: input.name });
  } catch (err) {
    return fail(400, 'COMPANY_NAME_EMPTY', err instanceof Error ? err.message : String(err));
  }

  const cached = readProbeCache(db, key);
  const wantsDeep = input.blocks.some((b) => DEEP_MODULES.includes(b));
  if (wantsDeep && !(cached.fresh && cached.payload)) {
    return fail(
      409,
      'DOSSIER_PROBE_REQUIRED',
      '缺什么：深度两块（涉诉深度统计 / 人事套路归纳）按篇数计价，而这个主体现在没有一份新鲜的免费探测结果。' +
        '为什么缺：篇数只认服务端探测缓存里那个数——如果由调用方报一个数过来，' +
        '报小了就能把价压下去，而服务端没有任何一处会发现。' +
        `怎么办：先调 company_probe 探一次这个主体（免费、缓存命中还不占次数），拿到 doc_url_count 之后再来报价；` +
        '只买核心四块不需要探测，可以现在就报。',
    );
  }
  const docCount = cached.fresh && cached.payload ? cached.payload.doc_url_count : 0;

  const quoted = quoteDossier(db, input.userId, {
    name: input.name,
    uscc,
    modules: input.blocks,
    docCount,
  });
  if (!quoted.ok) return fail(quoted.status, quoted.errorCode, quoted.message);

  const payload: DossierQuotePayload = {
    name: input.name,
    uscc,
    modules: quoted.quote.items.map((it) => it.module),
    docCount,
  };
  const expiresAt = toSql(new Date(Date.now() + readPrice(db, 'quote.ttl_minutes') * 60_000));
  const quoteId = Number(
    db
      .prepare(
        `INSERT INTO service_quotes (user_id, case_id, service, payload_json, amount, expires_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(input.userId, input.caseId, SERVICE, JSON.stringify(payload), quoted.quote.payableGongdao, expiresAt)
      .lastInsertRowid,
  );

  return { ok: true, quote: view(input.caseId, quoteId, expiresAt, quoted.quote) };
}

// ───────────────────────────── 确认扣费 ─────────────────────────────

interface QuoteRow {
  id: number;
  user_id: number;
  case_id: number;
  service: string;
  payload_json: string;
  amount: number;
  expires_at: string;
  confirmed_at: string | null;
  order_ref: string | null;
}

const SELECT_QUOTE = `SELECT id, user_id, case_id, service, payload_json, amount, expires_at, confirmed_at, order_ref
     FROM service_quotes WHERE id=?`;

export interface DossierOrderConfirmedView {
  quote_id: number;
  case_id: number;
  dossier_id: number | null;
  /** 'gongdao'=扣了公道值；'membership_credit'=核销了会员券；'none'=这些块此前都已付过 */
  paid_by: string;
  /** 本次真扣走的公道值。券抵扣或重放时为 0 */
  charged: number;
  entitlement_id: number | null;
  /** true = 这张报价此前已确认过，本次**没有产生第二笔扣费** */
  deduped: boolean;
  note: string;
}

const CONFIRM_NOTE = '已下单。采集与整理按块各自排队，进度用 dossier_get 读。';
const REPLAY_NOTE =
  '这张报价此前已经确认过了，本次没有产生第二笔扣费。请如实告诉用户「之前那单已经付过」，' +
  '不要说成又买了一次；要买别的块请重新报价。';

function replay(db: Database.Database, row: QuoteRow): Result<DossierOrderConfirmedView> {
  const payload = parsePayload(row);
  const existing = payload ? findDossierBySubject(db, { uscc: payload.uscc, name: payload.name }) : undefined;
  return {
    ok: true,
    quote_id: row.id,
    case_id: row.case_id,
    dossier_id: existing?.id ?? null,
    paid_by: 'none',
    charged: 0,
    entitlement_id: null,
    deduped: true,
    note: REPLAY_NOTE,
  };
}

function parsePayload(row: QuoteRow): DossierQuotePayload | null {
  try {
    return JSON.parse(row.payload_json) as DossierQuotePayload;
  } catch {
    return null;
  }
}

/**
 * 按 quote_id 确认下单。扣费本身仍由 confirmDossier 做（券、余额闸、每块一笔流水、
 * 失败整笔回滚都在它里面），本层只管三件事：这张单是不是你的、过没过期、有没有确认过。
 *
 * 【抢占与扣费在同一个事务里】confirmDossier 失败（余额不够、依赖不满足）时把刚抢占的
 * 确认标记一起回滚——否则会留下一张标了「已确认」却根本没扣成的单，它长得和付过钱的一模一样。
 */
export function confirmDossierOrder(
  db: Database.Database,
  userId: number,
  quoteId: number,
): Result<DossierOrderConfirmedView> {
  const row = db.prepare(SELECT_QUOTE).get(quoteId) as QuoteRow | undefined;
  // 不是本人的报价与不存在的报价同码：报价 id 是连号的，区分开就能拿它探测别人下过什么单。
  if (!row || row.user_id !== userId) {
    return fail(
      404,
      'QUOTE_NOT_FOUND',
      `报价 ${quoteId} 不存在或不属于本人。请重新报一次价再确认——报价是免费的。`,
    );
  }
  if (row.service !== SERVICE) {
    return fail(
      409,
      'QUOTE_SERVICE_MISMATCH',
      `报价 ${quoteId} 买的不是公司档案（它是「${row.service}」那条服务的单），不能用这个工具确认。` +
        '拿错单号就确认，扣的会是另一件东西的钱。请用 dossier_quote 重新报价后再确认。',
    );
  }
  const now = nowSql();
  // 过期只拦**还没确认过**的单：一张早就付过的单过了期，用户再问一次时该听到的是
  // 「这单已经付过了」，不是「过期了，重报一张」——后者会让他为同一件事再买一次。
  if (!row.confirmed_at && row.expires_at <= now) {
    return fail(
      409,
      'QUOTE_EXPIRED',
      `这张报价已于 ${row.expires_at}（UTC）过期，不能再据它扣费。` +
        '为什么：价目会被调整，过期的报价再确认就等于按一个已经不作数的价收钱。' +
        '怎么办：重新报一次价（报价免费、不扣任何费用），拿新的报价编号确认。',
    );
  }

  const payload = parsePayload(row);
  if (!payload) {
    return fail(
      500,
      'QUOTE_PAYLOAD_BROKEN',
      `报价 ${quoteId} 的内容读不出来了，不知道这单买的是哪几块，所以不能凭它扣费。` +
        '本次没有扣任何费用。请重新报一次价再确认。',
    );
  }

  try {
    return db.transaction((): Result<DossierOrderConfirmedView> => {
      // ① 抢占确认位。并发下只有一个请求的 changes=1，另一个当场判重放、不扣第二笔。
      const claimed = db
        .prepare('UPDATE service_quotes SET confirmed_at=? WHERE id=? AND confirmed_at IS NULL')
        .run(now, row.id);
      if (claimed.changes === 0) {
        return replay(db, db.prepare(SELECT_QUOTE).get(row.id) as QuoteRow);
      }

      const done = confirmDossier(db, userId, {
        name: payload.name,
        uscc: payload.uscc,
        modules: payload.modules,
        docCount: payload.docCount,
      });
      // 扣费不成整笔回滚：抢占的确认标记跟着消失，用户可以拿同一张报价再试一次。
      if (!done.ok) throw new TxAbort(fail(done.status, done.errorCode, done.message));

      const orderRef = `dossier-${done.dossierId}-u${userId}`;
      db.prepare('UPDATE service_quotes SET order_ref=?, entitlement_id=? WHERE id=?').run(
        orderRef,
        done.entitlementId,
        row.id,
      );

      return {
        ok: true,
        quote_id: row.id,
        case_id: row.case_id,
        dossier_id: done.dossierId,
        paid_by: done.paidBy,
        charged: done.charged,
        entitlement_id: done.entitlementId,
        deduped: false,
        note: CONFIRM_NOTE,
      };
    })();
  } catch (err) {
    if (err instanceof TxAbort) return err.failure;
    throw err;
  }
}
