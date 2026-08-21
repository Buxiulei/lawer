'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from './utils';

const Tabs = TabsPrimitive.Root;

/** 当前态用主色下划线 + 字重，不靠底色块（DESIGN.md 关键组件语义） */
function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('flex gap-1 overflow-x-auto border-b border-border', className)}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'relative min-h-11 shrink-0 px-3 text-[15px] text-muted-foreground outline-none',
        'transition-colors duration-150 ease-out hover:text-foreground',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        'data-[state=active]:font-semibold data-[state=active]:text-primary-ink',
        "data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-primary data-[state=active]:after:content-['']",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
