'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch, humanError } from '@/app/_ui/api';
import { REALNAME_ANCHOR } from '@/app/_ui/realname';
import { Sensitive } from '@/components/Sensitive';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/shadcn/card';
import { Skeleton } from '@/components/shadcn/skeleton';
import { CodeBlock } from './CodeBlock';
import { IdCardForm } from './IdCardForm';
import { PassportForm } from './PassportForm';
import { SignInHint } from './SignInHint';

/**
 * 实人认证。锚点 #realname——REALNAME_REQUIRED 拦截框的「去实名」按钮落在这儿。
 *
 * 流程（lib/auth/realname.ts）：POST /realname/init 拿阿里云 H5 活体认证页地址 →
 * 用户在**手机上**刷脸 → 阿里云不回调，只能靠 GET /realname/status 轮询。
 * 手机上直接跳过去；电脑上跳过去也做不了（要摄像头刷脸），所以给链接让用户拿手机打开。
 *
 * 三态对齐 users.auth_status：未认证 / 待审 / 已实名。
 */

/** users.auth_status 的三个取值，与 lib/auth/realname.ts AUTH_STATUS 逐字对齐 */
const AUTH_STATUS = {
  none: '未认证',
  pending: '待审',
  verified: '已实名',
} as const;

interface RealnameStatus {
  auth_status: string;
  verification_status: string | null;
  message: string;
  /** 这次走的是哪条通道。护照是人工审核，待审文案与刷脸完全不同 */
  method?: 'cloudauth' | 'passport' | null;
}

interface RealnameInit {
  certify_url: string | null;
  certify_id: string;
  verification_id: number;
}

/** 轮询：5 秒一次、最多 60 次（5 分钟）。到顶就停，改成用户手点——总比后台空转一晚上强。 */
const POLL_MS = 5000;
const POLL_LIMIT = 60;

/**
 * 只存**脱敏后**的姓名，绝不存明文姓名或身份证号。
 * 认证结果接口不回姓名（服务端那份是加密列，刻意不外发），
 * 而「已实名」光秃秃一个状态用户没法确认认的是不是自己，所以本机留一份已经打过码的。
 */
const MASKED_NAME_KEY = 'lawer.realname.masked';

