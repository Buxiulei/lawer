import type { ReactNode } from 'react';
import { cn } from '@/app/_ui/cn';

export function Card({
  children,
  className,
  tone = 'surface',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'surface' | 'wash' | 'plain';
}) {
  return (
    <section
      className={cn(
        'rounded-[12px] border shadow-soft',
        tone === 'surface' && 'bg-surface border-line',
        tone === 'wash' && 'bg-primary-wash border-transparent',
        tone === 'plain' && 'bg-surface-2 border-transparent shadow-none',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  action,
  className,
}: {
  title: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex items-center justify-between gap-3 px-4 pt-4 pb-2',
        className,
      )}
    >
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
      {action}
    </header>
  );
}

export function CardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('px-4 pb-4', className)}>{children}</div>;
}
