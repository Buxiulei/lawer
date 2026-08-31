import type { ReactNode } from 'react';
import { Badge } from '@/components/shadcn/badge';
import { Card } from '@/components/shadcn/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/shadcn/collapsible';
import { Table, TableBody, TableCell, TableHead, TableRow } from '@/components/shadcn/table';
import { cn } from '@/app/_ui/cn';
import { formatBytes, formatDateTime } from '@/app/_ui/format';
import {
  statusLabel,
  type VerifyView,
  type Verification,
} from '../_verification';
import { CopyField } from './CopyField';
import { RecheckPanel } from './RecheckPanel';

/**
 * 公开验证页的主体。三态之间**只有措辞和信息量的差别，没有"通过"这一态**——
 * 本接口不做密码学复核（见 _verification.ts 顶部红线），页面就不许说复核过了。
 */
export function VerifyResult({ no, view }: { no: string; view: VerifyView }) {
  const { state, verification } = view;

  if (state === 'unavailable') {
    return (
      <>
        <Banner
          tone="neutral"
          icon={<UnknownIcon className="size-8 text-ink-2" />}
          title="无法验证"
          summary="没有查到这个存证编号，或者这次查询没成功。它既不表示文件有问题，也不表示文件没问题——请核对编号是否完整，或凭编号向出具方索取原始文件与时间戳令牌自行离线复核。"
        />
        <section className="mt-6">
          <h3 className="text-[17px] font-semibold text-ink">你查的编号</h3>
          <Table className="mt-2">
            <TableBody>
              <Row label="存证编号" value={no} mono />
            </TableBody>
          </Table>
        </section>
      </>
    );
  }

  const v = verification!;

  if (state === 'pending') {
    return (
      <>
        <Banner
          tone="neutral"
          icon={<PendingIcon className="size-8 text-ink-2" />}
          title="存证处理中"
          summary="这个编号的存证订单已经建立，但可信时间戳还没有盖上。在时间戳出来之前，本页不能作为核验凭据——它还不能证明文件在某个时刻已经存在。"
        />
        <RecordSection v={v} />
      </>
    );
  }

  return (
    <>
      <Banner
        tone="primary"
        icon={<RecordIcon className="size-8 text-primary-ink-on-surface" />}
        title="存证记录"
        summary="下面是这个编号在平台留存的存证记录。记录一致性由 RFC 3161 可信时间戳令牌保证：时间戳证明该摘要在下述时刻已经存在。本页只如实列出记录本身，不代替你自己的复核——按页尾的指引可以离线核一遍。"
      />
      {/* 在线核验只在盖过时间戳的记录上出现：没有令牌就没什么可验的 */}
      <RecheckPanel orderNo={v.order_no} />
      <RecordSection v={v} />
      <OfflineGuide v={v} />
    </>
  );
}

/** 存证记录卡：文件信息 + 摘要 + 时间戳 */
function RecordSection({ v }: { v: Verification }) {
  return (
    <>
      <section className="mt-6">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[17px] font-semibold text-ink">记录明细</h3>
          <Badge tone={v.status === 'certified' ? 'primary' : v.status === 'stamped' ? 'success' : 'neutral'}>
            {statusLabel(v.status)}
          </Badge>
        </div>

        <Table className="mt-2">
          <TableBody>
            <Row label="存证编号" value={v.order_no} mono />
            <Row label="建单时间" value={v.created_at ? formatDateTime(v.created_at) : undefined} mono />
            {v.evidence ? (
              <>
                <Row label="文件名" value={v.evidence.name} />
                <Row label="类别" value={v.evidence.category} />
                <Row label="文件大小" value={formatBytes(v.evidence.file_size)} mono />
                <Row label="文件类型" value={v.evidence.mime ?? undefined} mono />
              </>
            ) : (
              <Row label="文件" value={undefined} />
            )}
          </TableBody>
        </Table>

        <CopyField label="文件 SHA-256" value={v.sha256} className="mt-4" />
      </section>

      <section className="mt-6">
        <h3 className="text-[17px] font-semibold text-ink">可信时间戳</h3>
        <Table className="mt-2">
          <TableBody>
            <Row
              label="时间戳时间"
              value={v.timestamp.gen_time ? formatDateTime(v.timestamp.gen_time) : undefined}
              mono
            />
            <Row label="时间戳序列号" value={v.timestamp.serial ?? undefined} mono />
            <Row label="时间戳服务" value={v.timestamp.tsa_url ?? undefined} mono />
          </TableBody>
        </Table>
      </section>
    </>
  );
}

