import Link from 'next/link';
import type { ReactNode } from 'react';
import { BYO, BYO_GUIDE_HREF, byoBillingLine } from '@/app/_ui/byoAgent';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Button } from '@/components/shadcn/button';
import { Skeleton } from '@/components/shadcn/skeleton';
import { TubashuMark } from '@/components/shell/TubashuMark';

/**
 * /welcome 的两种态，各自一屏。**都是纯组件**：不取数、不认 localStorage、没有 hook，
 * 所以两态都能裸渲（判据见 __tests__/welcome-states.test.tsx 与 welcome-discreet.test.tsx）。
 *
 * 【为什么要两种态（F-201）】这一页原先只有「档案已创建 / 开始首诊」一屏，
 * 而登录成功后不管新老一律落在这里：老用户退出重登，读到的是"你的档案刚建好"，
 * 唯一出路是再走一遍首诊。他的时间线、对话、证据其实都在，只是这一屏没问过。
 *
 * 【为什么不改登录后的落点】那是经理裁决：主理人对自动跳转敏感，/welcome 保留。
 * 所以修的是这一屏说什么，不是它出不出现。
 *
 * 【低调模式】这一屏含案情词（品牌名、BYO.lead 里的「证据 / 文书」、
 * 计费句常规变体里的「案件」、以及「进入我的案件」这颗 CTA），糊层规则一个字不改：
 * 正文块进 data-veil，必须保持可读的壳层按钮走 .discreet-hide / .discreet-only 换词。
 */

/** 两种态共用的外框：裸布局，420 宽，底下一句加密说明。 */
function WelcomeShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <header className="mb-7">
          {/* 品牌名整块进糊层：logo 与「土八鼠」三个字一起糊，只糊字会留下一枚认得出的头像 */}
          <div data-veil="" className="flex items-center gap-2.5">
            <TubashuMark size={28} className="size-7" />
            <span className="text-[18px] font-semibold text-ink">土八鼠</span>
          </div>
          {children}
        </header>
      </div>
      <footer className="mt-10 w-full max-w-[420px] text-[13px] leading-6 text-ink-2">
        材料加密存储，只用于验证、通知和存证出具。
      </footer>
    </div>
  );
}

/**
 * 自带 agent 的接入卡。两种态里都在，且都是**次要**那一颗——
 * 新人的主 CTA 是「开始首诊」，老用户的主 CTA 是「进入我的案件」。
 *
 * 【计费口径两种变体都渲染，由 CSS 挑一个】这句话有常规与低调两种写法
 * （低调那版把「案件分析」收成「分析」，见 byoAgent.byoBillingLine）。
 * 这一屏取不到 useDiscreet（纯组件，也不许把整页转成客户端组件），挑不了；
 * 两句都印上去，用 globals.css 的 .discreet-hide / .discreet-only 按 html[data-discreet] 显示其一。
 * **不这么做的后果是口径不一致**：壳层按低调模式糊着，一按住却读到带「案件」的那句，
 * 而低调模式的整个承诺就是"按住看清的那一眼也不许出现案情词"。
 */
function ByoCard() {
  return (
    <div className="rounded-[10px] border-[1.5px] border-primary bg-primary-wash p-4">
      <p className="text-[15px] leading-6 font-semibold text-ink">{BYO.title}</p>
      <p data-veil="" className="mt-1 text-[13.5px] leading-6 text-ink-2">{BYO.lead}</p>
      <p data-veil="" className="mt-2 text-[13.5px] leading-6 font-semibold text-primary-ink">
        <span className="discreet-hide">
          {byoBillingLine({ credit: '公道值', watch: '守望', discreet: false })}
        </span>
        <span className="discreet-only">
          {byoBillingLine({
            credit: NEUTRAL_WORD.credits,
            watch: NEUTRAL_WORD.watch,
            discreet: true,
          })}
        </span>
      </p>
      <Button asChild variant="secondary" className="mt-3 w-full">
        <Link href={BYO_GUIDE_HREF}>{BYO.cta}（三步，两分钟）</Link>
      </Button>
    </div>
  );
}

/** 两种态共用的尾巴：接不接都不影响。 */
function ByoFootnote() {
  return (
    <p className="text-[13px] leading-6 text-ink-2">
      不接也不影响，网页端功能同样齐全；之后在设置里随时能接。
    </p>
  );
}

/**
 * 新用户那一屏：档案刚建好，主路是去做首诊。
 * 这一屏的每一个字都只对**四个维度全空**的人成立，所以判定收在 lib/cases/freshness。
 */
export function FreshWelcome() {
  return (
    <WelcomeShell>
      <h1 className="mt-6 text-[22px] font-semibold text-ink">档案已创建</h1>
      <p className="prose-measure mt-3 text-[15px] leading-7 text-ink-2">
        手机号和邮箱都验证过了，你的档案已经建好。接下来花几分钟做一次首诊，说清楚现在走到哪一步、公司给了什么说法，系统会算出你的诉求金额和最近的几个期限。
      </p>
      <div className="mt-7 flex flex-col gap-3">
        <Button asChild className="w-full">
          <Link href="/intake">开始首诊</Link>
        </Button>
        {/* 与「开始首诊」并列首位：对已经有惯用 agent 的人，那条是**更省的那条路** */}
        <ByoCard />
        <ByoFootnote />
      </div>
    </WelcomeShell>
  );
}

/**
 * 老用户那一屏：**一个字都不许提首诊**。
 *
 * 主 CTA 直接回他自己的案件；接入卡照旧收在次位（他也可能还没接）。
 * 「案件」是案情词，按钮又必须保持可读（糊了就点不动），所以走壳层换词那条路
 * ——同 _ui/neutral 的口径：位置、肌肉记忆不动，只换字。
 */
export function ReturningWelcome({ caseId }: { caseId: number | string }) {
  return (
    <WelcomeShell>
      <h1 className="mt-6 text-[22px] font-semibold text-ink">欢迎回来</h1>
      <p className="prose-measure mt-3 text-[15px] leading-7 text-ink-2">
        上次记下的东西都在——时间线、材料、聊过的话，一条没少。接着从你停下的地方往下走就行。
      </p>
      <div className="mt-7 flex flex-col gap-3">
        <Button asChild className="w-full">
          <Link href={`/case/${caseId}`}>
            <span className="discreet-hide">进入我的案件</span>
            <span className="discreet-only">进入我的{NEUTRAL_WORD.dashboard}</span>
          </Link>
        </Button>
        <ByoCard />
        <ByoFootnote />
      </div>
    </WelcomeShell>
  );
}

/**
 * 还在问「你是新来的还是回来的」那一刻。
 *
 * **不许先画新用户那一屏再改口**：那一闪正是 F-201 用户读到的那句话，
 * 而它出现在自己的修法里就更没道理。骨架是中性的：它只说"在读"，没有对任何人下结论。
 */
export function WelcomeLoading() {
  return (
    <WelcomeShell>
      <div data-veil="" className="mt-6 flex flex-col gap-3">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    </WelcomeShell>
  );
}
