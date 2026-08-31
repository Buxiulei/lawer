'use client';

import { useState } from 'react';
import { apiFetch, humanError } from '@/app/_ui/api';
import { readToken } from '@/app/_ui/auth';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { WATCH_TIER_GONGDAO, type WatchTier } from '@/lib/billing/pricing';
import { Button } from '@/components/shadcn/button';

/**
 * 一键加守望（spec v3 §2.1 M3）。图谱节点抽屉与公司档案页共用这一个入口。
 *
 * 【三档必须在点之前就摊开】199 / 60 / 0 是**每月**的价，不是这一刻扣的钱。
 * 把档位和月费藏在点完之后，等于让用户在不知道价的情况下订了个按月扣的东西。
 * 价从 lib/billing/pricing 的 WATCH_TIER_GONGDAO 读，界面不写死——改价改那一处。
 *
 * 【这一刻不扣钱】建盯梢只落一行记录，扣费在 lib/company/watch-billing 的月度巡检里。
 * 所以按钮上不说"确认扣费"，说明里如实写"从下一轮月度结算开始按这档收"。
 *
 * 【中性文案约束】低调模式下这一块的**任何**文字都不出现「监控 / 守望 / 公司」，
 * 口径同 lib/notify/copy 的守望计费通知（那边的理由写得很清楚：收件人多半还在原公司上班，
 * 一封写着「某某公司的守望监控」的信被工位旁人瞟见，暴露的是他正在准备什么）。
 * 这一块的每一句——三档说明与入口按钮——**两种模式逐字相同**：
 * 一句话两个版本，漂了没人看得出来；一句话一个版本，漂不了。
 * 入口按钮原先是这里唯一的例外（明文「加入守望」/ 低调「加入关注」），
 * 与本条注释自己的口径就对不上；而它恰恰是整块里最容易被旁人瞟见的一处。
 *
 * 【连点去重在后端】addWatch 按（案件 + 主体）去重，命中已有的原样返回、不改它的档。
 * 所以 created=false 时这里说的是「已经在盯了，档位没被改动」，**不是**「又加了一条」，
 * 也不是失败——把去重命中显示成成功新建，用户会以为自己刚改的档生效了。
 */
export function WatchEntry({
  caseId,
  name,
  uscc,
  companyProfileId,
}: {
  caseId: string;
  name: string;
  uscc?: string | null;
  companyProfileId?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState<WatchTier>('daily');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: boolean; tier: WatchTier } | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!readToken()) {
        setError('登录后才能加进来。');
        return;
      }
      const res = await apiFetch<{ watch: { created: boolean; tier: WatchTier } }>(
        `/cases/${caseId}/watch`,
        { method: 'POST', body: { name, uscc: uscc ?? null, company_profile_id: companyProfileId ?? null, tier } },
      );
      setDone({ created: res.watch.created, tier: res.watch.tier });
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div
        data-testid="watch-entry"
        className="rounded-[12px] border border-border bg-card px-4 py-3.5"
      >
        <p className="text-[15px] leading-7 font-medium text-ink">
          {done.created ? '已加进来。' : '这一家已经在名单里了，档位没有被改动。'}
        </p>
        <p className="prose-measure mt-0.5 text-[14px] leading-7 text-ink-2">
          当前是{TIER_COPY[done.tier].label}，
          <span className="num">{WATCH_TIER_GONGDAO[done.tier]}</span> 额度/月，
          从下一轮月度结算开始算。要换档在名单里改，重复点这里不会改档。
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <div data-testid="watch-entry">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setOpen(true)}
          aria-label={`加入${NEUTRAL_WORD.watch}`}
        >
          {`加入${NEUTRAL_WORD.watch}`}
        </Button>
      </div>
    );
  }

  return (
    <div
      data-testid="watch-entry"
      className="rounded-[12px] border border-border bg-card px-4 py-3.5"
    >
      <p className="text-[15px] leading-7 font-semibold text-ink">
        多久看一次，先挑一个
      </p>
      {/* 「不是这一刻扣钱」要在挑档之前说，不然三个价看起来像三个立刻要付的数 */}
      <p className="prose-measure mt-0.5 text-[14px] leading-7 text-ink-2">
        下面写的是每月的额度，现在不扣，从下一轮月度结算开始按所选档扣。随时可以改档或撤掉。
      </p>

      <WatchTierPicker tier={tier} onPick={setTier} />

      {error && (
        <p className="prose-measure mt-2.5 text-[14px] leading-7 text-amber-ink">{error}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void submit()}>
          就按这档
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
          先不用
        </Button>
      </div>
    </div>
  );
}

/**
 * 三档选择器。**单独导出**是为了让判据够得着它：三档只在展开态才渲染，
 * 而 SSR 点不了那个展开按钮——测不到的那一半，写多少断言都是零。
 */
export function WatchTierPicker({
  tier,
  onPick,
}: {
  tier: WatchTier;
  onPick: (t: WatchTier) => void;
}) {
  return (
    <ul data-testid="watch-tiers" className="mt-3 flex flex-col gap-2">
      {TIER_ORDER.map((t) => (
        <li key={t}>
          <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-border px-3 py-2.5">
            <input
              type="radio"
              name="watch-tier"
              className="mt-1.5 size-4 shrink-0 accent-primary"
              checked={tier === t}
              onChange={() => onPick(t)}
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-[15px] leading-7 font-medium text-ink">
                  {TIER_COPY[t].label}
                </span>
                <span className="num text-[15px] leading-7 font-semibold text-ink">
                  {WATCH_TIER_GONGDAO[t]} 额度/月
                </span>
              </span>
              <span className="prose-measure mt-0.5 block text-[13px] leading-6 text-ink-2">
                {TIER_COPY[t].detail}
              </span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** 档位顺序：贵的在前（默认档也是它），最省的在后。 */
export const TIER_ORDER: readonly WatchTier[] = ['daily', 'weekly', 'archive'];

/**
 * 三档的用户可见说明。
 *
 * 【逐字都不含「监控 / 守望 / 公司」】所以低调模式与明文模式用的是同一句——
 * 两种模式各写一版的那种做法，漂了没有任何一处会报错。
 * 注意这与 lib/graph/contract 的 GRAPH_TIER_LABELS（「圈1·每天看一次」）是两套文案：
 * 那套是图例上的圈层名，本套是下单前的档位说明，谁也别去改成另一套。
 * 两套现在都不含那三个词了——那套原先含（「圈1·每日监控」），而它印在图例与节点抽屉的
 * 徽标上、**不在糊层里**，低调模式下照常明文可读，见 GRAPH_TIER_LABELS 的文件注释。
 */
const TIER_COPY: Record<WatchTier, { label: string; detail: string }> = {
  daily: {
    label: '每天看一次',
    detail: '有新动静当天就知道。要紧的那一两家用这档。',
  },
  weekly: {
    label: '每周看一次',
    detail: '一周汇总一次。关系远一点、暂时不急的用这档。',
  },
  archive: {
    label: '只存下来，不定期看',
    detail: '先把这一家的快照留着，什么时候要盯了再升档，不花额度。',
  },
};
