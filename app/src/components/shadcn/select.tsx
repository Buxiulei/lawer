import * as React from 'react';
import { cn } from './utils';
import { ChevronDownIcon } from './icons';

/**
 * 下拉选择。刻意用**原生 select** 而不是 @radix-ui/react-select：
 * 手机上原生选择器是系统级滚轮，比自绘浮层好按也好读，
 * 而这套产品的下拉全是「从固定枚举里挑一个」，用不上 Radix 那些自绘能力。
 * 需要富内容（图标、多行、分组渲染）的菜单走 dropdown-menu.tsx。
 */
function Select({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <div data-slot="select" className="relative">
      <select
        className={cn(
          'h-12 w-full appearance-none rounded-[10px] border border-input bg-muted pr-10 pl-3 text-[16px] text-foreground',
          'transition-colors duration-150 ease-out focus:border-primary focus:outline-none',
          'aria-invalid:border-destructive',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

export { Select };
