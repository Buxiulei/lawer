'use client';

import { useEffect, useState } from 'react';
import { apiFetch, humanError } from '@/app/_ui/api';
import type { AgentSetupInfo } from './agentSetup';

export interface AgentSetupState {
  info: AgentSetupInfo | null;
  loading: boolean;
  error: string | null;
}

/** GET /api/v1/agent-setup：接入地址与工具清单的唯一来源，页面不硬编码任何一条。 */
export function useAgentSetup(): AgentSetupState {
  const [state, setState] = useState<AgentSetupState>({
    info: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let alive = true;
    apiFetch<AgentSetupInfo>('/agent-setup').then(
      (info) => alive && setState({ info, loading: false, error: null }),
      (err) => alive && setState({ info: null, loading: false, error: humanError(err) }),
    );
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
