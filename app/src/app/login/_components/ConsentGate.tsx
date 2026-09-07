'use client';

import Link from 'next/link';
import {
  ADULT_CHECKBOX_LABEL,
  KEY_CLAUSE_NOTICES,
  OVERSEAS_CHECKBOX_HINT,
  OVERSEAS_CHECKBOX_LABEL,
  OVERSEAS_TERMS_HREF,
  OVERSEAS_TERMS_LINK_TEXT,
  TERMS_CHECKBOX_LABEL,
  TERMS_HREF,
  TERMS_LINK_TEXT,
} from '@/lib/consent';
import { Checkbox } from '@/components/shadcn/checkbox';

/**
 * 注册/登录页那两个勾选框，以及摆在它们旁边的三类重大条款提示（协议附一 #1、#2）。
 *
 * 【为什么是两个框而不是一个】它们是两件事：一件是对协议整体的同意（协议 一.3），
 * 另一件是关于**你是谁**的自述（协议 二.6：未满十八周岁不得注册或使用）。
 * 合成一个框的形态是——用户为了登录顺手勾了，而我们事后说不清他确认过的是哪一条。
 *
 * 【为什么三条提示摆在框上面、且要加粗】《民法典》第四百九十六条要求提供格式条款的一方
 * 「提示对方注意」并「按照对方的要求予以说明」。只给一条协议链接，等于把提示义务折算成
 * "用户会不会点进去"。三条各占一行、要点加粗，是这条义务在页面上的落点；
 * 文案本身收在 lib/consent.ts（登录页、设置页与将来的注册回执念的是同一份）。
 *
 * 【为什么单独成组件】LoginForm 自己的 state 在 SSR 判据里驱动不了（本仓库 vitest 跑
 * node 环境、没有 DOM，只能把组件当普通函数渲一次）。三条提示、两个框、协议链接
 * 各删一个，页面都照常能用、全套测试也照常绿——那正是合规文案最容易静默消失的形态。
 */
export function ConsentGate({
  terms,
  adult,
  overseas,
  onTermsChange,
  onAdultChange,
  onOverseasChange,
}: {
  terms: boolean;
  adult: boolean;
  /** 境外模型那一位。**可选项**：不勾照样注册，见 lib/consent.ts 那条常量的抬头 */
  overseas: boolean;
  onTermsChange: (next: boolean) => void;
  onAdultChange: (next: boolean) => void;
  onOverseasChange: (next: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] bg-surface-2 p-3.5">
      <ul className="flex flex-col gap-1.5">
        {KEY_CLAUSE_NOTICES.map((clause) => (
          <li key={clause.key} className="text-[13px] leading-5 text-ink-2">
            <span className="font-semibold text-ink">{clause.title}</span>
            <span>　</span>
            <strong className="font-semibold text-ink">{clause.emphasis}</strong>
            {clause.rest}
          </li>
        ))}
      </ul>

      {/* 点整条由浏览器转发给里面的 Checkbox（button 是 labelable 元素），
          这一层不要再挂 onClick，否则勾选状态会被切两次。 */}
      <label className="flex min-h-11 cursor-pointer items-start gap-3">
        <Checkbox
          checked={terms}
          onCheckedChange={(next) => onTermsChange(next === true)}
          className="mt-1"
          aria-label={`${TERMS_CHECKBOX_LABEL}${TERMS_LINK_TEXT}`}
        />
        <span className="text-[14px] leading-6 text-ink-2">
          {TERMS_CHECKBOX_LABEL}
          <Link
            href={TERMS_HREF}
            className="text-primary-ink underline underline-offset-4"
            // 协议要看得完整，不能把人从填了一半的登录表单里带走
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {TERMS_LINK_TEXT}
          </Link>
        </span>
      </label>

      <label className="flex min-h-11 cursor-pointer items-start gap-3">
        <Checkbox
          checked={adult}
          onCheckedChange={(next) => onAdultChange(next === true)}
          className="mt-1"
          aria-label={ADULT_CHECKBOX_LABEL}
        />
        <span className="text-[14px] leading-6 text-ink-2">{ADULT_CHECKBOX_LABEL}</span>
      </label>

      {/* 境外模型：**单独一项、默认未勾、不勾也能注册**（主理人 2026-09-07 口径）。
          与上面两个之间隔一条线，是为了让"这一个不一样"在页面上看得见——
          三个框长得一模一样地并排时，用户读到的是"要勾就都得勾"。 */}
      <label className="flex min-h-11 cursor-pointer items-start gap-3 border-t border-line pt-2.5">
        <Checkbox
          checked={overseas}
          onCheckedChange={(next) => onOverseasChange(next === true)}
          className="mt-1"
          aria-label={OVERSEAS_CHECKBOX_LABEL}
        />
        <span className="text-[14px] leading-6 text-ink-2">
          {OVERSEAS_CHECKBOX_LABEL}（
          <Link
            href={OVERSEAS_TERMS_HREF}
            className="text-primary-ink underline underline-offset-4"
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {OVERSEAS_TERMS_LINK_TEXT}
          </Link>
          ）
          <span className="mt-0.5 block text-[13px] leading-5">{OVERSEAS_CHECKBOX_HINT}</span>
        </span>
      </label>
    </div>
  );
}
