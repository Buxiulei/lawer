import * as React from 'react';
import { cn } from './utils';

function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="card"
      className={cn(
        'flex flex-col rounded-[12px] border border-border bg-card text-card-foreground shadow-soft',
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<'header'>) {
  return (
    <header
      data-slot="card-header"
      className={cn(
        'flex items-start justify-between gap-3 px-4 pt-4 pb-2',
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return (
    <h2
      data-slot="card-title"
      className={cn('text-[15px] leading-7 font-semibold text-foreground', className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="card-description"
      className={cn('text-[14px] leading-6 text-muted-foreground', className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="card-action" className={cn('shrink-0', className)} {...props} />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="card-content" className={cn('px-4 pb-4', className)} {...props} />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center gap-2 border-t border-border px-4 py-3', className)}
      {...props}
    />
  );
}

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
};
