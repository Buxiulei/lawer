'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch, humanError } from '@/app/_ui/api';
import { REALNAME_ANCHOR } from '@/app/_ui/realname';
import { Sensitive } from '@/components/Sensitive';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/shadcn/button';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/shadcn/card';
import { InputField } from '@/components/shadcn/field';
import { Skeleton } from '@/components/ui/Skeleton';
import { CodeBlock } from './CodeBlock';

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

  const refresh = useCallback(async () => {
    try {
      const body = await apiFetch<RealnameStatus>('/realname/status');
      setStatus(body);
      setLoadError(null);
    } catch (err) {
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

  const canSubmit = name.trim().length > 0 && isIdCard(idCard) && !submitting;

  return (
    <Card>
      <span id={REALNAME_ANCHOR} className="block scroll-mt-20" />
      <CardHeader>
        <CardTitle>实名认证</CardTitle>
        <CardAction>
          <StatusBadge status={status?.auth_status} loading={loading} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="text-[14px] leading-6 text-ink-2">
          出具法律效力文件需要实名。实名信息仅用于存证证明与实人认证，不会出现在其他页面。
        </p>
        <p className="mt-1.5 text-[14px] leading-6 text-ink-2">
          不实名也能正常用其他功能，只有证据固化出证那一步会拦一下。
        </p>

        {loading && <Skeleton className="mt-4 h-24 w-full" />}

        {!loading && loadError && (
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
                certifyUrl={certifyUrl}
                exhausted={pollsLeft <= 0}
                onRefresh={() => {
                  setPollsLeft(POLL_LIMIT);
                  void refresh();
                }}
                onRestart={() => setRestarting(true)}
              />
            ) : (
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canSubmit) void submit();
                }}
              >
                {status.verification_status === '未通过' && (
                  <p className="rounded-[10px] bg-amber-wash px-3 py-2.5 text-[14px] leading-6 text-amber-ink">
                    上一次没通过：{status.message}。姓名和身份证号要与本人证件完全一致，光线足一点再刷一次。
                  </p>
                )}

                <InputField
                  label="姓名"
                  hint="与身份证上一致"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={30}
                />
                <InputField
                  label="身份证号"
                  hint="18 位，末位是 X 的直接输 X"
                  inputMode="text"
                  autoComplete="off"
                  value={idCard}
                  onChange={(e) => setIdCard(e.target.value)}
                  maxLength={18}
                  error={idCard.length >= 18 && !isIdCard(idCard) ? '身份证号格式不对，再核一遍' : undefined}
                />

                {formError && (
                  <p className="text-[14px] leading-6 text-ink-2">{formError}</p>
                )}

                <div>
                  <Button type="submit" disabled={!canSubmit}>
                    {submitting ? '正在发起…' : '开始实名认证'}
                  </Button>
                  <p className="mt-2 text-[13px] leading-5 text-ink-2">
                    下一步会跳到人脸核验页，需要用手机的摄像头完成。
                  </p>
                </div>
              </form>
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

function Pending({
  message,
  certifyUrl,
  exhausted,
  onRefresh,
  onRestart,
}: {
  message: string;
  certifyUrl: string | null;
  exhausted: boolean;
  onRefresh: () => void;
  onRestart: () => void;
}) {
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
