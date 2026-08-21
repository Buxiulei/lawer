'use client';

/**
 * REALNAME_REQUIRED 的通用拦截：出证 / 导出 / 分享这类要落到法律文件上的动作，
 * 后端回这个错误码时不弹技术错误，而是弹一次说明 + 一个去实名的入口。
 *
 * 用法：
 *   const { guard, dialog } = useRealnameGate();
 *   await guard(() => attestEvidence(id));   // 被拦下时返回 null，不抛
 *   ... {dialog}
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ApiError } from './api';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

export const REALNAME_REQUIRED = 'REALNAME_REQUIRED';

/** 实名区块的锚点 id，落在设置页的 RealnameCard 上 */
export const REALNAME_ANCHOR = 'realname';
export const REALNAME_HREF = `/settings#${REALNAME_ANCHOR}`;

export function useRealnameGate() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const guard = useCallback(async <T,>(run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof ApiError && err.errorCode === REALNAME_REQUIRED) {
        setOpen(true);
        return null;
      }
      throw err;
    }
  }, []);

  const dialog = (
    <ConfirmDialog
      open={open}
      title="需要实名认证"
      description="出具法律效力文件需要实名。实名信息仅用于存证证明与实人认证，不会出现在其他页面。"
      confirmLabel="去实名"
      cancelLabel="暂不"
      tone="primary"
      onConfirm={() => {
        setOpen(false);
        router.push(REALNAME_HREF);
      }}
      onCancel={() => setOpen(false)}
    />
  );

  return { guard, dialog };
}
