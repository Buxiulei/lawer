'use client';

import { useState, type ReactNode } from 'react';
import { ApiError, apiFetch, humanError } from '@/app/_ui/api';
import { cn } from '@/app/_ui/cn';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { readRecheck, type Recheck, type RecheckCheck } from '../_verification';

/**
 * 在线核验：让本页从「列出记录」升级为「当场复核」。
 *
 * ⚠ 红线（DESIGN.md「API 对接约定」）：后端**验签不通过也返回 200**，
 * 裁决只认响应体的 overall_ok。这里绝不看 res.ok / 状态码，
 * 也绝不把「没有结论」画成通过——unknown 一律走中性态。
 *
 * 接口：POST /api/v1/verify/:orderNo/recheck，公开 + IP 限流（24h/IP 30 次）。
 * 回 { ok, order_no, overall_ok, checks: [{ name, passed, detail }], verdict }，
 * 分项交给 readRecheck 宽松解析——字段名将来变了也不会把结论丢掉。
 *
 * 打不到这条路由时（部署里还没有它）会落到 Next 的 404，响应体不是我们的错误包，
 * apiFetch 归一成 HTTP_xxx，此时提示改走页内的离线复核指引。
 */
export function RecheckPanel({ orderNo }: { orderNo: string }) {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Recheck | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setFailure(null);
    try {
      const body = await apiFetch<unknown>(
        `/verify/${encodeURIComponent(orderNo)}/recheck`,
        { method: 'POST', auth: false },
      );
      setResult(readRecheck(body));
    } catch (err) {
      setResult(null);
      // HTTP_xxx = 对方没按我们的错误包回话，最常见就是这条路由还不存在
      if (err instanceof ApiError && err.errorCode.startsWith('HTTP_')) {
        toast('在线核验暂未开放，可按下方指引离线复核', 'neutral');
      } else {
        const message = failureCopy(err) ?? humanError(err);
        setFailure(message);
        toast(message, 'amber', '这一步没成功');
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="mt-6">
      <div className="rounded-[12px] border border-line bg-surface p-4">
        <h3 className="text-[17px] font-semibold text-ink">在线核验</h3>
        <p className="prose-measure mt-1 text-[14px] leading-6 text-ink-2">
          让平台当场重算一遍哈希、验一遍时间戳令牌与签名，把结论摆在这里。
          不想依赖平台的结论，就按下方指引自己离线核。
        </p>
        <Button
          className="mt-3"
          size="sm"
          variant={result ? 'secondary' : 'primary'}
          disabled={running}
          onClick={() => void run()}
        >
          {running ? '正在核验…' : result ? '重新核验' : '在线核验'}
        </Button>
        {failure && !result && (
          <p className="mt-2 text-[14px] leading-6 text-ink-2">{failure}</p>
        )}
      </div>

      {result && <Verdict result={result} />}
    </section>
  );
}

/**
 * 后端 message 在这几个码上要么太技术（透传 sidecar 原话），要么在这页上说不通，就地换掉。
 *
 * ⚠ 措辞红线：RECHECK_UNAVAILABLE / RECHECK_UPSTREAM_FAILED 是**没验成**，不是没通过。
 * 文案必须把这件事挑明——把服务故障说得像证据有问题，等于在仲裁场上诬告用户自己的材料。
 */
function failureCopy(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  switch (err.errorCode) {
    case 'RATE_LIMITED':
      // 共用的 RATE_LIMITED，humanError 的通用文案是「发送太频繁」——这页没有"发送"这回事
      return err.retryAfter ? `核验太频繁，${err.retryAfter} 秒后再试` : '核验太频繁，稍后再试';
    case 'RECHECK_UNAVAILABLE':
      return '在线核验暂时用不了，是我们这边的复核服务还没就绪——这不代表这份材料有问题。稍后再试，或按下方指引自己离线核。';
    case 'RECHECK_UPSTREAM_FAILED':
      return '这次没核成：复核服务没响应，不是核验没通过。过一会儿再点一次，或按下方指引自己离线核。';
    case 'ORDER_NOT_FOUND':
      return '没找到这个存证订单号。核对一下单号，或找出具方要一份完整的《存证证明》。';
    default:
      return null;
  }
}

const VERDICT_STYLE: Record<
  Recheck['verdict'],
  { title: string; summary: string; card: string; checksTitle: string }
> = {
  pass: {
    title: '核验通过',
    summary:
      '平台重算的结果与存证记录一致：文件哈希对得上，时间戳令牌与签名有效。自时间戳记载的时刻起，文件内容没有被改动过。',
    card: 'border-success bg-success-wash',
    checksTitle: '核验明细',
  },
  fail: {
    title: '核验未通过',
    summary:
      '下面的环节没有通过，这份材料不能作为「与存证时一致」的凭据。请向出具方索取原始文件与时间戳令牌重新核对。',
    card: 'border-danger bg-danger-wash',
    checksTitle: '没通过的环节',
  },
  unknown: {
    title: '核验没有结论',
    summary:
      '这次核验没有给出明确结果。它既不表示文件有问题，也不表示文件没问题——请稍后重试，或按下方指引自己离线复核。',
    card: 'border-line bg-surface-2',
    checksTitle: '已取到的部分',
  },
};

function Verdict({ result }: { result: Recheck }) {
  const style = VERDICT_STYLE[result.verdict];
  const checks = orderChecks(result.checks, result.verdict);

  return (
    <>
      <div className={cn('mt-3 rounded-[12px] border p-4 sm:p-5', style.card)}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0">
            {result.verdict === 'pass' ? (
              <CheckIcon className="size-7 text-success" />
            ) : result.verdict === 'fail' ? (
              <CrossIcon className="size-7 text-danger" />
            ) : (
              <UnknownIcon className="size-7 text-ink-2" />
            )}
          </span>
          <div className="min-w-0">
            <h4 className="text-[19px] leading-8 font-semibold text-ink">{style.title}</h4>
            <p className="prose-measure mt-1 text-[15px] leading-7 text-ink-2">
              {style.summary}
            </p>
          </div>
        </div>
      </div>

      {checks.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[15px] font-semibold text-ink">{style.checksTitle}</h4>
          <ul className="mt-1">
            {checks.map((check, i) => (
              <li
                key={`${check.key}-${i}`}
                className="flex items-start gap-3 border-t border-line py-3"
              >
                <span className="mt-0.5 shrink-0">
                  {check.ok === true ? (
                    <CheckIcon className="size-5 text-success" />
                  ) : check.ok === false ? (
                    <CrossIcon className="size-5 text-danger" />
                  ) : (
                    <UnknownIcon className="size-5 text-ink-2" />
                  )}
                </span>
                <div className="min-w-0">
                  <p
                    className={cn(
                      'text-[15px] leading-6 font-medium',
                      check.ok === false ? 'text-danger-ink' : 'text-ink',
                    )}
                  >
                    {check.label}
                    {check.ok === null && (
                      <span className="ml-2 text-[13px] font-normal text-ink-2">
                        未取到结果
                      </span>
                    )}
                  </p>
                  {check.detail && (
                    <p className="mt-0.5 text-[14px] leading-6 text-ink-2">{check.detail}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** 未通过时把失败项排到最前：投影到仲裁庭上，第一眼看到的应该是问题所在。 */
function orderChecks(checks: RecheckCheck[], verdict: Recheck['verdict']): RecheckCheck[] {
  if (verdict !== 'fail') return checks;
  return [...checks].sort((a, b) => Number(a.ok !== false) - Number(b.ok !== false));
}

function Icon({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('shrink-0', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.4l2.7 2.6L16 9.5" />
    </Icon>
  );
}

function CrossIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </Icon>
  );
}

function UnknownIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 8.5h7" />
      <path d="M12 12v3.5" />
    </Icon>
  );
}
