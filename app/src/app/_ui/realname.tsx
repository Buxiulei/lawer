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

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { ApiError, apiFetch } from './api';
import { NEUTRAL_WORD } from './neutral';
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/alert';
import { Button } from '@/components/shadcn/button';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';

export const REALNAME_REQUIRED = 'REALNAME_REQUIRED';

/** 实名区块的锚点 id，落在设置页的 RealnameCard 上 */
export const REALNAME_ANCHOR = 'realname';
export const REALNAME_HREF = `/settings#${REALNAME_ANCHOR}`;

/** users.auth_status 里唯一放行的取值（与 lib/auth/realname 的 AUTH_STATUS.verified 同字面） */
export const REALNAME_VERIFIED = '已实名';
/** 认证发起了但还没落定：待审。文案与「未认证」不同，但一样不放行 */
export const REALNAME_PENDING = '待审';

/** 已实名才放行；待审 / 未认证 / 未知（未取到）一律未放行——与服务端 requireRealname 同口径 */
export function isRealnameVerified(status: string | null | undefined): boolean {
  return status === REALNAME_VERIFIED;
}

/**
 * 本人实名态。复用 /api/v1/me（account 的 useMe 读的同一个接口，这里只取 auth_status），
 * 案件工作区里没有现成的 me 上下文可挂。取不到就给 null——调用方按「未放行」处理，
 * 真正的拦截仍在服务端 requireRealname，这里只决定要不要提前把上传入口收起来。
 */
export function useRealnameStatus(): { status: string | null; loading: boolean } {
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    apiFetch<{ auth_status: string }>('/me').then(
      (me) => {
        if (!alive) return;
        setStatus(me.auth_status);
        setLoading(false);
      },
      () => {
        if (!alive) return;
        setStatus(null);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  return { status, loading };
}

/**
 * 上传入口是否要收起来，以及收起来时该说哪一档话。
 * 三个布尔一起从案件工作区传给 UploadBar / UploadSheet，省得逐个钻。
 */
export interface RealnameGate {
  /** 未实名（待审或未认证）——true 时收起上传入口、禁用控件 */
  blocked: boolean;
  /** 待审（认证发起了在审）——文案是「审核中」，与「未认证」不同档 */
  pending: boolean;
  /** 低调模式——提示卡必须保持可读，靠换词避开案情词，不进糊层 */
  discreet: boolean;
}

/** 收起上传入口时给的默认档：放行、不收。给未传 realname 的调用方兜底。 */
export const REALNAME_GATE_OPEN: RealnameGate = { blocked: false, pending: false, discreet: false };

/**
 * 上传入口的实名提示卡。**必须保持可读**——这是要用户去做一件事的号召，糊掉就点不动，
 * 所以不进糊层；低调模式靠换词避开案情词（证据 → 资料，NEUTRAL_WORD.evidence）。
 *
 * 自述三段式：怎么了（上传前先实名）/ 为什么（未实名的材料无法保存、无法出证）/
 * 怎么办（去「设置 → 实名认证」，按钮跳 REALNAME_HREF）。
 * 待审是另一档：材料已交在审，只说「审核中，通过后即可上传」，不再给去实名的按钮。
 */
export function RealnamePrompt({ gate }: { gate: RealnameGate }) {
  if (gate.pending) {
    return (
      <Alert tone="amber">
        <AlertTitle>实名审核中</AlertTitle>
        <AlertDescription className="mt-0.5">通过后即可上传，无需重复提交。</AlertDescription>
      </Alert>
    );
  }
  const noun = gate.discreet ? NEUTRAL_WORD.evidence : '证据';
  return (
    <Alert tone="amber">
      <AlertTitle>上传前需先完成实名认证</AlertTitle>
      <AlertDescription className="mt-0.5">
        {gate.discreet
          ? `${noun}要与本人身份绑定，未实名的${noun}无法保存。`
          : '证据要与本人身份绑定，未实名的证据无法保存、日后也无法出证。'}
      </AlertDescription>
      <Button size="sm" className="mt-3" asChild>
        <Link href={REALNAME_HREF}>去实名认证</Link>
      </Button>
    </Alert>
  );
}

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
