'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/app/_ui/api';
import { fetchMe, type MeView } from './_data';

export interface MeState {
  data: MeView | null;
  loading: boolean;
  unauthorized: boolean;
}

/**
 * 本人身份摘要。**取不到就什么都不显示**——这一页宁可空着，也不许拿演示值填。
 * 所以这里连 error 都不往外传：身份行没有"出错了"的渲染，只有"有"和"没有"。
 */
export function useMe(): MeState {
  const [state, setState] = useState<MeState>({
    data: null,
    loading: true,
    unauthorized: false,
  });

  useEffect(() => {
    let alive = true;
    fetchMe().then(
      (data) => alive && setState({ data, loading: false, unauthorized: false }),
      (err) =>
        alive &&
        setState({
          data: null,
          loading: false,
          unauthorized: err instanceof ApiError && err.errorCode === 'UNAUTHORIZED',
        }),
    );
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
