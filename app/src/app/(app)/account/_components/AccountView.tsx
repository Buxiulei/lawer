'use client';

import Link from 'next/link';
import { GONGDAO_PER_YUAN, gongdaoBalance } from '@/app/_mock/authpay';
import { demoUser } from '@/app/_mock/demo';
import { useSignedIn } from '@/app/_ui/auth';
import { Sensitive } from '@/components/Sensitive';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { LedgerList } from './LedgerList';
import { RechargePanel } from './RechargePanel';

/**
 * 「我的」页。没登录时这一页上**没有任何属于你的东西**——身份、余额、流水一概不显示，
 * 只留一张登录引导卡和套餐介绍。套餐是公开定价，谁都能先看看再决定要不要注册。
 *
 * 已登录那半边的余额与流水目前还是 mock（真实接口未开），接上之后这里只换数据来源。
 */
export function AccountView() {
  const signedIn = useSignedIn();

  return (
    <div className="pt-1 pb-4">
      <header className="flex items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold text-ink">我的</h1>
          {signedIn && (
            <p className="num mt-0.5 truncate text-[14px] text-ink-2">
              {demoUser.nickname} · {demoUser.phoneMasked}
            </p>
          )}
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/settings">设置</Link>
        </Button>
      </header>

      {signedIn ? <BalanceCard /> : <SignInCard />}

      <div className="mt-6">
        <RechargePanel membership={signedIn ? demoUser.membership : null} />
      </div>

      {signedIn && (
        <div className="mt-8">
          <LedgerList />
        </div>
      )}
    </div>
  );
}

function BalanceCard() {
  return (
    <Card className="border-transparent bg-primary-wash p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[14px] text-ink-2">公道值余额</p>
        <div className="flex shrink-0 gap-1.5">
          <Badge tone="gold">{demoUser.membership}套餐</Badge>
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
  );
}

function SignInCard() {
  return (
    <Card className="p-5">
      <h2 className="text-[17px] font-semibold text-ink">登录后查看你的公道值与套餐</h2>
      <p className="prose-measure mt-1.5 text-[14px] leading-6 text-ink-2">
        公道值是模型用量的计价单位，用多少扣多少：散充 1 元 = {GONGDAO_PER_YUAN}{' '}
        公道值，套餐月卡另含当月额度。下面的定价现在就能看，登录之后才能买。
      </p>
      <Button asChild className="mt-4">
        <Link href="/login">去登录</Link>
      </Button>
    </Card>
  );
}