/** 离线复核指引：spec §8「可离线复核」落到具体几步，不假手于本页 */
function OfflineGuide({ v }: { v: Verification }) {
  return (
    <Collapsible asChild>
      <Card className="mt-6">
        <CollapsibleTrigger className="flex min-h-12 cursor-pointer items-center px-4 text-left text-[15px] font-medium text-primary-ink">
          怎么自己离线核一遍
        </CollapsibleTrigger>
        <CollapsibleContent className="px-4 pb-4">
          <p className="prose-measure text-[14px] leading-6 text-ink-2">
            不必相信本页。拿到持证人给你的原始文件后，按下面两步自己算，
            结论和本页无关、和平台也无关。
          </p>
          <ol className="mt-3 flex flex-col gap-3">
            <Step n={1} title="核对文件摘要">
              对原始文件算一次 SHA-256，和上面「文件 SHA-256」逐位比对。
              命令行下：<Code>sha256sum 文件名</Code>（macOS 用{' '}
              <Code>shasum -a 256 文件名</Code>）。对不上，说明文件和存证时的那一份不是同一个。
            </Step>
            <Step n={2} title="验时间戳令牌">
              向持证人索取该订单的 RFC 3161 时间戳令牌（.tsr），用 OpenSSL 验签并读出签发时间：
              <Code block>openssl ts -verify -digest {v.sha256} -in 存证.tsr -CAfile 时间戳根证书.pem</Code>
              验签通过即证明：这个摘要在令牌记载的时刻之前就已经存在。
            </Step>
          </ol>
          <p className="prose-measure mt-3 text-[14px] leading-6 text-ink-2">
            持证人手里的《存证证明》PDF 上另有实名快照与签名。本页不展示持证人身份——
            本页无需登录，谁拿到编号都能打开，不该顺带把个人信息给出去。
          </p>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function Banner({
  tone,
  icon,
  title,
  summary,
}: {
  tone: 'neutral' | 'primary';
  icon: ReactNode;
  title: string;
  summary: string;
}) {
  return (
    <Card
      className={cn(
        'flex-row items-start gap-4 p-5 shadow-none sm:p-7',
        tone === 'primary' ? 'border-primary bg-primary-wash' : 'border-transparent bg-surface-2',
      )}
    >
      <span className="mt-1 shrink-0">{icon}</span>
      <div className="min-w-0">
        <h2 className="text-[26px] leading-9 font-semibold text-ink sm:text-[32px] sm:leading-11">
          {title}
        </h2>
        <p className="prose-measure mt-2 text-[15px] leading-7 text-ink-2 sm:text-[16px]">
          {summary}
        </p>
      </div>
    </Card>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="num mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-wash text-[13px] font-semibold text-primary-ink">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-[15px] leading-6 font-medium text-ink">{title}</p>
        <p className="prose-measure mt-1 text-[14px] leading-6 text-ink-2">{children}</p>
      </div>
    </li>
  );
}

function Code({ children, block }: { children: ReactNode; block?: boolean }) {
  return (
    <code
      className={cn(
        'num rounded-[6px] bg-surface-2 font-mono text-[13px] text-ink',
        block ? 'mt-1.5 block overflow-x-auto px-3 py-2 whitespace-pre' : 'px-1.5 py-0.5',
      )}
    >
      {children}
    </code>
  );
}

/**
 * 记录明细的一行。标签用 th scope="row"：读屏器逐格念的时候能带上「文件名：」，
 * 投影到仲裁庭上时也是一张对得齐的表。
 */
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
    <TableRow>
      <TableHead scope="row" className="w-28 align-top whitespace-normal sm:w-32">
        {label}
      </TableHead>
      <TableCell
        className={cn(
          'align-top text-[14px] leading-6 break-all',
          mono && 'num font-mono',
          !value && 'text-ink-2',
        )}
      >
        {value ?? '未取到'}
      </TableCell>
    </TableRow>
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

function PendingIcon({ className }: { className?: string }) {
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
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

function RecordIcon({ className }: { className?: string }) {
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
      <path d="M7 3.5h7l4 4v13H7z" />
      <path d="M14 3.5v4h4" />
      <path d="M9.8 13.2l1.9 1.9 3.2-3.6" />
    </svg>
  );
}
