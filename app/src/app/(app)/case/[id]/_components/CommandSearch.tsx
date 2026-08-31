'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { demoEvidence } from '@/app/_mock/demo';
import { mockDrafts } from '@/app/_mock/docs-drafts';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import { useHotkeys } from '@/app/_ui/hotkeys';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Dialog, DialogContent, DialogTitle } from '@/components/shadcn/dialog';
import { CASE_NAV_ITEMS } from '@/components/shell/navItems';

/**
 * 命令面板（设计 §四「键盘」的 ⌘K / `/`）。
 *
 * 只做**跳转**，不做 AI 动作——设计里「明确不做」的一条：一个会写文书的搜索框，
 * 用户敲一半会不敢按回车。
 *
 * 【低调模式：只列栏目，不列材料名】文件名是全页最招人的东西
 * （「解除劳动合同通知书（原件扫描）.pdf」），而搜索结果是**不能打糊**的——
 * 糊着的搜索结果等于没有结果。所以低调时直接不列，并在面板里说明为什么。
 */

interface Entry {
  id: string;
  label: string;
  hint: string;
  href: string;
}

function entriesFor(caseId: string, discreet: boolean): Entry[] {
  const nav = CASE_NAV_ITEMS.map((item) => ({
    id: `nav:${item.key}`,
    label: (discreet && item.discreetLabel) || item.label,
    hint: '栏目',
    href: item.href(caseId),
  }));
  const account: Entry = { id: 'nav:account', label: '我的', hint: '栏目', href: '/account' };
  if (discreet) return [...nav, account];

  const drafts = mockDrafts.map((d) => ({
    id: `draft:${d.id}`,
    label: d.title,
    hint: `文书 · ${d.kind}`,
    href: `/case/${caseId}/drafts/${d.id}`,
  }));
  // 证据没有独立详情路由，落到证据页；材料名是这里最值钱的检索词
  const evidence = demoEvidence.map((e) => ({
    id: `ev:${e.id}`,
    label: e.name,
    hint: `证据 · ${e.category}`,
    href: `/case/${caseId}/evidence`,
  }));
  return [...nav, account, ...drafts, ...evidence];
}

/** 子串匹配，不做模糊匹配：中文上模糊匹配的「聪明」结果多半是错的。 */
export function filterEntries(entries: readonly Entry[], query: string): Entry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter(
    (e) => e.label.toLowerCase().includes(q) || e.hint.toLowerCase().includes(q),
  );
}

/** 上下键在 [0, n) 里绕圈；n 为 0 时恒回 0，免得算出 NaN 当索引用。 */
export function nextIndex(current: number, n: number, step: 1 | -1): number {
  if (n <= 0) return 0;
  return (current + step + n) % n;
}

/**
 * ⌘K / `/` 的**唯一**挂载点——注册进 `_ui/hotkeys.ts` 的那张声明表，
 * **绝不自挂 document keydown**（那会踩 hotkeys 的结构守卫，也把「谁先吃这一下」
 * 的次序问题重新打散）。「正在打字时别抢键」由 hotkeys 的 isTypingTarget 统一管：
 * 裸 `/` 在输入框里让位给输入，⌘K 带修饰键则照常放行。
 */
export function useCommandSearchHotkey(onOpen: () => void): void {
  useHotkeys({
    'mod+k': () => {
      onOpen();
      return true;
    },
    slash: () => {
      onOpen();
      return true;
    },
  });
}

export function CommandSearch({
  caseId,
  open,
  onOpenChange,
}: {
  caseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { discreet } = useDiscreet();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const entries = useMemo(() => entriesFor(caseId, discreet), [caseId, discreet]);
  const hits = useMemo(() => filterEntries(entries, query), [entries, query]);

  // 每次重开都从头开始：留着上次的关键词，第二次按 ⌘K 会看到一屏莫名其妙的结果
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  const go = (entry: Entry | undefined) => {
    if (!entry) return;
    onOpenChange(false);
    router.push(entry.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = nextIndex(active, hits.length, e.key === 'ArrowDown' ? 1 : -1);
      setActive(next);
      listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      go(hits[active]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="cmdk-panel gap-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">跳到</DialogTitle>
        <div className="border-b border-line p-2.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="搜索栏目与材料"
            aria-controls="cmdk-list"
            placeholder={discreet ? '跳到某个栏目' : '跳到某个栏目、文书或材料'}
            className="h-10 w-full rounded-[8px] bg-muted px-3 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
          />
        </div>

        <ul
          id="cmdk-list"
          ref={listRef}
          role="listbox"
          aria-label="搜索结果"
          className="max-h-[46vh] overflow-y-auto p-1.5"
        >
          {hits.map((entry, i) => (
            <li key={entry.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                tabIndex={-1}
                onMouseMove={() => setActive(i)}
                onClick={() => go(entry)}
                className={cn(
                  'flex w-full items-baseline gap-2 rounded-[8px] px-2.5 py-2 text-left',
                  'transition-colors duration-150 ease-out',
                  i === active ? 'bg-primary-wash' : 'bg-transparent',
                )}
              >
                <span className="min-w-0 flex-1 truncate fs-s text-ink">{entry.label}</span>
                <span className="shrink-0 fs-xs text-ink-2">{entry.hint}</span>
              </button>
            </li>
          ))}
          {hits.length === 0 && (
            <li className="px-2.5 py-6 text-center fs-s text-ink-2">没有匹配的去处</li>
          )}
        </ul>

        <p className="border-t border-line px-3 py-2 fs-xs text-ink-2">
          {discreet
            ? '低调模式下只列栏目，不列材料名——搜索结果没法打码，能读出来就等于露出来。'
            : '↑↓ 选择 · 回车打开 · Esc 关闭'}
        </p>
      </DialogContent>
    </Dialog>
  );
}
