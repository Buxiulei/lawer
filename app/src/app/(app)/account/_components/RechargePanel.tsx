'use client';

import { useState } from 'react';
import {
  GONGDAO_PER_YUAN,
  PLANS,
  PLAN_NOTE,
  TOPUP_MAX_YUAN,
  TOPUP_MIN_YUAN,
  TOPUP_PRESETS_YUAN,
  type PlanSku,
} from '@/app/_mock/authpay';
import { cn } from '@/app/_ui/cn';
import { formatFen } from '@/app/_ui/format';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';

interface PendingPay {
  title: string;
  description: string;
  confirmLabel: string;
}

export function RechargePanel({ membership }: { membership: string }) {
  const toast = useToast();
  const [pending, setPending] = useState<PendingPay | null>(null);
  const [amount, setAmount] = useState('30');

  const yuan = Number(amount);
  const amountOk =
    Number.isFinite(yuan) &&
    Number.isInteger(yuan) &&
    yuan >= TOPUP_MIN_YUAN &&
    yuan <= TOPUP_MAX_YUAN;

  const payPlan = (plan: PlanSku) => {
    setPending({
      title: `${plan.key}套餐 · 按月`,
      description: `到账 ${plan.gongdao.toLocaleString('zh-CN')} 公道值，本月内${plan.routing}。到期不自动续费。`,
      confirmLabel: `确认支付 ¥${formatFen(plan.priceFen)}`,
    });
  };

  const payTopup = () => {
    if (!amountOk) return;
    setPending({
      title: '散充公道值',
      description: `到账 ${(yuan * GONGDAO_PER_YUAN).toLocaleString('zh-CN')} 公道值，不限使用期限，模型路由仍按当前套餐走。`,
      confirmLabel: `确认支付 ¥${yuan}`,
    });
  };

  return (
    <>
      <section>
        <h2 className="text-[17px] font-semibold text-ink">套餐月卡</h2>
        <p className="mt-0.5 text-[14px] leading-6 text-ink-2">
          差别只在关键环节用哪个模型。情况越复杂、文件越多，越值得往上选一档。
        </p>

        <ul className="mt-3 grid gap-3 sm:grid-cols-3">
          {PLANS.map((plan) => {
            const current = plan.key === membership;
            return (
              <li
                key={plan.key}
                className={cn(
                  'flex flex-col rounded-[12px] border bg-surface p-4 shadow-soft',
                  current ? 'border-primary' : 'border-line',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[15px] font-semibold text-ink">{plan.key}</span>
                  {current && (
                    <span className="rounded-full bg-primary-wash px-2 py-0.5 text-[12px] text-primary-ink">
                      当前
                    </span>
                  )}
                </div>

                <p className="num mt-2 text-[26px] leading-9 font-semibold text-primary-ink">
                  ¥{formatFen(plan.priceFen)}
                </p>
                <p className="num text-[13px] text-ink-2">
                  含 {plan.gongdao.toLocaleString('zh-CN')} 公道值 / 月
                </p>

                <p className="mt-3 text-[14px] leading-6 text-ink">{plan.routing}</p>
                <p className="mt-1 text-[13px] leading-6 text-ink-2">{plan.fit}</p>

                <div className="mt-auto pt-4">
                  <Button
                    size="sm"
                    fullWidth
                    variant={current ? 'secondary' : 'primary'}
                    onClick={() => payPlan(plan)}
                  >
                    {current ? '续一个月' : '选这档'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>

        <p className="mt-3 text-[13px] leading-6 text-ink-2">{PLAN_NOTE}</p>
      </section>

      <section className="mt-6 rounded-[12px] border border-line bg-surface p-4 shadow-soft">
        <h2 className="text-[17px] font-semibold text-ink">散充</h2>
        <p className="num mt-0.5 text-[14px] leading-6 text-ink-2">
          1 元 = {GONGDAO_PER_YUAN} 公道值，充多少充多久都行，不过期。
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {TOPUP_PRESETS_YUAN.map((preset) => {
            const active = String(preset) === amount;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => setAmount(String(preset))}
                aria-pressed={active}
                className={cn(
                  'num h-11 min-w-20 rounded-[10px] border px-4 text-[15px] transition-colors duration-150 ease-out',
                  active
                    ? 'border-primary bg-primary-wash font-semibold text-primary-ink'
                    : 'border-line bg-surface-2 text-ink',
                )}
              >
                ¥{preset}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="text-[15px] text-ink-2">¥</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            aria-label="自定义充值金额（元）"
            className="num h-12 w-32 rounded-[10px] border border-line bg-surface-2 px-3 text-[16px] text-ink focus:border-primary focus:outline-none"
          />
          <span className="num text-[14px] text-ink-2">
            {amountOk
              ? `到账 ${(yuan * GONGDAO_PER_YUAN).toLocaleString('zh-CN')} 公道值`
              : `请填 ${TOPUP_MIN_YUAN}–${TOPUP_MAX_YUAN} 之间的整数`}
          </span>
        </div>

        <div className="mt-4">
          <Button fullWidth disabled={!amountOk} onClick={payTopup}>
            去支付
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.title ?? ''}
        description={pending?.description ?? ''}
        confirmLabel={pending?.confirmLabel ?? ''}
        tone="primary"
        onConfirm={() => {
          setPending(null);
          toast('支付对接开发中', 'neutral', '有一条新的更新');
        }}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
