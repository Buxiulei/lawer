'use client';

import Link from 'next/link';
import { GONGDAO_PER_YUAN } from '@/app/_mock/authpay';
import { useSignedIn } from '@/app/_ui/auth';
import { useDiscreet } from '@/app/_ui/discreet';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Sensitive } from '@/components/Sensitive';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { LedgerList } from './LedgerList';
import { RechargePanel } from './RechargePanel';
import { useBilling, type BillingState } from './useBilling';
import { useMe, type MeState } from './useMe';

/**
 * 「我的」页。没登录时这一页上**没有任何属于你的东西**——身份、余额、流水一概不显示，
 * 只留一张登录引导卡和套餐介绍。套餐是公开定价，谁都能先看看再决定要不要注册。
 *
 * 【余额与流水共用一次请求】各取各的会出现「余额是这一秒的、流水是上一秒的」，
 * 而这一页的用途恰恰是对账。
 *
 * 【没有昵称】`users` 表里没有这个字段，全站也没有任何地方让用户起过名。
 * 后端不编默认值，前端也不拿 `_mock/demo` 的 `demoUser` 顶——
 * **两侧都不编，这一行才真的空着，空着才有人去问为什么。**
 * 身份行显示的是服务端已掩码的手机号（没绑手机就退到邮箱，都没有就整行不出现）。
 */
export function AccountView() {
  const signedIn = useSignedIn();
  const billing = useBilling();
  const me = useMe();

  return (
    <div className="pt-1 pb-4">
      <header className="flex items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold text-ink">我的</h1>
          {signedIn && <IdentityLine me={me} />}
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/settings">设置</Link>
        </Button>
      </header>

      {signedIn ? <BalanceCard billing={billing} me={me} /> : <SignInCard />}

      <div className="mt-6">
        {/* 套餐没有真值可取，就不显示徽标——同一条纪律：没有真值就没有徽标 */}
        <RechargePanel membership={null} />
      </div>

      {signedIn && (
        <div className="mt-8">
          <LedgerList billing={billing} />
        </div>
      )}
    </div>
  );
}

/** 手机号没有就退到邮箱；两个都没有，整行不出现——空着好过编一个 */
function IdentityLine({ me }: { me: MeState }) {
  const shown = me.data?.phoneMasked ?? me.data?.email;
  if (!shown) return null;
  return (
    <p data-veil="" className="num mt-0.5 truncate text-[14px] text-ink-2">
      {shown}
    </p>
  );
}

function BalanceCard({ billing, me }: { billing: BillingState; me: MeState }) {
  const { discreet } = useDiscreet();
  const { data, loading, error } = billing;
  const creditWord = discreet ? NEUTRAL_WORD.credits : '公道值';

  return (
    <Card className="border-transparent bg-primary-wash p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[14px] text-ink-2">{creditWord}余额</p>
        <div className="flex shrink-0 gap-1.5">
          {/* 无有效会员 → 后端给 null → 这里就没有徽标。不显示「无」这类占位 */}
          {me.data?.membership && <Badge tone="gold">{me.data.membership.plan}套餐</Badge>}
          {me.data && (
            <Badge tone={me.data.authStatus === '已实名' ? 'success' : 'amber'}>
              {me.data.authStatus}
            </Badge>
          )}
        </div>
      </div>

      <Sensitive as="div" className="mt-1 inline-block">
        <span className="num text-[40px] leading-[52px] font-semibold text-primary-ink">
          {loading && data === null ? '—' : (data?.balance.toLocaleString('zh-CN') ?? '—')}
        </span>
      </Sensitive>

      {error && !loading && (
        <p className="mt-1 text-[14px] leading-6 text-danger-ink">{error}</p>
      )}

      {data && data.balance < 0 && <OverdraftNote creditWord={creditWord} />}
      {data && !data.reconciled && <ReconcileWarning creditWord={creditWord} data={data} />}

      <p data-veil="" className="prose-measure mt-1 text-[14px] leading-6 text-ink-2">
        {creditWord}是模型用量的计价单位，用多少扣多少：散充 1 元 = {GONGDAO_PER_YUAN}{' '}
        {creditWord}，套餐月卡另含当月额度。
      </p>

      <SelfHostHint creditWord={creditWord} />
    </Card>
  );
}

