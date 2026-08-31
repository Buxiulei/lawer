'use client';

import Link from 'next/link';
import { useState } from 'react';
import { mockProbe, mockQuote } from '@/app/_mock/company-dossier';
import { ApiError, apiFetch, humanError } from '@/app/_ui/api';
import { readToken } from '@/app/_ui/auth';
import { formatDate } from '@/app/_ui/format';
import { NeutralLabel } from '@/app/_ui/NeutralLabel';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import type { DossierModule, DossierQuote, DossierQuoteItem } from '@/lib/company/dossier-billing';
import type { ProbeResult } from '@/lib/company/probe';
import {
  MODULE_CATALOG,
  type Availability,
  type ModuleCard as ModuleCardMeta,
  type SelectionSummary,
  billableSelection,
  defaultSelection,
  dependencyUnmet,
  isQuoteStale,
  moduleAvailability,
  moduleDisclosure,
  preChargeDisclosures,
  subjectKey,
  summarizeSelection,
} from '@/lib/dossier/order';
import { Sensitive } from '@/components/Sensitive';
import { Alert, AlertTitle } from '@/components/shadcn/alert';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Checkbox } from '@/components/shadcn/checkbox';
import { Input } from '@/components/shadcn/input';

/**
 * 建档报价（方案 v3 §6）：输公司名 → 免费探测 → 六个模块各自勾选 → 合计与余额对照 → 确认扣费。
 *
 * 【这一页零扣费】页面上唯一动钱的调用是用户点了「确认并扣费」之后的 confirm。
 * 报价端点自己也不动钱（服务端有对照测试逐字断言余额与流水行数不变），两边一起守。
 *
 * 【先免费探测，再谈钱】四个计数（关联主体 / 涉诉 / 其中劳动争议 / 有公开文书链接）
 * 是扣费前可验证的事实，也是每个模块卖不卖的判据。探测降级（配额用完 / 采集器不在场）
 * 时**逐字渲染服务端那句话**，不改写、不缩写——那句话专门写来区分「这一刻没去查」
 * 和「查无此公司」，改写它就把这个区分弄没了。
 *
 * 【不可售的块置灰，并说出为什么】置灰不给原因等于没说：用户分不清是这家真没有、
 * 还是我们没查到、还是系统坏了。原因句里带着探测到的那个数（0 个关联、0 条涉诉、
 * N 篇文书链接低于门槛 M），他才判断得了要不要换个写法再查一次。
 * 不可售的块**不显示任何价**——一个买不到的东西标着价，是在卖一个我们不打算给的承诺。
 *
 * 【价一律来自服务端】页面里没有一处写死的价、门槛或工作日数。改价是往 pricing_config
 * 写一行、不发版；页面写死就会出现「显示 340、实际扣 200」。
 */
