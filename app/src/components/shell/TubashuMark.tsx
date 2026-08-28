import { cn } from '@/app/_ui/cn';

/**
 * 品牌小标记：**用户所发徽章版 logo 的头部裁切**（源 `素材/品牌/土八鼠logo.png`，裁切框 380 40 570 570）。
 *
 * **一律原图直出，不许任何重绘或描摹**（2026-08-28 用户裁定：
 * 「logo 用我发你的，不要用你自己的 svg 版本了」——此前的手绘简化版与 vtracer 描摹版**全部退役**）。
 *
 * **取头部而不是整枚徽章**：整枚徽章自带「土八鼠」字标，而这里旁边就跟着同样三个字的文字，
 * 用整枚会把名字写两遍；且徽章缩到 24px 后字标糊成一条噪线。
 * 头部裁切在 24px 仍读得出"戴眼镜的动物脸"。**小尺寸糊是已知代价，不因此回退到重绘。**
 *
 * 装饰性用途：alt 留空并 aria-hidden，名字由旁边的文字承担。
 */
export function TubashuMark({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <img
      src="/brand/mark-96.webp"
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={cn('shrink-0', className)}
    />
  );
}
