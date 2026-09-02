'use client';

import Link from 'next/link';
import {
  BYO,
  BYO_GUIDE_HREF,
  byoBillingLine,
  byoConnectedBillingLine,
  byoConnectedLine,
} from './byoAgent';
import { useDiscreet } from './discreet';
import { NEUTRAL_WORD } from './neutral';
import { useConnectedAgent } from './useConnectedAgent';

/**
 * 「用你自己的 agent」的常驻入口。驾驶舱与账户页共用这一份。
 *
 * 两种形态：
 *   未接入 → 推荐（标题 + 完整计费口径），这是省钱那条路，值得占一行。
 *   已接入 → 收成一行安静的状态，不再重复推销；只留那半句提醒——
 *            "那边不扣、这里按轮计"，因为他随时可能又回到网页里打字。
 *
 * 【低调模式】标题换中性词、正文进糊层（data-veil）：与全站「换词只给壳层、
 * 正文进糊层」的既定分工一致（见 _ui/neutral 顶部说明）。
 */
export function ByoAgentEntry({ className = '' }: { className?: string }) {
  const { discreet } = useDiscreet();
  const { connected, name, when } = useConnectedAgent();
  const credit = discreet ? NEUTRAL_WORD.credits : '公道值';
  const watch = discreet ? NEUTRAL_WORD.watch : '守望';

  return (
    <Link
      href={BYO_GUIDE_HREF}
      data-mo-enter
      className={`flex min-h-11 items-center gap-3 rounded-[10px] border border-line bg-surface px-3.5 py-3 no-underline ${className}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] leading-6 font-medium text-ink">
          {connected ? byoConnectedLine(name, when) : discreet ? BYO.titleNeutral : BYO.title}
        </span>
        <span data-veil="" className="mt-0.5 block text-[13px] leading-5 text-ink-2">
          {connected
            ? byoConnectedBillingLine(credit)
            : byoBillingLine({ credit, watch, discreet })}
        </span>
      </span>
      <span aria-hidden className="shrink-0 text-[15px] text-ink-2">
        ›
      </span>
    </Link>
  );
}
