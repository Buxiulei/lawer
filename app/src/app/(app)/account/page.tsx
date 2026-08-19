import type { Metadata } from 'next';
import Link from 'next/link';
import { GONGDAO_PER_YUAN, gongdaoBalance } from '@/app/_mock/authpay';
import { demoUser } from '@/app/_mock/demo';
import { Sensitive } from '@/components/Sensitive';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { LedgerList } from './_components/LedgerList';
import { RechargePanel } from './_components/RechargePanel';

export const metadata: Metadata = { title: '我的' };

export default function AccountPage() {
  return (
    <div className="pt-1 pb-4">
      <header className="flex items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold text-ink">我的</h1>
          <p className="num mt-0.5 truncate text-[14px] text-ink-2">
            {demoUser.nickname} · {demoUser.phoneMasked}
          </p>
        </div>
        <Link
          href="/settings"
          className="flex min-h-11 items-center rounded-[10px] px-3 text-[15px] text-primary-ink hover:bg-primary-wash"
        >
          设置
        </Link>
      </header>

      <Card tone="wash" className="p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[14px] text-ink-2">公道值余额</p>
          <div className="flex shrink-0 gap-1.5">
            <Badge tone="primary">{demoUser.membership}套餐</Badge>
            <Badge tone={demoUser.authStatus === '已实名' ? 'success' : 'amber'}>
              {demoUser.authStatus}
            </Badge>
          </div>
        </div>

        <Sensitive as="div" className="mt-1 inline-block">
          <span className="num text-[40px] leading-[52px] font-semibold text-primary-ink">
            {gongdaoBalance.toLocaleString('zh-CN')}
          </span>
        </Sensitive>

        <p className="prose-measure mt-1 text-[14px] leading-6 text-ink-2">
          公道值是模型用量的计价单位，用多少扣多少：散充 1 元 = {GONGDAO_PER_YUAN}{' '}
          公道值，套餐月卡另含当月额度。
        </p>
      </Card>

      <div className="mt-6">
        <RechargePanel membership={demoUser.membership} />
      </div>

      <div className="mt-8">
        <LedgerList />
      </div>
    </div>
  );
}
