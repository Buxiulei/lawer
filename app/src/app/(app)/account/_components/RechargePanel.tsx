'use client';

import { useState } from 'react';
import {
  GONGDAO_PER_YUAN,
  PLANS,
  PLAN_NOTE,
  TOPUP_MAX_YUAN,
  TOPUP_MIN_YUAN,
  TOPUP_PRESETS_YUAN,
} from '@/app/_mock/authpay';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import { formatFen } from '@/app/_ui/format';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { Input } from '@/components/shadcn/input';
import { RadioGroup, RadioGroupItem } from '@/components/shadcn/radio-group';

/** membership=null 表示还没登录：没有"当前档"，每一档都是可以挑的 */
export function RechargePanel({ membership }: { membership: string | null }) {
  const [amount, setAmount] = useState('30');
  const { discreet } = useDiscreet();
  // 价目要买东西的人看得懂，不能进糊层，低调模式下只换词
  const creditWord = discreet ? NEUTRAL_WORD.credits : '公道值';

  const yuan = Number(amount);
  const amountOk =
    Number.isFinite(yuan) &&
    Number.isInteger(yuan) &&
    yuan >= TOPUP_MIN_YUAN &&
    yuan <= TOPUP_MAX_YUAN;

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
                    含 {plan.gongdao.toLocaleString('zh-CN')} {creditWord} / 月
                  </p>

                  <p className="mt-3 text-[14px] leading-6 text-ink">{plan.routing}</p>
                  {/* 「适合谁」这句会写到「已经进仲裁」，价格和套餐名不会 */}
                  <p data-veil="" className="mt-1 text-[13px] leading-6 text-ink-2">
                    {plan.fit}
                  </p>

                  <div className="mt-auto pt-4">
                    {/* 支付通道未接，全档禁用。**不留「选这档 → 确认支付 ¥N → 其实没接」
                        那条路**：走到「确认支付」才说没开通，是拿用户的信任换一次点击。 */}
                    <Button size="sm" className="w-full" variant="secondary" disabled>
                      {plan.available ? '支付暂未开通' : '敬请期待'}
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>

        <p data-veil="" className="mt-3 text-[13px] leading-6 text-ink-2">
          {PLAN_NOTE}
        </p>
      </section>

      <Card className="mt-6 p-4">
        <h2 className="text-[17px] font-semibold text-ink">散充</h2>
        <p className="num mt-0.5 text-[14px] leading-6 text-ink-2">
          1 元 = {GONGDAO_PER_YUAN} {creditWord}，充多少充多久都行，不过期。
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
              ? `到账 ${(yuan * GONGDAO_PER_YUAN).toLocaleString('zh-CN')} ${creditWord}`
              : `请填 ${TOPUP_MIN_YUAN}–${TOPUP_MAX_YUAN} 之间的整数`}
          </span>
        </div>

        {/* 上面的档位与换算留着——它回答「¥30 能买多少」，这个信息本身有用；
            但按钮不留：没接通的支付入口点下去只会让人白填一遍。 */}
        <p className="mt-4 rounded-[8px] border-l-4 border-line bg-surface-2 px-3 py-2 text-[14px] leading-6 text-ink-2">
          支付通道还没开通，现在充不了值。开通后这里直接就能用，不用你再找入口。
        </p>
      </Card>

    </>
  );
}
