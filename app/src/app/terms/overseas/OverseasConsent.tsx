'use client';

// app/src/app/terms/overseas/OverseasConsent.tsx
// 境外模型的**单独同意**件（《个人信息保护法》第三十九条）。设置页那个开关挂它。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量。
// ─────────────────────────────────────────────────────
//
// 【为什么正文不写在这里】见 OverseasDetails 的文件头：说明页与同意件必须念同一份告知，
// 否则"公示的告知"与"取得同意时给的告知"不是同一段话。
//
// 【为什么两个按钮都要有，且「不同意」不是叉号】§39 的同意必须是**单独**且**自愿**的。
// 只给一个「同意」再靠右上角叉号关掉的形态是：用户按叉是"我先不看"，
// 而系统这边只知道"没同意"——两种意思挤在同一个动作上，谁也说不清他表示过什么。
// 所以「不同意」是一个平级的、明写着后果的按钮。
//
// 【默认落点】两个按钮都不预选、不自动聚焦到「同意」。默认落在同意上的形态是：
// 一次回车就成了一次跨境传输的单独同意。
import { useState } from 'react';

import { Button } from '@/components/shadcn/button';

import { OverseasDetails } from './OverseasDetails';

export interface OverseasConsentProps {
  /** 用户按下「同意并开启」。落库同意记录、开开关都由调用方做——这一件只负责告知与取意。 */
  onAgree: () => void | Promise<void>;
  /** 用户按下「不同意」。调用方据此保持关闭；不要把它当成"稍后再说"。 */
  onDecline: () => void | Promise<void>;
}

export function OverseasConsent({ onAgree, onDecline }: OverseasConsentProps) {
  // 两个动作都可能是异步的（要落一条同意记录）。按下去没有任何反馈的形态是：
  // 用户以为没点上，于是再点一次——同一份同意落两条，或者开关被来回拨。
  const [busy, setBusy] = useState(false);

  async function run(fn: () => void | Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[17px] font-semibold text-ink">开启境外模型前，请先读这一页</h2>
        <p className="prose-measure mt-2 text-[14px] leading-7 text-ink-2">
          开启后，你的对话内容与档案摘要会被发送到中华人民共和国境外处理。
          按《个人信息保护法》第三十九条，这需要你的
          <strong className="font-semibold text-ink">单独同意</strong>
          ——它与你注册时对《用户服务协议》的同意是两件事，不能互相顶替。
        </p>
      </div>

      <OverseasDetails />

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <Button className="w-full sm:w-auto" disabled={busy} onClick={() => void run(onAgree)}>
          {busy ? '处理中…' : '我已读并同意，开启境外模型'}
        </Button>
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          disabled={busy}
          onClick={() => void run(onDecline)}
        >
          不同意，继续只用境内模型
        </Button>
      </div>
    </div>
  );
}
