import type { Metadata } from 'next';
import Link from 'next/link';
import { BYO, BYO_GUIDE_HREF, byoBillingLine } from '@/app/_ui/byoAgent';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Button } from '@/components/shadcn/button';
import { TubashuMark } from '@/components/shell/TubashuMark';

export const metadata: Metadata = { title: '档案已创建' };

/**
 * 注册完成页：双验证走完之后落在这里。
 * 两个去处并列首位——先去首诊（主路），或者把档案接到自己惯用的 AI 助手上。
 * 裸布局，不套 AppShell：此时还没有当前案件，底部 Tab 无处可指。
 *
 * 【接入那条为什么从次级按钮升成卡】对已经有惯用 agent 的人，那条是**更省的那条路**，
 * 而它原先只是一颗次级按钮加一段小字，读起来像"高级用户可选项"。
 *
 * 【低调模式】server component 取不到 useDiscreet，但糊层是纯 CSS
 * （globals.css 的 `html[data-discreet='1'] [data-veil]`），server component 照样吃得上：
 * 该糊的块写个 data-veil 属性就进层了。
 *
 * 这一屏**含案情词**：品牌名「土八鼠」、BYO.lead 里的「证据 / 文书」、
 * 计费口径常规变体里的「案件」——三处都进糊层。守卫见 __tests__/welcome-discreet.test.tsx。
 *
 * 【糊了也揭得开】按住看清的手势层挂在同目录的 layout.tsx 上（就是 AppShell 用的
 * 那一个 DiscreetVeil，不是另抄一份），所以这一屏跟站内其它页一样：糊着，按住能看清。
 * 页面自己仍是纯 server component——手势层在 layout 里，这一页不带任何客户端 hook。
 *
 * 【计费口径两种变体都渲染，由 CSS 挑一个】这句话有常规与低调两种写法
 * （低调那版把「案件分析」收成「分析」，见 byoAgent.byoBillingLine）。
 * server component 取不到 useDiscreet，挑不了；两句都印上去，
 * 用 globals.css 的 .discreet-hide / .discreet-only 按 html[data-discreet] 显示其一。
 * **不这么做的后果是口径不一致**：壳层按低调模式糊着，一按住却读到带「案件」的那句，
 * 而低调模式的整个承诺就是"按住看清的那一眼也不许出现案情词"。
 */
export default function WelcomePage() {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <header className="mb-7">
          {/* 品牌名整块进糊层：logo 与「土八鼠」三个字一起糊，只糊字会留下一枚认得出的头像 */}
          <div data-veil="" className="flex items-center gap-2.5">
            <TubashuMark size={28} className="size-7" />
            <span className="text-[18px] font-semibold text-ink">土八鼠</span>
          </div>
          <h1 className="mt-6 text-[22px] font-semibold text-ink">档案已创建</h1>
          <p className="prose-measure mt-3 text-[15px] leading-7 text-ink-2">
            手机号和邮箱都验证过了，你的档案已经建好。接下来花几分钟做一次首诊，说清楚现在走到哪一步、公司给了什么说法，系统会算出你的诉求金额和最近的几个期限。
          </p>
        </header>

        <div className="flex flex-col gap-3">
          <Button asChild className="w-full">
            <Link href="/intake">开始首诊</Link>
          </Button>
          {/* 与「开始首诊」并列首位。
              顺带修掉一个死链：原来指 `/settings#api-keys`，而全仓没有 id="api-keys" 的锚点，
              点了只会落到设置页顶部——指到一页式指南之后这个锚点自然消失。 */}
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
          <p className="text-[13px] leading-6 text-ink-2">
            不接也不影响，网页端功能同样齐全；之后在设置里随时能接。
          </p>
        </div>
      </div>

      <footer className="mt-10 w-full max-w-[420px] text-[13px] leading-6 text-ink-2">
        材料加密存储，只用于验证、通知和存证出具。
      </footer>
    </div>
  );
}
