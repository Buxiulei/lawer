'use client';

import Link from 'next/link';
import { OVERSEAS_TERMS_HREF, type OverseasConsentCopy } from '@/lib/consent';

/**
 * 开启境外模型前那一屏说明（协议 五.5（2）/ 附一 #6）。
 *
 * 【本票交付的是这个组件与它背后的闸，不是那页文案】说明的正本是 /terms/overseas，
 * 由 C3 那一票交付；本组件把四件事按同一套结构摆出来，并指向那一页。
 * 合入之后只需把 `copy` 换成从那一页取的同一份数据，组件与闸都不用动。
 *
 * 【为什么它是纯展示组件（没有确认按钮）】"同意"这个动作要与开关的那次写入
 * 同一次请求（POST /api/v1/me/preferences 带 consent:true），按钮属于开关那一侧；
 * 本组件只负责"用户在点之前读到了什么"。两者分开，判据才能各盯各的：
 * 这里盯四件事一件都不能少，那里盯没同意就打不开。
 */
export function OverseasConsent({
  copy,
  href = OVERSEAS_TERMS_HREF,
}: {
  /** 四件事的文案（接收方 / 目的与方式 / 信息种类 / 脱敏与权利）。见 lib/consent.ts */
  copy: OverseasConsentCopy;
  /** 说明正本页地址；缺省 /terms/overseas */
  href?: string;
}) {
  return (
    <div className="flex flex-col gap-2 text-[14px] leading-6 text-ink-2">
      <Row label="接收方">{copy.recipient}</Row>
      <Row label="处理目的与方式">{copy.purpose}</Row>
      <Row label="会发出去的信息">{copy.categories.join('、')}</Row>
      <Row label="脱敏">{copy.redaction}</Row>
      <Row label="你的权利">{copy.rights}</Row>
      <p>
        完整说明见
        <Link
          href={href}
          target="_blank"
          rel="noreferrer"
          className="mx-1 text-primary-ink underline underline-offset-4"
        >
          境外接收方说明
        </Link>
        。不开启也不缺功能：关着时全部走境内模型。
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p>
      <span className="font-semibold text-ink">{label}　</span>
      {children}
    </p>
  );
}
