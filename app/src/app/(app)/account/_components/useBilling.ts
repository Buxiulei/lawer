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
}

export function useBilling(): BillingState {
  const [limit, setLimit] = useState(LEDGER_PAGE_SIZE);
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
  }, [limit]);

  const loadMore = useCallback(() => setLimit((n) => n + LEDGER_PAGE_SIZE), []);

  return {
    ...state,
    hasMore: state.data !== null && !state.data.complete,
    loadMore,
  };
}
