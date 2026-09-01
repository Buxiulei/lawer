'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, humanError } from '@/app/_ui/api';
import { fetchBilling, type BillingView } from './_data';

/** 一次取多少条流水。「再看更多」是把这个数加一档再取，后端只认 limit。 */
export const LEDGER_PAGE_SIZE = 20;

export interface BillingState {
  data: BillingView | null;
  loading: boolean;
  error: string | null;
  /** 没登录/登录过期：这一页本来就不该显示任何属于你的东西，不是"取不到" */
  unauthorized: boolean;
  /** 还有没有更多可取 */
  hasMore: boolean;
  loadMore: () => void;
  /**
   * 重取余额与流水。给「兑换码到账后余额要立刻变」用——
   * 前端自己把面值加到旧余额上也能让数字动起来，但那个数是**算出来的**，
   * 后端真到了多少无从得知；这一页的用途恰恰是对账，不能显示一个前端推测值。
   */
  refresh: () => void;
}

export function useBilling(): BillingState {
  const [limit, setLimit] = useState(LEDGER_PAGE_SIZE);
  /** 重取的触发器：limit 没变时也要能让下面那个 effect 再跑一遍 */
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{
    data: BillingView | null;
    loading: boolean;
    error: string | null;
    unauthorized: boolean;
  }>({ data: null, loading: true, error: null, unauthorized: false });

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fetchBilling(limit).then(
      (data) => alive && setState({ data, loading: false, error: null, unauthorized: false }),
      (err) =>
        alive &&
        setState({
          data: null,
          loading: false,
          error: humanError(err),
          unauthorized: err instanceof ApiError && err.errorCode === 'UNAUTHORIZED',
        }),
    );
    return () => {
      alive = false;
    };
  }, [limit, nonce]);

  const loadMore = useCallback(() => setLimit((n) => n + LEDGER_PAGE_SIZE), []);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return {
    ...state,
    hasMore: state.data !== null && !state.data.complete,
    loadMore,
    refresh,
  };
}