/**
 * 省公道值的那条路：把这里接到用户自己的 AI 助手上。放在余额下面而不是只留在设置页——
 * 想省钱的念头是在**看着余额**的时候起的，不是在翻设置的时候。
 *
 * 【这句话凭什么敢说——依据在代码里，不是营销话术】
 * 扣费只有一个出口：`lib/billing` 的 `gongdaoSettle`。全仓非测试代码里调它的地方
 * **只有一处**——`lib/agent/orchestrator.ts`，且在「结算一次模型轮次」那个位置；
 * 而 orchestrator 只经 `runTurn` 导出，`runTurn` 的唯一调用方是
 * `api/v1/cases/[id]/chat`（网页对话那条路）。
 * MCP 的七个工具（case_get / case_update / timeline_add / action_list /
 * action_complete / deadline_list / evidence_list）与 v1 案件数据路由**一行扣费都不碰**。
 * ⇒「数据读写不扣、只有我们替你调模型才扣」是可核对的事实，不是估计。
 *
 * 【为什么不写数字】`lib/billing/pricing.ts` 开头写明：全部费率是**草案值，待 M3 核定**。
 * 拿未核定的草案值算出「省百分之多少」印在页面上，是把一个随时会变的数说成承诺。
 * 所以这里只讲**扣不扣**，不讲**省多少**——省多少取决于用户自己助手那边的价，我们无从得知。
 *
 * 【低调模式】整句跟着 `creditWord` 换成中性词，且不带任何案件字样，
 * 与同卡其余文案一样进糊层（data-veil）。
 */
function SelfHostHint({ creditWord }: { creditWord: string }) {
  return (
    <p data-veil="" className="prose-measure mt-2 text-[14px] leading-6 text-ink-2">
      想省着用：把这里接到你自己的 AI 助手上，读写数据这些活就由它那边干，不扣{creditWord}——
      {creditWord}只在我们这边真的替你调模型时才扣（比如网页里的对话）。
      <Link href="/settings" className="mx-1 text-primary-ink underline underline-offset-4">
        去设置里接
      </Link>
    </p>
  );
}

/**
 * 余额与账本对不上时的提示。
 *
 * **这不是多余的谨慎，是兑现页面上已经印着的那句话**——流水那段写着
 * 「每一笔都记着，只增不改。对不上账随时把这页截给我们。」
 * 后端特意把 `balance` 与 `ledger_sum` 分开返回，就是为了让不符**有机会被看见**；
 * 前端只挑一个数显示，等于把这个信号扔了，用户会看到一个**看起来完全正常的错数**。
 * 这条对账信号唯一的读者就是用户本人。
 */
function ReconcileWarning({
  creditWord,
  data,
}: {
  creditWord: string;
  data: NonNullable<BillingState['data']>;
}) {
  return (
    <div
      role="status"
      className="mt-2 rounded-[8px] border-l-4 border-amber bg-amber-wash px-3 py-2"
    >
      <p className="text-[14px] leading-6 font-semibold text-amber-ink">
        这个余额和下面的流水对不上
      </p>
      <p data-veil="" className="mt-0.5 text-[13.5px] leading-5 text-amber-ink">
        余额显示 <span className="num">{data.balance.toLocaleString('zh-CN')}</span>，
        流水累加是 <span className="num">{data.ledgerSum.toLocaleString('zh-CN')}</span>。
        以流水为准——{creditWord}的账本只增不改，它才是原始记录。
        请把这页截图发给我们，这是我们的问题，不会算在你头上。
      </p>
    </div>
  );
}

/**
 * 负余额是**设计内**的，不是错账：计费按实际 token 结算、不预扣，
 * 最后一单允许透支入负（后端 lib/billing 铁律四）。
 * 不解释一句，用户看见「−522」只会以为自己欠了钱或者系统算错了。
 */
function OverdraftNote({ creditWord }: { creditWord: string }) {
  return (
    <p data-veil="" className="mt-1.5 text-[13.5px] leading-5 text-ink-2">
      余额是负的，说明最后一次用量把它扣穿了——按实际用量结算、不预扣，所以会出现这种情况。
      补上之后就能接着用，这段时间的记录不会丢。
    </p>
  );
}

function SignInCard() {
  return (
    <Card className="p-5">
      <h2 data-veil="" className="text-[17px] font-semibold text-ink">
        登录后查看你的公道值与套餐
      </h2>
      <p data-veil="" className="prose-measure mt-1.5 text-[14px] leading-6 text-ink-2">
        公道值是模型用量的计价单位，用多少扣多少：散充 1 元 = {GONGDAO_PER_YUAN}{' '}
        公道值，套餐月卡另含当月额度。下面的定价现在就能看，登录之后才能买。
      </p>
      <Button asChild className="mt-4">
        <Link href="/login">去登录</Link>
      </Button>
    </Card>
  );
}
