'use client';

import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import { formatDateTime } from '@/app/_ui/format';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { DataTable, type DataTableColumn } from '@/components/shadcn/data-table';
import { EmptyState } from '@/components/shadcn/empty-state';
import { toneOf, type LedgerEntryView } from './_data';
import type { BillingState } from './useBilling';

function formatPoints(n: number): string {
  return Math.abs(n).toLocaleString('zh-CN');
}

// 「公道值」那一列的表头要跟着低调模式换词，所以列定义要拿到当前用词
const columnsWith = (creditWord: string): DataTableColumn<LedgerEntryView>[] => [
  {
    key: 'type',
    header: '类型',
    card: 'title',
    cell: (e) => <Badge tone={toneOf(e.type)}>{e.type}</Badge>,
  },
  {
    key: 'feature',
    header: '用途',
    card: 'meta',
    // 表格是 auto 布局，列宽只能靠内层 span 的 max-w 卡住（见 DESIGN.md 用法说明）
    cell: (e) => <span className="block max-w-[12rem] truncate">{e.feature ?? '—'}</span>,
  },
  {
    key: 'createdAt',
    header: '时间',
    numeric: true,
    card: 'footnote',
    cell: (e) => formatDateTime(e.createdAt),
  },
  {
    key: 'delta',
    header: creditWord,
    numeric: true,
    sensitive: true,
    card: 'footnote',
    cell: (e) => (
      <span
        className={cn(
          'font-semibold',
          // 进账用 success，消耗用正文色——扣费不该是警报
          e.delta > 0 ? 'text-success' : 'text-ink',
        )}
      >
        {e.delta > 0 ? '+' : '-'}
        {formatPoints(e.delta)}
      </span>
    ),
  },
  {
    key: 'balanceAfter',
    header: '余额',
    numeric: true,
    sensitive: true,
    card: 'footnote',
    // 表格里这一列有表头，卡片里没有，所以窄屏自己补个前缀
    cell: (e) => (
      <>
        <span className="sm:hidden">余额 </span>
        {formatPoints(e.balanceAfter)}
      </>
    ),
  },
];

/**
 * 公道值流水：只追加不修改（spec §7），余额随每笔结算，便于自己对账。
 *
 * 数据由 `useBilling` 在 `AccountView` 里取一次，余额与流水共用同一次响应——
 * 各取各的会出现「余额是这一秒的、流水是上一秒的」，而这一页的用途恰恰是对账。
 */
export function LedgerList({ billing }: { billing: BillingState }) {
  const { data, loading, error, hasMore, loadMore } = billing;
  const { discreet } = useDiscreet();
  const creditWord = discreet ? NEUTRAL_WORD.credits : '公道值';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 pb-1">
        <h2 className="text-[17px] font-semibold text-ink">流水</h2>
        {data && data.complete && (
          <span className="num text-[13px] text-ink-2">共 {data.entries.length} 条</span>
        )}
      </div>
      <p className="text-[14px] leading-6 text-ink-2">
        每一笔都记着，只增不改。对不上账随时把这页截给我们。
      </p>

      {error && !loading && (
        <p className="mt-2 text-[14px] leading-6 text-danger-ink">{error}</p>
      )}

      {!error && data && data.entries.length === 0 && !loading && (
        <EmptyState
          className="mt-2"
          title="还没有流水"
          description="等你开始用，每一笔消耗和充值都会记在这里。"
        />
      )}

      {data && data.entries.length > 0 && (
        <DataTable
          className="mt-2"
          columns={columnsWith(creditWord)}
          rows={data.entries}
          rowKey={(e) => String(e.id)}
          caption={`${creditWord}流水`}
        />
      )}

      {hasMore && (
        <div className="pt-3">
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            disabled={loading}
            onClick={loadMore}
          >
            {loading ? '加载中…' : '再看更多'}
          </Button>
        </div>
      )}
    </div>
  );
}
