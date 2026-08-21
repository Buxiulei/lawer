'use client';

import { useState } from 'react';
import {
  LEDGER_PAGE_SIZE,
  ledgerPage,
  mockLedger,
  type LedgerEntry,
  type LedgerType,
} from '@/app/_mock/authpay';
import { cn } from '@/app/_ui/cn';
import { formatDateTime } from '@/app/_ui/format';
import { Badge, type BadgeTone } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { DataTable, type DataTableColumn } from '@/components/shadcn/data-table';

const TYPE_TONE: Record<LedgerType, BadgeTone> = {
  注册赠送: 'success',
  充值: 'success',
  兑换码: 'success',
  退款: 'success',
  消耗: 'neutral',
  固化出证: 'primary',
};

function formatPoints(n: number): string {
  return Math.abs(n).toLocaleString('zh-CN');
}

const COLUMNS: DataTableColumn<LedgerEntry>[] = [
  {
    key: 'meta',
    header: '明细',
    card: 'title',
    // 表格是 auto 布局，列宽只能靠内层 span 的 max-w 卡住（见 DESIGN.md 用法说明）；
    // 这一列的文字最长，不卡住的话 1280 下六列会把余额挤出可视区
    cell: (e) => <span className="line-clamp-2 block max-w-[15rem]">{e.meta}</span>,
  },
  {
    key: 'type',
    header: '类型',
    card: 'badge',
    cell: (e) => <Badge tone={TYPE_TONE[e.type]}>{e.type}</Badge>,
  },
  {
    key: 'feature',
    header: '用途',
    card: 'meta',
    cell: (e) => <span className="block max-w-[8rem] truncate">{e.feature}</span>,
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
    header: '公道值',
    numeric: true,
    sensitive: true,
    card: 'footnote',
    cell: (e) => (
      <span
        className={cn(
          'font-semibold',
          // 充值/赠送/退款进账用 success，消耗用正文色——扣费不该是警报
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
 */
export function LedgerList() {
  const [page, setPage] = useState(0);
  const { entries, hasMore } = ledgerPage(page);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 pb-1">
        <h2 className="text-[17px] font-semibold text-ink">流水</h2>
        <span className="num text-[13px] text-ink-2">共 {mockLedger.length} 条</span>
      </div>
      <p className="text-[14px] leading-6 text-ink-2">
        每一笔都记着，只增不改。对不上账随时把这页截给我们。
      </p>

      <DataTable
        className="mt-2"
        columns={COLUMNS}
        rows={entries}
        rowKey={(e) => e.id}
        caption="公道值流水"
      />

      {hasMore && (
        <div className="pt-3">
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => setPage((p) => p + 1)}
          >
            再看 {Math.min(LEDGER_PAGE_SIZE, mockLedger.length - entries.length)} 条
          </Button>
        </div>
      )}
    </div>
  );
}
