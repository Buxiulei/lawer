'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { mockQuote } from '@/app/_mock/company-dossier';
import { apiFetch, humanError } from '@/app/_ui/api';
import { readToken } from '@/app/_ui/auth';
import { NeutralLabel } from '@/app/_ui/NeutralLabel';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import type { DossierQuote, QuoteLine } from '@/lib/dossier/contract';
import { TENURE_DISCLAIMER } from '@/lib/dossier/present';
import { Alert, AlertTitle } from '@/components/shadcn/alert';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Checkbox } from '@/components/shadcn/checkbox';
import { Input } from '@/components/shadcn/input';

/**
 * 建档报价与确认。
 *
 * 【报价这一步不扣任何公道值】页面上没有一处调用扣费；扣费只发生在用户点了
 * 「确认并扣费」之后的 confirm 请求里。这条在 B 的 B1 判据里也钉着一遍
 *（quote 两次余额与 ledger 行数完全不变），两边一起守。
 *
 * 【拆价必须看得见，且可以只买一块】不打包折扣是有意的：打折会诱导用户
 * 连带买下那个他**可能拿不到**的文书块（样本不足是常态，不是意外）。
 *
 * 【时延与退款承诺在扣费前就要摆出来】文书那一块的交付快慢不由服务器决定——
 * 它要真人登录取证。把这句话放到付款之后再说，就是卖了个我们控制不了的承诺。
 */
export function OrderQuote({ caseId }: { caseId: string }) {
  const isDemo = caseId === 'demo';

  const [companyName, setCompanyName] = useState(isDemo ? '星曜网络科技（北京）有限公司' : '');
  const [tenure, setTenure] = useState(isDemo ? '5' : '');
  const [quote, setQuote] = useState<DossierQuote | null>(isDemo ? mockQuote : null);
  const [picked, setPicked] = useState<Set<string>>(
    new Set(isDemo ? mockQuote.lines.map((l) => l.feature) : []),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const selected = useMemo(
    () => (quote?.lines ?? []).filter((l) => picked.has(l.feature)),
    [quote, picked],
  );
  // 合计只是把服务端给的行加起来——前端不参与定价，也就没有前后端算出两个数的可能
  const total = selected.reduce((sum, l) => sum + l.gongdao, 0);
  const shortfall = quote ? total - quote.balanceGongdao : 0;

  const askQuote = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isDemo) {
        setQuote(mockQuote);
        setPicked(new Set(mockQuote.lines.map((l) => l.feature)));
        return;
      }
      if (!readToken()) {
        setError('登录后才能报价。');
        return;
      }
      const res = await apiFetch<DossierQuote>('/company/dossiers/quote', {
        method: 'POST',
        body: {
          case_id: caseId,
          company_name: companyName.trim(),
          tenure_years: tenure.trim() === '' ? null : Number(tenure),
        },
      });
      setQuote(res);
      setPicked(new Set(res.lines.map((l) => l.feature)));
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/company/dossiers/confirm', {
        method: 'POST',
        body: {
          case_id: caseId,
          company_name: companyName.trim(),
          tenure_years: tenure.trim() === '' ? null : Number(tenure),
          features: selected.map((l) => l.feature),
        },
      });
      setDone(true);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="pt-4">
        <Alert>
          <AlertTitle data-veil="">已开始建档。</AlertTitle>
          <Button size="sm" className="mt-3" asChild>
            <Link href={`/case/${caseId}/dossier`}>看进展</Link>
          </Button>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pt-1">
      <header className="pt-3">
        <h1 className="text-[20px] font-semibold text-ink">
          <NeutralLabel plain="建档报价" neutral={NEUTRAL_WORD.dossier} />
        </h1>
        <p data-veil="" className="prose-measure mt-0.5 text-[15px] leading-7 text-ink-2">
          先看清楚每一块给什么、什么时候给、拿不到怎么办。看报价不扣任何公道值。
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
          <span className="text-[14px] leading-6 text-ink-2">在职年限（年）</span>
          <Input
            value={tenure}
            onChange={(e) => setTenure(e.target.value)}
            inputMode="decimal"
            placeholder="例如 5"
            autoComplete="off"
          />
          {/* 不写这一句，用户会以为自己填的年限影响了后面那些公司数据 */}
          <span data-veil="" className="prose-measure text-[13px] leading-6 text-ink-2">
            {TENURE_DISCLAIMER}
          </span>
        </label>
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          disabled={busy || companyName.trim() === ''}
          onClick={() => void askQuote()}
        >
          {quote ? '重新报价' : '看报价'}
        </Button>
      </section>

      {error && (
        <Alert>
          <AlertTitle data-veil="">{error}</AlertTitle>
        </Alert>
      )}

      {quote && (
        <>
          {quote.cache.hit && (
            <p
              data-veil=""
              className="prose-measure rounded-[10px] bg-surface-2 px-3.5 py-3 text-[14px] leading-7 text-ink"
            >
              本公司已有 <span className="num">{quote.cache.ageDays}</span> 天前的存档，
              本次按增量刷新价算
              {quote.cache.cachedGongdao !== null && (
                <>
                  （<span className="num">{quote.cache.cachedGongdao}</span> 公道值）
                </>
              )}
              。
            </p>
          )}

          <section className="flex flex-col gap-2.5">
            {quote.lines.map((line) => (
              <QuoteLineCard
                key={line.feature}
                line={line}
                checked={picked.has(line.feature)}
                onToggle={(on) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(line.feature);
                    else next.delete(line.feature);
                    return next;
                  })
                }
              />
            ))}
          </section>

          <section
            data-veil=""
            className="rounded-[12px] border border-border bg-card px-4 py-3.5"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[15px] leading-7 text-ink-2">合计</span>
              <span className="num text-[22px] leading-8 font-semibold text-ink">
                {total} 公道值
              </span>
            </div>
            <p className="mt-1 text-[13px] leading-6 text-ink-2">
              按块相加，不打包折扣。当前余额{' '}
              <span className="num">{quote.balanceGongdao}</span> 公道值。
            </p>
            {quote.entitlementAvailable && (
              <p className="mt-1.5 text-[13px] leading-6 text-ink-2">
                你有一次会员赠送的建档次数，这一单不扣公道值。
              </p>
            )}
            {!quote.entitlementAvailable && shortfall > 0 && (
              <p className="mt-1.5 text-[13px] leading-6 text-amber-ink">
                余额还差 <span className="num">{shortfall}</span> 公道值，先去充值再确认。
              </p>
            )}
          </section>

          <Button
            className="w-full"
            disabled={
              busy ||
              selected.length === 0 ||
              companyName.trim() === '' ||
              (!quote.entitlementAvailable && shortfall > 0)
            }
            onClick={() => void confirm()}
          >
            确认并扣费
          </Button>
        </>
      )}
    </div>
  );
}

