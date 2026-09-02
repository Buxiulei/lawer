'use client';

import Link from 'next/link';
import {
  BYO_GUIDE_HREF,
  byoConnectedBillingLine,
} from '@/app/_ui/byoAgent';
import { useDiscreet } from '@/app/_ui/discreet';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { useConnectedAgent } from '@/app/_ui/useConnectedAgent';

/**
 * 已接入用户进网页对话时的一行提示。
 *
 * **不阻断**：这里照常能聊，只是把"那边不扣、这里按轮计"摆在他按下发送之前。
 * 拦一道确认框是另一回事——那会把一次正常的提问变成一次要过关的操作，
 * 而他可能正是**故意**回网页来用我们这边的模型的。
 *
 * 没接入的人看不到这一行：对他们这只是噪音，他们那条路在驾驶舱的常驻入口里。
 */
export function ByoAgentNotice() {
  const { discreet } = useDiscreet();
  const { connected, name } = useConnectedAgent();
  if (!connected) return null;
  const credit = discreet ? NEUTRAL_WORD.credits : '公道值';
  return (
    <p
      data-veil=""
      role="status"
      className="mb-2 rounded-[10px] border-l-4 border-primary bg-primary-wash px-3 py-2 text-[13.5px] leading-6 text-ink-2"
    >
      你已接入自己的 agent（{name}）。{byoConnectedBillingLine(credit)}
      <Link
        href={BYO_GUIDE_HREF}
        className="mx-1 text-primary-ink underline underline-offset-4"
      >
        看配置
      </Link>
    </p>
  );
}
