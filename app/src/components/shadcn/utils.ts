import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn 体系专用的 cn：比 @/app/_ui/cn 多一层 tailwind-merge，
 * 好让调用方用 className 覆盖组件里写死的同组工具类（h-8 → h-11 这种）。
 * 手写体系那边继续用 @/app/_ui/cn，两边不互相影响。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
