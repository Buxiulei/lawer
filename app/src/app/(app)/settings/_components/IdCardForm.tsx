'use client';

import { Button } from '@/components/shadcn/button';
import { InputField } from '@/components/shadcn/field';
import {
  FORM_ACTION_BUTTON,
  FORM_ACTIONS,
  FORM_BODY,
  FORM_FIELDS,
  missingHint,
} from './formLayout';

/**
 * 身份证（阿里云刷脸）通道的表单。**从 RealnameCard 里原样搬出来的**，
 * 逻辑（发起、轮询、脱敏姓名）仍在卡片里，这里只管排版与文案。
 *
 * 【为什么要单独成文件】两条通道原先一条在子组件、一条在卡片正文里写着，
 * 列宽/间距/按钮排布各写一遍——用户在两条通道之间切一下就看得出页面变了形，
 * 而这种走样 tsc 和测试都是绿的。搬出来之后两边共用 formLayout 那把尺，
 * 判据钉得住（realname-form-layout.test.tsx 两条通道各断言一遍）。
 *
 * 【这条通道没有照片上传格】刷脸是在阿里云的 H5 页上做的，我们这边只收姓名+身份证号。
 * 所以护照那两个上传格在这里没有对应物——**别为了"两边对称"给它凭空加上传格**。
 */
export function IdCardForm({
  name,
  idCard,
  rejectedMessage,
  idCardError,
  formError,
  submitting,
  missing,
  onNameChange,
  onIdCardChange,
  onSubmit,
  onUsePassport,
}: {
  name: string;
  idCard: string;
  /** 上一次刷脸没通过时后端给的原因 */
  rejectedMessage?: string;
  /** 身份证号形状不对（18 位那条正则）时的字段级错误 */
  idCardError?: string;
  /** 发起失败的整表错误 */
  formError?: string | null;
  submitting: boolean;
  /** 还差哪几样才能点提交，顺序与字段从上往下一致 */
  missing: string[];
  onNameChange: (value: string) => void;
  onIdCardChange: (value: string) => void;
  onSubmit: () => void;
  onUsePassport: () => void;
}) {
  const hint = missingHint(missing);
  const ready = missing.length === 0;

  return (
    <form
      className={FORM_BODY}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !submitting) onSubmit();
      }}
    >
      <div className="flex flex-col gap-3">
        {rejectedMessage && (
          <p className="rounded-[10px] bg-amber-wash px-3 py-2.5 text-[14px] leading-6 text-amber-ink">
            上一次没通过：{rejectedMessage}。姓名和身份证号要与本人证件完全一致，光线足一点再刷一次。
          </p>
        )}
        {/* 护照被打回的人不会走到这个分支（channel 跟着 method 走），
            这里留的是"他手动切回身份证通道"那种情形，不该再提护照 */}

        <p className="flex items-start gap-2 rounded-[10px] bg-surface-2 px-3 py-2.5 text-[14px] leading-6 text-ink-2">
          <InfoIcon />
          <span>
            下一步会跳到<span className="font-semibold text-ink">人脸核验页</span>
            ，需要用手机的摄像头完成；电脑上会给你一个链接，拿手机打开。
          </span>
        </p>
      </div>

      {/* 姓名与证件号是本人身份信息：低调模式下整块进糊层（输入时聚焦自动清晰） */}
      <div className={FORM_FIELDS}>
        <div data-veil="">
          <InputField
            label="姓名"
            hint="与身份证上一致"
            autoComplete="name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            maxLength={30}
          />
        </div>
        <div data-veil="">
          <InputField
            label="身份证号"
            hint="18 位，末位是 X 的直接输 X"
            inputMode="text"
            autoComplete="off"
            value={idCard}
            onChange={(e) => onIdCardChange(e.target.value)}
            maxLength={18}
            error={idCardError}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {formError && <p className="text-[14px] leading-6 text-ink-2">{formError}</p>}

        <div className={FORM_ACTIONS}>
          <Button type="submit" className={FORM_ACTION_BUTTON} disabled={!ready || submitting}>
            {submitting ? '正在发起…' : '开始实名认证'}
          </Button>
          {/* 这条通道只认大陆二代证。没有身份证的人必须能在这里找到出路，
              否则他会以为是自己填错了，反复试同一个走不通的入口 */}
          <Button
            type="button"
            variant="outline"
            className={FORM_ACTION_BUTTON}
            onClick={onUsePassport}
            disabled={submitting}
          >
            改用护照认证
          </Button>
          {hint && <span className="text-[13px] leading-5 text-ink-2">{hint}</span>}
        </div>

        <p className="text-[13px] leading-5 text-ink-2">
          没有中国大陆身份证就走护照通道：人工审核，一到两个工作日。
        </p>
      </div>
    </form>
  );
}

/**
 * 一枚信息角标。**不画手机**：手机在 16px 上就是一个瘦长方框，
 * 实机 1280 出图上和缺字的豆腐块分不出来（impl-shots 第一版实拍到的就是这个）。
 * 圆圈 + i 是这个尺寸下少数认得出的形状。
 */
function InfoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="mt-1 size-4 shrink-0 text-ink-2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <path d="M12 7.6v.9" />
    </svg>
  );
}
