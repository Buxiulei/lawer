'use client';

import {
  REALNAME_ADOPT_DETAIL,
  REALNAME_ADOPT_LABEL,
  REALNAME_CONSENT_DETAIL,
  REALNAME_CONSENT_LABEL,
} from '@/lib/consent';
import { Button } from '@/components/shadcn/button';
import { Checkbox } from '@/components/shadcn/checkbox';

/**
 * 收证件号前的那一次单独同意（协议 五.2（1）/ 附一 #4）。
 *
 * 【为什么是勾选框而不是一句说明】"我们会加密存"这种话写在页面上只是告知；
 * 单独同意要的是**用户对这件事本身做过一个动作**。所以它是一个默认不勾、
 * 不勾就点不动提交的框——服务端那一侧同样拦（realnameConsentFailure），
 * 页面这一层只是让人在点之前先读到。
 *
 * 【为什么摆在两条通道之上】身份证与护照两条路收的都是证件信息，说明是同一段。
 * 摆进各自的表单里就要写两遍，而两遍中的一遍迟早会在改版里少一句。
 */
export function RealnameCollectConsent({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[10px] bg-surface-2 p-3.5">
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        className="mt-1"
        aria-label={REALNAME_CONSENT_LABEL}
      />
      <span className="text-[14px] leading-6 text-ink-2">
        <span className="font-semibold text-ink">{REALNAME_CONSENT_LABEL}</span>
        <br />
        {REALNAME_CONSENT_DETAIL}
      </span>
    </label>
  );
}

/**
 * 采用 NBDpsy 那侧实名结果前的说明与同意（协议 三.3 / 附一 #3）。
 *
 * 【为什么这一格无条件显示，不去问对面"他到底认没认"】问一次要把手机号发给对方，
 * 而**在他同意之前，我们不该为了装修一个按钮去做那次查询**。这一格说的是
 * "如果你在那边认过，可以这样省一步"——认没认过用户自己知道。
 * 点了同意之后，闸门那一侧才会去问、问到了才采用（lib/auth/guard.ts realnameGate）。
 *
 * 【已经同意过就换成一句陈述】按钮留在那儿会让人以为没生效而反复点。
 */
export function NbdpsyAdoptConsent({
  granted,
  busy,
  error,
  onGrant,
}: {
  /** 台账里已经有这一条了 */
  granted: boolean;
  busy: boolean;
  error?: string | null;
  onGrant: () => void;
}) {
  return (
    <div className="rounded-[10px] bg-surface-2 p-3.5">
      <p className="text-[14px] leading-6 text-ink-2">
        <span className="font-semibold text-ink">在 NBDpsy 实名过？</span>
        <br />
        {REALNAME_ADOPT_DETAIL}
      </p>
      {granted ? (
        <p className="mt-2 text-[13px] leading-5 text-ink-2">
          你已同意采用。下次用到需要实名的功能时，我们会去取一次那份结果；
          取不到就还是按未实名处理，你可以在上面直接认证。
        </p>
      ) : (
        <div className="mt-2.5 flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onGrant}
            className="self-start"
          >
            {busy ? '正在记录…' : REALNAME_ADOPT_LABEL}
          </Button>
          {error && <p className="text-[13px] leading-5 text-ink-2">{error}</p>}
        </div>
      )}
    </div>
  );
}
