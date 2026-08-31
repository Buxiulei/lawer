'use client';

import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import { useReducedMotion } from '@/app/_ui/motion';

/**
 * 落章。**「这一步定了」的唯一视觉基元**，形与曲线复用落地页那枚「土八鼠印」。
 *
 * 只在三个时刻出现：里程碑达成 / 证据固化 / 文书定稿。本期只接第一处。
 * **不是庆祝彩带**：庆祝的正确形态是下一件事出现。落章说的是「盖了章，回不去了」。
 *
 * 两条硬禁区，与 `Mascot` 同源，靠这个组件收口而不是靠各处记得写条件：
 *
 * 1. **低调模式零品牌暴露**：低调开着返回 `null`。这枚章上写着「土八鼠印」四个字，
 *    比卡通形象还直白——一眼就知道这台手机上装着某个特定的东西。
 * 2. **减弱动效整条不建**：它是装饰不是状态反馈，减弱动效下**不渲染**，
 *    不是播 0.01ms。里程碑达成的静止判据是那格底下的日期，章没了那行字还在。
 *
 * 所以调用方**必须容忍它不存在**：编排的后续步骤不许挂在它的完成回调上。
 */
export function Seal({
  size = 40,
  className,
}: {
  /** 渲染边长（CSS px）。
   *  设计稿写 28——但落地页那枚 92px 配 23px 字，等比缩到 28 只剩 7px 字，
   *  四个字糊成一团红。同 `Mascot`「传不到就只是噪点」那条判据，取 40 保住字形。 */
  size?: number;
  className?: string;
}) {
  const { discreet } = useDiscreet();
  const reduce = useReducedMotion();
  if (discreet || reduce) return null;

  return (
    <span
      aria-hidden
      data-seal=""
      /* opacity 起点写在 inline 上而不是等 gsap：章挂载与第一帧动画之间隔着一次
         布局，中间那一帧会是「一枚不转不缩、全不透明的红章突然出现」。 */
      style={{ width: size, height: size, fontSize: Math.round(size * 0.25), opacity: 0 }}
      className={cn(
        'mo-seal-mark font-serif-static pointer-events-none grid place-items-center',
        'rounded-[4px] border-2 border-primary leading-[1.2] font-black tracking-[0.08em] text-primary',
        className,
      )}
    >
      <span className="w-[2.4em] text-center">土八鼠印</span>
    </span>
  );
}
