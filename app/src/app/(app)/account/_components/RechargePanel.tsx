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
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';
import { Input } from '@/components/shadcn/input';
import { RadioGroup, RadioGroupItem } from '@/components/shadcn/radio-group';
import { useToast } from '@/components/ui/Toast';

interface PendingPay {
  title: string;
  description: string;
  confirmLabel: string;
}

/** membership=null 表示还没登录：没有"当前档"，每一档都是可以挑的 */
export function RechargePanel({ membership }: { membership: string | null }) {
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
              <li key={plan.key} className="flex">
                <Card
                  className={cn(
                    'w-full p-4',
                    current && 'border-primary',
                    !plan.available && 'opacity-60',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[15px] font-semibold text-ink">{plan.key}</span>
                    {current && <Badge tone="primary">当前</Badge>}
                    {!plan.available && <Badge>待开发</Badge>}
                  </div>

                  <p
                    className={cn(
                      'num mt-2 text-[26px] leading-9 font-semibold',
                      plan.available ? 'text-primary-ink' : 'text-ink-2',
                    )}
                  >
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
                      className="w-full"
                      variant={current ? 'secondary' : 'primary'}
                      disabled={!plan.available}
                      onClick={() => payPlan(plan)}
                    >
                      {!plan.available ? '敬请期待' : current ? '续一个月' : '选这档'}
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>

        <p className="mt-3 text-[13px] leading-6 text-ink-2">{PLAN_NOTE}</p>
      </section>

      <Card className="mt-6 p-4">
        <h2 className="text-[17px] font-semibold text-ink">散充</h2>
        <p className="num mt-0.5 text-[14px] leading-6 text-ink-2">
          1 元 = {GONGDAO_PER_YUAN} 公道值，充多少充多久都行，不过期。
        </p>

        {/* 常用档位是一组单选：手填别的金额时整组自然落到"没选中"，不用额外清一次 */}
        <RadioGroup
          aria-label="常用充值金额"
          value={amount}
          onValueChange={setAmount}
          className="mt-3"
        >
          {TOPUP_PRESETS_YUAN.map((preset) => (
            <RadioGroupItem key={preset} value={String(preset)} className="num min-w-20 px-4">
              ¥{preset}
            </RadioGroupItem>
          ))}
        </RadioGroup>

        <div className="mt-3 flex items-center gap-2">
          <span className="text-[15px] text-ink-2">¥</span>
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            aria-label="自定义充值金额（元）"
            className="num w-32"
          />
          <span className="num text-[14px] text-ink-2">
            {amountOk
              ? `到账 ${(yuan * GONGDAO_PER_YUAN).toLocaleString('zh-CN')} 公道值`
              : `请填 ${TOPUP_MIN_YUAN}–${TOPUP_MAX_YUAN} 之间的整数`}
          </span>
        </div>

        <div className="mt-4">
          <Button className="w-full" disabled={!amountOk} onClick={payTopup}>
            去支付
          </Button>
        </div>
      </Card>

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