export function OrderQuote({ caseId }: { caseId: string }) {
  const isDemo = caseId === 'demo';

  const [companyName, setCompanyName] = useState(isDemo ? '星曜网络科技（北京）有限公司' : '');
  const [uscc, setUscc] = useState('');
  const [probe, setProbe] = useState<ProbeResult | null>(isDemo ? mockProbe : null);
  const [quote, setQuote] = useState<DossierQuote | null>(isDemo ? mockQuote : null);
  /** 深度两块被服务端判为不可售时，**服务端那句话**的原文（门槛与篇数的判据在它那边）。 */
  const [deepBlocked, setDeepBlocked] = useState<string | null>(null);
  const [selected, setSelected] = useState<DossierModule[]>(
    isDemo ? defaultSelection(mockQuote, mockProbe.payload ?? null, null) : [],
  );
  /** 这份报价是替哪一家报的。输入框改了而没重新查时，用它认出"屏幕上的价不是这一家的"。 */
  const [quotedFor, setQuotedFor] = useState<string>(isDemo ? subjectKey('星曜网络科技（北京）有限公司', '') : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmResponse | null>(null);

  const payload = probe?.payload ?? null;
  const probedDocs = payload?.doc_url_count ?? 0;
  /** 不可售的块**永远不进合计、不进下单**，与它怎么进的 selected 无关（见 billableSelection）。 */
  const billable = billableSelection(selected, payload, deepBlocked);
  const summary = quote ? summarizeSelection(quote, billable) : null;
  /**
   * 输入框被改过、还没重新查。此时屏幕上那份价是**上一家**的：
   * 直接下单会拿着 A 家的报价买 B 家的档案，服务端按 B 家重新算钱，
   * 用户看到的数与实扣的数不是一个数，两边各自看着都对。
   */
  const stale = isQuoteStale(quote, quotedFor, companyName, uscc);

  const orderBody = () => ({
    name: companyName.trim(),
    uscc: uscc.trim() || null,
    doc_count: probedDocs,
  });

  /** 免费探测 → 拿到篇数后立刻报价。两步都不扣费。 */
  const lookUp = async () => {
    setBusy(true);
    setError(null);
    setConfirmed(null);
    try {
      if (isDemo) {
        setProbe(mockProbe);
        setQuote(mockQuote);
        setDeepBlocked(null);
        setSelected(defaultSelection(mockQuote, mockProbe.payload ?? null, null));
        setQuotedFor(subjectKey(companyName, uscc));
        return;
      }
      if (!readToken()) {
        setError('登录后才能查。');
        return;
      }
      const res = await apiFetch<{ probe: ProbeResult }>('/company/probe', {
        method: 'POST',
        body: { name: companyName.trim(), uscc: uscc.trim() || null },
      });
      setProbe(res.probe);
      // 把**刚拿到的**探测结果传下去，不从 state 里读：setProbe 排的是下一轮渲染，
      // 这一轮读到的还是上一家（甚至是 null）的载荷，默认勾选就会照着上一家的可售性来算。
      await loadQuote(res.probe);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 报价。先按六块全要报一次；服务端若判深度两块够不着可售门槛（409），
   * 退回只报核心四块，并把**服务端那句话**留着当置灰原因——
   * 门槛是多少、这家有几篇，判据在服务端；前端复述一遍只会多出一处会漂的口径。
   */
  const loadQuote = async (fresh: ProbeResult) => {
    const docs = fresh.payload?.doc_url_count ?? 0;
    const all = MODULE_CATALOG.map((c) => c.module);
    const core = MODULE_CATALOG.filter((c) => c.isCore).map((c) => c.module);
    const ask = (modules: readonly DossierModule[]) =>
      apiFetch<{ quote: DossierQuote }>('/company/dossiers/quote', {
        method: 'POST',
        body: { ...orderBody(), doc_count: docs, modules },
      });

    const settle = (q: DossierQuote, blocked: string | null) => {
      setQuote(q);
      setDeepBlocked(blocked);
      setSelected(defaultSelection(q, fresh.payload ?? null, blocked));
      setQuotedFor(subjectKey(companyName, uscc));
    };

    try {
      settle((await ask(all)).quote, null);
    } catch (err) {
      if (!(err instanceof ApiError) || err.errorCode !== 'DOSSIER_DOCS_BELOW_SELL_FLOOR') throw err;
      settle((await ask(core)).quote, err.message);
    }
  };

  const confirm = async () => {
    if (!summary) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<ConfirmResponse>('/company/dossiers/confirm', {
        method: 'POST',
        body: { ...orderBody(), modules: summary.modules },
      });
      setConfirmed(res);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  if (confirmed) return <ConfirmedPanel caseId={caseId} result={confirmed} />;

  return (
    <div className="flex flex-col gap-5 pt-1">
      <header className="pt-3">
        <h1 className="text-[20px] font-semibold text-ink">
          <NeutralLabel plain="建档报价" neutral={NEUTRAL_WORD.dossier} />
        </h1>
        <p data-veil="" className="prose-measure mt-0.5 text-[15px] leading-7 text-ink-2">
          先免费查一下这家有没有货，再决定买哪几块。查这一步不花钱，看报价也不扣任何公道值。
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[14px] leading-6 text-ink-2">公司全名</span>
          <Input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="照劳动合同上写的那个名字填"
            autoComplete="off"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[14px] leading-6 text-ink-2">统一社会信用代码（可不填）</span>
          <Input
            value={uscc}
            onChange={(e) => setUscc(e.target.value)}
            placeholder="填了就按代码认，公司改名也不换档案"
            autoComplete="off"
          />
        </label>
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          disabled={busy || companyName.trim() === ''}
          onClick={() => void lookUp()}
        >
          {probe ? '重新查一次' : '免费查一下'}
        </Button>
      </section>

      {error && (
        <Alert>
          <AlertTitle data-veil="">{error}</AlertTitle>
        </Alert>
      )}

      {probe && <ProbeCard probe={probe} />}

      {quote && summary && (
        <>
          <section className="flex flex-col gap-2.5">
            <h2 className="text-[16px] leading-7 font-semibold text-ink">要买哪几块</h2>
            {MODULE_CATALOG.map((card) => {
              const item = quote.items.find((it) => it.module === card.module) ?? null;
              const availability = moduleAvailability(card.module, payload, deepBlocked);
              const blocked = dependencyUnmet(card.module, selected, quote.items);
              return (
                <ModuleCard
                  key={card.module}
                  card={card}
                  item={item}
                  quote={quote}
                  availability={availability}
                  dependencyNote={blocked}
                  checked={selected.includes(card.module)}
                  onToggle={(on) =>
                    setSelected((prev) =>
                      on ? [...prev, card.module] : prev.filter((m) => m !== card.module),
                    )
                  }
                />
              );
            })}
          </section>

          <DisclosureList lines={preChargeDisclosures(quote, probedDocs)} />

          <OrderSummary summary={summary} quote={quote} />

          {stale && (
            <p
              data-testid="stale-quote-note"
              data-veil=""
              className="prose-measure text-[14px] leading-7 text-amber-ink"
            >
              公司名或代码改过了，上面这份价还是改之前那一家的。点「重新查一次」再报一次，
              免得拿着这一家的价买了另一家的档案。
            </p>
          )}

          <ConfirmButton
            busy={busy}
            stale={stale}
            summary={summary}
            onConfirm={() => void confirm()}
          />
        </>
      )}
    </div>
  );
}

/* ── 探测卡 ───────────────────────────────────────────── */

/**
 * 免费探测卡：四个数字 + 一行工商状态 + 采集时点。
 *
 * 降级态（配额用完 / 采集器不在场）**一个数字都不出**，只把服务端那句 reason 原样摆出来。
 * 给降级态编几个 0 出来，界面上和「这家真的一条都没有」长得一模一样——
 * 那正是这条端点花力气区分的两件事。
 */
export function ProbeCard({ probe }: { probe: ProbeResult }) {
  const p = probe.payload;

  if (!p) {
    return (
      <section
        data-testid="probe-card"
        className="rounded-[12px] border border-amber-ink/25 bg-amber-wash px-4 py-3.5"
      >
        <p className="text-[15px] leading-7 font-semibold text-amber-ink">这次没查出数字</p>
        <p data-veil="" className="prose-measure mt-1 text-[14px] leading-7 text-ink">
          {probe.reason}
        </p>
        <p data-veil="" className="mt-1.5 text-[13px] leading-6 text-ink-2">
          今日还剩 <span className="num">{probe.quota_left}</span> 次免费查。
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid="probe-card"
      className="rounded-[12px] border border-border bg-card px-4 py-3.5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[15px] leading-7 font-semibold text-ink">查到的（免费，不扣费）</h2>
        <Badge tone={probe.status === 'hit' ? 'neutral' : 'success'}>
          {probe.status === 'hit' ? '读的是存档' : '刚查的'}
        </Badge>
      </div>

      <div data-veil="" className="mt-2">
        {p.entity_name && (
          <p className="text-[14px] leading-7 text-ink">
            主体：
            <Sensitive>{p.entity_name}</Sensitive>
          </p>
        )}
        {p.gs_status && (
          <p className="text-[14px] leading-7 text-ink">工商状态：{p.gs_status}</p>
        )}

        <dl className="mt-1.5 flex flex-col gap-1 text-[14px] leading-7">
          <Count label="关联主体" n={p.relation_count} />
          <Count label="涉诉记录" n={p.litigation_count} />
          <Count label="其中劳动争议" n={p.labor_count} />
          <Count label="其中有公开文书链接" n={p.doc_url_count} unit="篇" />
        </dl>

        {/* as_of 是硬门槛：没有采集时点的四个数就是四个悬浮的数 */}
        <p className="mt-2 text-[12.5px] leading-6 text-ink-2">
          数据截至 <span className="num">{formatDate(p.as_of)}</span> · 今日还剩{' '}
          <span className="num">{probe.quota_left}</span> 次免费查
        </p>
      </div>
    </section>
  );
}

function Count({ label, n, unit = '条' }: { label: string; n: number; unit?: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-ink-2">{label}</dt>
      <dd className="min-w-0 text-ink">
        <span className="num">{n}</span> {unit}
      </dd>
    </div>
  );
}

/* ── 模块卡 ───────────────────────────────────────────── */

/**
 * 一个模块一张卡。可售时摊开四样：计价口径、展开算式、时延承诺、退款承诺；
 * 不可售时置灰、给原因句、**不给价**。
 */
export function ModuleCard({
  card,
  item,
  quote,
  availability,
  dependencyNote,
  checked,
  onToggle,
}: {
  card: ModuleCardMeta;
  item: DossierQuoteItem | null;
  quote: DossierQuote;
  availability: Availability;
  dependencyNote: string | null;
  checked: boolean;
  onToggle: (on: boolean) => void;
}) {
  if (!availability.sellable || !item) {
    const reason = availability.sellable
      ? // 走不到的组合：可售却没有报价行。真出现了要说得出是什么、为什么、怎么办。
        '这一块这次没有报出价来（报价响应里没有它这一行）。点上面「重新查一次」再报一次；' +
        '反复出现请把这句话连同公司全名报给我们。'
      : availability.reason;
    return (
      <section
        data-testid={`module-card-${card.module}`}
        data-sellable="false"
        className="rounded-[12px] border border-dashed border-border bg-surface-2 px-4 py-3.5 opacity-70"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-[15px] leading-7 font-semibold text-ink-2">{card.label}</span>
          <Badge tone="neutral">暂不可售</Badge>
        </div>
        <p data-veil="" className="prose-measure mt-1 text-[14px] leading-7 text-ink-2">
          {reason}
        </p>
      </section>
    );
  }

  const d = moduleDisclosure(item, quote);
  const locked = item.alreadyPaid || dependencyNote !== null;

  return (
    <label
      data-testid={`module-card-${card.module}`}
      data-sellable="true"
      className="flex cursor-pointer items-start gap-3 rounded-[12px] border border-border bg-card px-4 py-3.5"
    >
      <Checkbox
        className="mt-1"
        checked={checked}
        disabled={locked}
        onCheckedChange={(v) => onToggle(v === true)}
      />
      <div data-veil="" className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-[15px] leading-7 font-semibold text-ink">{card.label}</span>
          <span className="num text-[15px] leading-7 font-semibold text-ink">
            {item.gongdao} 公道值
          </span>
        </div>
        <p className="prose-measure mt-0.5 text-[14px] leading-7 text-ink-2">{card.delivers}</p>

        <p className="prose-measure mt-1 text-[13px] leading-6 text-ink-2">
          计价：{d.basisText}
          {d.formula && (
            <>
              {' '}
              · <span className="num">{d.formula}</span>
            </>
          )}
        </p>

        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {item.isCore ? <Badge tone="primary">核心</Badge> : <Badge tone="amber">深度</Badge>}
          {/* 时延承诺照实说：文书那两块的快慢不由我们控制 */}
          {d.slaWorkdays === null ? (
            <Badge tone="success">几分钟内出</Badge>
          ) : (
            <Badge tone="amber">
              最长 <span className="num">{d.slaWorkdays}</span> 个工作日
            </Badge>
          )}
          {item.alreadyPaid && <Badge tone="neutral">已购买</Badge>}
        </div>

        {d.slaWorkdays !== null && (
          <p className="prose-measure mt-1 text-[13px] leading-6 text-ink-2">
            这一块要真人登录裁判文书网取证，快慢不由服务器决定。
          </p>
        )}
        {d.refundPromise && (
          <p className="prose-measure mt-1 text-[13px] leading-6 text-ink-2">{d.refundPromise}</p>
        )}
        {item.alreadyPaid && (
          <p className="prose-measure mt-1 text-[13px] leading-6 text-ink-2">
            这一块你已经买过，不会重复扣费；再确认一次也不会重新采集。
          </p>
        )}
        {dependencyNote && (
          <p className="prose-measure mt-1 text-[13px] leading-6 text-amber-ink">{dependencyNote}</p>
        )}
      </div>
    </label>
  );
}

/* ── 扣费前的四句 ─────────────────────────────────────── */

/** 契约 §二 绑死的诚实红线，扣费前必须在屏幕上。不折叠、不小字化。 */
export function DisclosureList({ lines }: { lines: string[] }) {
  return (
    <section
      data-testid="pre-charge-disclosures"
      data-veil=""
      className="rounded-[10px] border border-amber-ink/25 bg-amber-wash px-3.5 py-3"
    >
      <p className="text-[13px] leading-6 font-medium text-amber-ink">扣费前请先看这几条</p>
      <ul className="mt-1 flex list-disc flex-col gap-1 pl-4">
        {lines.map((line) => (
          <li key={line} className="prose-measure text-[14px] leading-7 text-ink">
            {line}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── 合计与余额 ───────────────────────────────────────── */

/**
 * 合计：核心四块小计与深度小计分开摆，再对余额。
 *
 * 【赠送额守护】扣完之后余额撑不起一次首诊时出黄条，但**不阻断下单**——
 * 用户有权把钱花在他认为更要紧的地方，我们的责任是让他先知道这个顺序问题。
 * 真正阻断下单的只有余额不够（shortfall > 0）这一件事。
 */
export function OrderSummary({
  summary,
  quote,
}: {
  summary: SelectionSummary;
  quote: DossierQuote;
}) {
  return (
    <section
      data-testid="order-summary"
      data-veil=""
      className="rounded-[12px] border border-border bg-card px-4 py-3.5"
    >
      <Row label="核心四块小计" value={summary.coreSubtotal} />
      <Row label="深度两块小计" value={summary.deepSubtotal} />
      <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-border pt-2">
        <span className="text-[15px] leading-7 text-ink-2">本次实扣</span>
        <span className="num text-[22px] leading-8 font-semibold text-ink">
          {summary.payableGongdao} 公道值
        </span>
      </div>

      <p className="mt-1 text-[13px] leading-6 text-ink-2">
        按块相加，不打包折扣。当前余额 <span className="num">{summary.balance}</span> 公道值。
      </p>

      {quote.membershipCreditAvailable && (
        <p className="mt-1.5 text-[13px] leading-6 text-ink-2">
          你有一张会员赠送券，覆盖核心四块（本次抵掉{' '}
          <span className="num">{summary.coreSubtotal}</span> 公道值）；深度两块照常扣。
        </p>
      )}

      {summary.shortfall > 0 && (
        <p data-testid="shortfall-note" className="mt-1.5 text-[13px] leading-6 text-amber-ink">
          余额还差 <span className="num">{summary.shortfall}</span> 公道值。
          先去充值，或者少勾几块——核心四块可以分开买，深度两块也不是必须一起要。
        </p>
      )}

      {summary.intakeAtRisk && (
        <p data-testid="intake-reserve-note" className="mt-1.5 text-[13px] leading-6 text-amber-ink">
          扣完之后余额只剩 <span className="num">{summary.balanceAfter}</span> 公道值，
          而发起一次首诊需要 <span className="num">{summary.intakeReserve}</span>。
          这一单照样下得了，只是先说一声顺序：先把案子说清楚，通常比先买齐档案更要紧。
        </p>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[14px] leading-7 text-ink-2">{label}</span>
      <span className="num text-[15px] leading-7 text-ink">{value} 公道值</span>
    </div>
  );
}

/* ── 确认之后 ─────────────────────────────────────────── */

interface ConfirmResponse {
  dossier_id: number;
  paid_by: 'gongdao' | 'membership_credit' | 'none';
  charged: number;
  entitlement_id: number | null;
}

/**
 * 下单结果。
 *
 * 【paid_by='none' 不显示成"已下单，正在采集"】它的意思是这几块此前都付过、本次一分没扣
 * （契约 §三 的已知边界：TTL 到期后"再买一次刷新"当前撞同一个幂等键，会被判为重放）。
 * 把它显示成"已开始采集"，用户会等一个永远不会来的刷新。
 */
export function ConfirmedPanel({ caseId, result }: { caseId: string; result: ConfirmResponse }) {
  return (
    <div className="pt-4">
      <Alert>
        <AlertTitle data-veil="">
          {result.paid_by === 'none'
            ? '这几块你之前已经买过，本次没有扣任何费用，也没有重新采集。'
            : '已下单，开始建档。'}
        </AlertTitle>
        {result.paid_by !== 'none' && (
          <p data-veil="" className="prose-measure mt-1 text-[14px] leading-7 text-ink-2">
            本次实扣 <span className="num">{result.charged}</span> 公道值
            {result.paid_by === 'membership_credit' && '（核心四块走了会员赠送券，没动余额）'}。
          </p>
        )}
        <Button size="sm" className="mt-3" asChild>
          <Link href={`/case/${caseId}/dossier`}>看进展</Link>
        </Button>
      </Alert>
    </div>
  );
}

/* ── 确认按钮 ─────────────────────────────────────────── */

/**
 * 「确认并扣费」。**单独导出**是为了让判据够得着那个 `stale`：
 * 四个失效条件里只有它是"屏幕上的东西没错、只是过期了"，删掉之后页面看不出任何异样
 * （那条黄色提示还在，按钮只是变成可点），整套组件测试照样全绿。
 * 判据在 __tests__/order-honesty 里直接断言这颗按钮的 disabled 属性。
 */
export function ConfirmButton({
  busy,
  stale,
  summary,
  onConfirm,
}: {
  busy: boolean;
  stale: boolean;
  summary: SelectionSummary;
  onConfirm: () => void;
}) {
  return (
    <Button
      data-testid="confirm-charge"
      className="w-full"
      disabled={busy || stale || summary.modules.length === 0 || summary.shortfall > 0}
      onClick={onConfirm}
    >
      确认并扣费
    </Button>
  );
}
