'use client';

import { useEffect, useState } from 'react';
import { ApiError, apiFetch, humanError } from '@/app/_ui/api';
import type { AgentSetupInfo } from './agentSetup';

export interface AgentSetupState {
  info: AgentSetupInfo | null;
  loading: boolean;
  error: string | null;
  /** 没登录/登录过期：卡片改出禁用态骨架，而不是把它说成"取不到" */
  unauthorized: boolean;
}

/** GET /api/v1/agent-setup：接入地址与工具清单的唯一来源，页面不硬编码任何一条。 */
export function useAgentSetup(): AgentSetupState {
  const [state, setState] = useState<AgentSetupState>({
    info: null,
    loading: true,
    error: null,
    unauthorized: false,
  });

  useEffect(() => {
    let alive = true;
    apiFetch<AgentSetupInfo>('/agent-setup').then(
      (info) =>
        alive && setState({ info, loading: false, error: null, unauthorized: false }),
      (err) =>
        alive &&
        setState({
          info: null,
          loading: false,
          error: humanError(err),
          unauthorized: err instanceof ApiError && err.errorCode === 'UNAUTHORIZED',
        }),
    );
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