/** 王小明 → 王*明；王明 → 王*；单字原样 */
export function maskName(name: string): string {
  const chars = Array.from(name.trim());
  if (chars.length <= 1) return chars.join('');
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

function readMaskedName(): string | null {
  try {
    return localStorage.getItem(MASKED_NAME_KEY);
  } catch {
    return null;
  }
}

function rememberMaskedName(masked: string): void {
  try {
    localStorage.setItem(MASKED_NAME_KEY, masked);
  } catch {
    // 隐私模式下写不进去，只是少显示一个脱敏姓名，不影响认证
  }
}

/** 大陆二代身份证的形状，与服务端 isIdCard 同一条正则；真伪交给阿里云 */
function isIdCard(value: string): boolean {
  return /^\d{17}[\dXx]$/.test(value.trim());
}

/**
 * 发起失败的文案。后端把阿里云的原话透传上来（如「阿里云实人认证凭证未配置」），
 * 那是我们的运维问题，不该甩给一个正在被裁员的人看——就地换成温和的说法。
 */
function initFailureCopy(err: unknown): string {
  if (err instanceof ApiError && err.errorCode === 'REALNAME_INIT_FAILED') {
    return '实名认证这会儿发起不了，是我们这边的问题，不是你的信息有误。过一会儿再试一次。';
  }
  return humanError(err);
}

/** 手机上能直接刷脸，电脑上不能——用指针精度判断，比屏幕宽度准 */
function onTouchDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

export function RealnameCard() {
  const [status, setStatus] = useState<RealnameStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 没登录（或 token 已失效）：这张卡整体换成登录引导，不报错 */
  const [unauthorized, setUnauthorized] = useState(false);
  const [maskedName, setMaskedName] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [idCard, setIdCard] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** init 拿到的 H5 认证页地址：电脑上要把它给用户拿手机打开 */
  const [certifyUrl, setCertifyUrl] = useState<string | null>(null);
  const [pollsLeft, setPollsLeft] = useState(POLL_LIMIT);
  /**
   * 待审状态下强行回到表单。
   * 认证页地址只在 init 的响应里给一次，刷新页面就没了；服务端又停在「待审」，
   * 没有这个开关用户就卡死在一个点不动的等待页上。后端允许重复发起（每次一条新流水），
   * 所以重来一遍是安全的。
   */
  const [restarting, setRestarting] = useState(false);
  /**
   * 走哪条通道。用户手动选过就听他的，否则**跟着服务端记的 method 走**。
   *
   * 【为什么不能简单地默认刷脸】护照审核没通过时，`auth_status` 回到未认证、
   * 页面落回表单——若此时默认刷脸，**一个拿护照的人会被送回他根本用不了的那条通道**，
   * 还会读到「身份证号要与本人证件完全一致、光线足一点再刷一次」这种他无法执行的建议。
   * 最需要正确指引的恰恰是刚被打回来的人。
   */
  const [channelChoice, setChannelChoice] = useState<'cloudauth' | 'passport' | null>(null);
  const channel: 'cloudauth' | 'passport' =
    channelChoice ?? (status?.method === 'passport' ? 'passport' : 'cloudauth');
  const setChannel = setChannelChoice;

  const refresh = useCallback(async () => {
    try {
      const body = await apiFetch<RealnameStatus>('/realname/status');
      setStatus(body);
      setLoadError(null);
      setUnauthorized(false);
    } catch (err) {
      if (err instanceof ApiError && err.errorCode === 'UNAUTHORIZED') {
        setUnauthorized(true);
        setStatus(null);
        setLoadError(null);
        return;
      }
      setLoadError(humanError(err));
    }
  }, []);

  useEffect(() => {
    setMaskedName(readMaskedName());
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const pending = status?.auth_status === AUTH_STATUS.pending;

  // 待审就自动轮；每轮完一次 pollsLeft 变一下，effect 再排下一次，到 0 停手。
  // 用户中途离开页面也没关系：回来重新挂载会先读一次 status，是待审就从头再轮。
  useEffect(() => {
    if (!pending || pollsLeft <= 0) return;
    const timer = setTimeout(() => {
      setPollsLeft((n) => n - 1);
      void refresh();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, pollsLeft, refresh]);

  const submit = async () => {
    setSubmitting(true);
    setFormError(null);
    try {
      const body = await apiFetch<RealnameInit>('/realname/init', {
        method: 'POST',
        body: { real_name: name.trim(), id_card: idCard.trim().toUpperCase() },
      });
      rememberMaskedName(maskName(name));
      setMaskedName(maskName(name));
      setCertifyUrl(body.certify_url);
      setPollsLeft(POLL_LIMIT);
      setRestarting(false);
      await refresh();
      if (body.certify_url && onTouchDevice()) window.location.href = body.certify_url;
    } catch (err) {
      setFormError(initFailureCopy(err));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * 还差哪几样。**「能不能点提交」与「还缺什么」由同一个数组算**——
   * 分开写两遍，迟早出现按钮亮着却说还缺、或按钮灰着说都齐了这种自相矛盾的状态。
   */
  const missing: string[] = [];
  if (name.trim().length === 0) missing.push('姓名');
  if (!isIdCard(idCard)) missing.push('身份证号');

  return (
    <Card>
      <span id={REALNAME_ANCHOR} className="block scroll-mt-20" />
      <CardHeader>
        <CardTitle>实名认证</CardTitle>
        <CardAction>
          {!unauthorized && <StatusBadge status={status?.auth_status} loading={loading} />}
        </CardAction>
      </CardHeader>
      <CardContent>
        {/* 这两段说明里有「存证证明」「证据固化出证」，进糊层 */}
        <p data-veil="" className="text-[14px] leading-6 text-ink-2">
          出具法律效力文件需要实名。实名信息仅用于存证证明与实人认证，不会出现在其他页面。
        </p>
        <p data-veil="" className="mt-1.5 text-[14px] leading-6 text-ink-2">
          不实名也能正常用其他功能，只有证据固化出证那一步会拦一下。
        </p>

        {loading && <Skeleton className="mt-4 h-24 w-full" />}

        {!loading && unauthorized && (
          <SignInHint>实人认证要绑到你自己的账号上，登录之后在这里做，几分钟就能完成。</SignInHint>
        )}

        {!loading && !unauthorized && loadError && (
          <p className="mt-4 text-[14px] leading-6 text-ink-2">
            实名状态这次没读到（{loadError}），稍后回来再看。
          </p>
        )}

        {!loading && !loadError && status && (
          <div className="mt-4 border-t border-line pt-4">
            {status.auth_status === AUTH_STATUS.verified ? (
              <Verified maskedName={maskedName} />
            ) : pending && !restarting ? (
              <Pending
                message={status.message}
                method={status.method ?? null}
                certifyUrl={certifyUrl}
                exhausted={pollsLeft <= 0}
                onRefresh={() => {
                  setPollsLeft(POLL_LIMIT);
                  void refresh();
                }}
                onRestart={() => setRestarting(true)}
              />
            ) : channel === 'passport' ? (
              <PassportForm
                rejectedMessage={
                  status.verification_status === '未通过' ? status.message : undefined
                }
                onSubmitted={() => {
                  setRestarting(false);
                  setPollsLeft(POLL_LIMIT);
                  void refresh();
                }}
                onCancel={() => setChannel('cloudauth')}
              />
            ) : (
              <IdCardForm
                name={name}
                idCard={idCard}
                rejectedMessage={
                  status.verification_status === '未通过' ? status.message : undefined
                }
                idCardError={
                  idCard.length >= 18 && !isIdCard(idCard)
                    ? '身份证号格式不对，再核一遍'
                    : undefined
                }
                formError={formError}
                submitting={submitting}
                missing={missing}
                onNameChange={setName}
                onIdCardChange={setIdCard}
                onSubmit={() => void submit()}
                onUsePassport={() => setChannel('passport')}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status, loading }: { status?: string; loading: boolean }) {
  if (loading) return null;
  if (status === AUTH_STATUS.verified) return <Badge tone="success">已实名</Badge>;
  if (status === AUTH_STATUS.pending) return <Badge tone="amber">待审</Badge>;
  return <Badge tone="neutral">未认证</Badge>;
}

function Verified({ maskedName }: { maskedName: string | null }) {
  return (
    <div>
      <p className="text-[15px] leading-7 text-ink">
        {maskedName ? (
          <>
            已完成实人认证：
            <Sensitive className="font-medium">{maskedName}</Sensitive>
            。出证时用的就是这个身份。
          </>
        ) : (
          '已完成实人认证。出证时用的就是你的实名身份。'
        )}
      </p>
      <p className="mt-1.5 text-[14px] leading-6 text-ink-2">
        姓名和证件号在我们这边是加密存的，其他页面不显示、也不会写进发给公司的任何文书。
      </p>
    </div>
  );
}

/** 导出仅为可测：待审文案按通道分支，是这次改动里最容易回归的一处 */
export function Pending({
  message,
  method,
  certifyUrl,
  exhausted,
  onRefresh,
  onRestart,
}: {
  message: string;
  method: 'cloudauth' | 'passport' | null;
  certifyUrl: string | null;
  exhausted: boolean;
  onRefresh: () => void;
  onRestart: () => void;
}) {
  /**
   * 护照是**人工审核**，没有刷脸链接、也不该显示「手机上做完之后…」那套话。
   * 沿用刷脸文案会让刚交完材料的人以为自己还漏了一步没做。
   */
  if (method === 'passport') {
    return (
      <div>
        <p className="text-[15px] leading-7 text-ink">材料已收到，正在人工审核。</p>
        <p className="mt-1.5 text-[14px] leading-6 text-ink-2">
          一般一到两个工作日出结果。这期间不影响你用其他功能，只有证据固化出证那一步会拦一下。
          审核完这里会更新，不用一直守着。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={onRefresh}>
            刷新审核结果
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="text-[15px] leading-7 text-ink">{message}</p>

      {certifyUrl && (
        <div className="mt-3">
          <p className="text-[14px] leading-6 text-ink-2">
            人脸核验要用手机摄像头。用手机打开下面这个链接，按提示刷脸就行；这一页留着不用关。
          </p>
          <div className="mt-2">
            <CodeBlock
              code={certifyUrl}
              wrap
              copyLabel="复制认证链接"
              copiedMessage="链接已复制，用手机打开"
            />
          </div>
          <div className="mt-2">
            <a href={certifyUrl} target="_blank" rel="noopener noreferrer">
              <Button size="sm" variant="secondary">
                在本机打开认证页
              </Button>
            </a>
          </div>
        </div>
      )}

      <div className="mt-3 border-t border-line pt-3">
        <p className="text-[14px] leading-6 text-ink-2">
          {exhausted
            ? '等了一会儿还没等到结果。手机上做完了就点一下刷新。'
            : '手机上做完之后，这里会自动更新，不用一直盯着。'}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={onRefresh}>
            刷新认证结果
          </Button>
          <Button size="sm" variant="ghost" onClick={onRestart}>
            重新填一次
          </Button>
        </div>
        {!certifyUrl && (
          <p className="mt-2 text-[13px] leading-5 text-ink-2">
            认证页的链接刷新后就取不回来了。手上没有链接就点「重新填一次」，会给你一个新的。
          </p>
        )}
      </div>
    </div>
  );
}
