'use client';

import { useState } from 'react';
import {
  LEDGER_PAGE_SIZE,
  ledgerPage,
  mockLedger,
  type LedgerType,
} from '@/app/_mock/authpay';
import { cn } from '@/app/_ui/cn';
import { formatDateTime } from '@/app/_ui/format';
import { Sensitive } from '@/components/Sensitive';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

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

      <ul className="mt-2">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="flex items-start gap-3 border-b border-line py-3 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Badge tone={TYPE_TONE[entry.type]}>{entry.type}</Badge>
                <span className="truncate text-[13px] text-ink-2">{entry.feature}</span>
              </div>
              <p className="mt-1.5 text-[15px] leading-6 text-ink">{entry.meta}</p>
              <p className="num mt-0.5 text-[13px] text-ink-2">
                {formatDateTime(entry.createdAt)}
              </p>
            </div>

            <Sensitive as="div" className="shrink-0 text-right">
              <p
                className={cn(
                  'num text-[16px] leading-6 font-semibold',
                  // 充值/赠送/退款进账用 success，消耗用正文色——扣费不该是警报
                  entry.delta > 0 ? 'text-success' : 'text-ink',
                )}
              >
                {entry.delta > 0 ? '+' : '-'}
                {formatPoints(entry.delta)}
              </p>
              <p className="num mt-0.5 text-[13px] text-ink-2">
                余额 {formatPoints(entry.balanceAfter)}
              </p>
            </Sensitive>
          </li>
        ))}
      </ul>

      {hasMore && (
        <div className="pt-3">
          <Button
            variant="secondary"
            size="sm"
            fullWidth
            onClick={() => setPage((p) => p + 1)}
          >
            再看 {Math.min(LEDGER_PAGE_SIZE, mockLedger.length - entries.length)} 条
          </Button>
        </div>
      )}
    </div>
  );
}
