import type { ReactNode } from 'react';
import type { VerifyBody, VerifyCheck, Verdict } from '@/app/_mock/authpay';
import { cn } from '@/app/_ui/cn';
import { formatDateTime } from '@/app/_ui/format';

interface VerdictStyle {
  title: string;
  summary: string;
  /** 明细区标题 */
  checksTitle: string;
  card: string;
  icon: ReactNode;
}

const VERDICT_STYLE: Record<Verdict, VerdictStyle> = {
  pass: {
    title: '验证通过',
    summary:
      '这份文件与存证时完全一致，可信时间戳有效、证书链可信。自下方记录的时间起，文件内容没有被改动过。',
    checksTitle: '核验明细',
    card: 'border-success bg-success-wash',
    icon: <CheckIcon className="size-8 text-success" />,
  },
  fail: {
    title: '验证未通过',
    summary:
      '以下环节没有通过，这份文件不能作为「与存证时一致」的凭据。请向出具方索取原始文件与时间戳令牌重新核对。',
    checksTitle: '没通过的环节',
    card: 'border-danger bg-danger-wash',
    icon: <CrossIcon className="size-8 text-danger" />,
  },
  unknown: {
    title: '无法验证',
    summary:
      '没有取到完整的验证结果，这次核验不成立。它既不表示文件有问题，也不表示文件没问题——请稍后重试，或凭存证编号向出具方索取原始时间戳令牌自行离线复核。',
    checksTitle: '已取到的部分',
    card: 'border-line bg-surface-2',
    icon: <UnknownIcon className="size-8 text-ink-2" />,
  },
};

export function VerifyResult({
  no,
  verdict,
  body,
}: {
  no: string;
  verdict: Verdict;
  body: Partial<VerifyBody>;
}) {
  const style = VERDICT_STYLE[verdict];
  const checks = orderChecks(body.checks ?? [], verdict);

  return (
    <>
      <section
        className={cn(
          'flex items-start gap-4 rounded-[12px] border p-5 sm:p-7',
          style.card,
        )}
      >
        <span className="mt-1 shrink-0">{style.icon}</span>
        <div className="min-w-0">
          <h2 className="text-[26px] leading-9 font-semibold text-ink sm:text-[32px] sm:leading-11">
            {style.title}
          </h2>
          <p className="prose-measure mt-2 text-[15px] leading-7 text-ink-2 sm:text-[16px]">
            {style.summary}
          </p>
        </div>
      </section>

      {checks.length > 0 && (
        <section className="mt-6">
          <h3 className="text-[17px] font-semibold text-ink">{style.checksTitle}</h3>
          <ul className="mt-2">
            {checks.map((check) => (
              <li
                key={check.key}
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
                      check.ok === false ? 'text-danger' : 'text-ink',
                    )}
                  >
                    {check.label}
                    {check.ok === null && (
                      <span className="ml-2 text-[13px] font-normal text-ink-2">未取到结果</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[14px] leading-6 text-ink-2">{check.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <h3 className="text-[17px] font-semibold text-ink">存证记录</h3>
        <dl className="mt-2">
          <Row label="存证编号" value={body.order_no ?? no} mono />
          <Row label="文件 SHA256" value={body.sha256} mono />
          <Row
            label="时间戳时间"
            value={body.tsa_gen_time ? formatDateTime(body.tsa_gen_time) : undefined}
            mono
          />
          <Row label="时间戳序列号" value={body.tsa_serial} mono />
          <Row label="时间戳服务" value={body.tsa_url} mono />
          <Row
            label="证书链"
            value={
              body.cert_chain_ok === undefined
                ? undefined
                : body.cert_chain_ok
                  ? '可信'
                  : '不可信'
            }
          />
          <Row label="实名快照" value={body.realname_snapshot} />
        </dl>
      </section>
    </>
  );
}

/** 未通过时把失败项排到最前，投影时第一眼看到的就是问题所在。 */
function orderChecks(checks: VerifyCheck[], verdict: Verdict): VerifyCheck[] {
  if (verdict !== 'fail') return checks;
  return [...checks].sort((a, b) => Number(a.ok !== false) - Number(b.ok !== false));
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-line py-3 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-[14px] leading-6 text-ink-2 sm:w-32">{label}</dt>
      <dd
        className={cn(
          'min-w-0 text-[14px] leading-6 break-all',
          mono && 'num font-mono',
          value ? 'text-ink' : 'text-ink-2',
        )}
      >
        {value ?? '未取到'}
      </dd>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
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
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.4l2.7 2.6L16 9.5" />
    </svg>
  );
}

function CrossIcon({ className }: { className?: string }) {
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
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  );
}

function UnknownIcon({ className }: { className?: string }) {
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
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 8.5h7" />
      <path d="M12 12v3.5" />
    </svg>
  );
}
