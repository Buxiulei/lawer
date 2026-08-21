import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from './utils';
import { ChevronRightIcon } from './icons';

function Breadcrumb(props: React.ComponentProps<'nav'>) {
  return <nav aria-label="面包屑" data-slot="breadcrumb" {...props} />;
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<'ol'>) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(
        'flex flex-wrap items-center gap-1.5 text-[14px] text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn('inline-flex items-center gap-1.5', className)}
      {...props}
    />
  );
}

function BreadcrumbLink({
  className,
  asChild,
  ...props
}: React.ComponentProps<'a'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'a';
  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn('transition-colors duration-150 ease-out hover:text-foreground', className)}
      {...props}
    />
  );
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn('font-medium text-foreground', className)}
      {...props}
    />
  );
}

function BreadcrumbSeparator({ className, children, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden
      className={cn('text-muted-foreground/70 [&>svg]:size-3.5', className)}
      {...props}
    >
      {children ?? <ChevronRightIcon />}
    </li>
  );
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
};
