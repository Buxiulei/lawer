'use client';

import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';

/**
 * 吉祥物姿势位。**全站唯一的吉祥物出口**——想画土八鼠只能走这里。
 *
 * 两条硬禁区靠这个收口，而不是靠各处记得写条件：
 *
 * 1. **低调模式零品牌暴露**：低调开着就返回 `null`。不是打糊、不是换灰图——
 *    整个 DOM 节点不存在。打糊层（`data-veil`）挡的是「看清内容」，
 *    挡不住「一眼认出这是个卡通角色」，而角色本身就是泄密面。
 * 2. **危机轮零卡通**：危机场景整轮不渲染本组件（调用方不挂）。
 *    这条没法在组件内自检——组件不知道自己在哪一轮——所以它由**测试**盯，
 *    见 `__tests__/mascot-forbidden-zones.test.tsx`。
 *
 * **姿势永远不是信息的唯一载体**：每个落位旁边都必须有把话说清楚的文字。
 * 因此一律 `alt=""` + `aria-hidden`，读屏不念——念了就是重复。
 *
 * 【尺寸判据 2026-08-29 提高】从「认得出形」提到「**看得清表情**」（用户：太小了看不清）。
 * 5× 放大逐档实测的阈值：守望 52px、催办裁切版 48px——**低于阈值时脸只是一团色，
 * 情绪传不到，那这个位置就只是噪点**（同落地页徽章那条「传不到就只是噪点」）。
 */
const POSE = {
  /** 平时态：站岗、竖耳。驾驶舱顶部唯一常驻位 */
  watch: { src: '/brand/pose-watch-160.webp', intrinsic: 160 },
  /** 期限 ≤3 天：指着闹钟发火。**火冲的是闹钟，不是用户** */
  nag: { src: '/brand/pose-nag-144.webp', intrinsic: 144 },
  /** 证据固化成功：抱紧卷宗 */
  guard: { src: '/brand/pose-guard-160.webp', intrinsic: 160 },
  /** 真里程碑达成：举拳。小操作上不出现 */
  cheer: { src: '/brand/pose-cheer-224.webp', intrinsic: 224 },
  /** 空状态：递出卷宗 */
  guide: { src: '/brand/pose-guide-360.webp', intrinsic: 360 },
} as const;

export type MascotPose = keyof typeof POSE;

export function Mascot({
  pose,
  size,
  className,
}: {
  pose: MascotPose;
  /** 渲染边长（CSS px）。资产按各自落位的实际尺寸出档，别放大超过 intrinsic */
  size: number;
  className?: string;
}) {
  const { discreet } = useDiscreet();
  if (discreet) return null;

  const { src } = POSE[pose];
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      /* 装饰件不该拦指针：角标是绝对定位、放大到 48px 后会盖住底下一片区域，
         今天底下恰好没有可点的东西，但那是运气不是设计 */
      className={cn('pointer-events-none shrink-0 select-none', className)}
    />
  );
}