function QuoteLineCard({
  line,
  checked,
  onToggle,
}: {
  line: QuoteLine;
  checked: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-[12px] border border-border bg-card px-4 py-3.5">
      <Checkbox
        className="mt-1"
        checked={checked}
        disabled={!line.optional}
        onCheckedChange={(v) => onToggle(v === true)}
      />
      <div data-veil="" className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-[15px] leading-7 font-semibold text-ink">{line.label}</span>
          <span className="num text-[15px] leading-7 font-semibold text-ink">
            {line.gongdao} 公道值
          </span>
        </div>
        <p className="prose-measure mt-0.5 text-[14px] leading-7 text-ink-2">{line.delivers}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {/* 时延承诺照实说：文书那块的快慢不由我们控制 */}
          {line.slaWorkdays === null ? (
            <Badge tone="success">几分钟内出</Badge>
          ) : (
            <Badge tone="amber">
              最长 <span className="num">{line.slaWorkdays}</span> 个工作日
            </Badge>
          )}
        </div>
        {line.slaWorkdays !== null && (
          <p className="prose-measure mt-1 text-[13px] leading-6 text-ink-2">
            这一块要真人登录裁判文书网取证，快慢不由服务器决定。
          </p>
        )}
        {line.refundPromise && (
          <p className="prose-measure mt-1 text-[13px] leading-6 text-ink-2">
            {line.refundPromise}
          </p>
        )}
      </div>
    </label>
  );
}
