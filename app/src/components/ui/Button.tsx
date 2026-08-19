import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/app/_ui/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white hover:opacity-90 active:opacity-80',
  secondary:
    'bg-surface text-ink border border-line hover:bg-surface-2 active:bg-surface-2',
  ghost: 'bg-transparent text-primary-ink hover:bg-primary-wash',
  // danger 仅用于不可逆操作的确认按钮（DESIGN.md 色彩规则）
  danger: 'bg-danger text-white hover:opacity-90 active:opacity-80',
};

const SIZES: Record<ButtonSize, string> = {
  md: 'h-12 px-5 text-[16px]',
  sm: 'h-11 px-4 text-[15px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[10px] font-medium',
        'transition-[opacity,background-color] duration-150 ease-out',
        'disabled:cursor-not-allowed disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
