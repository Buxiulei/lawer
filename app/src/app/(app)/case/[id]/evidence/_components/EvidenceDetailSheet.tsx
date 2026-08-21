'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatBytes, formatDateTime } from '@/app/_ui/format';
import { AppSheet } from '@/components/shadcn/app-sheet';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { TextareaField } from '@/components/shadcn/field';
import { useToast } from '@/components/ui/Toast';
import { EvidenceBadge } from '@/components/case/EvidenceBadge';
import { Sensitive } from '@/components/Sensitive';
import type { EvidenceStatus } from '@/app/_mock/types';
import type { EvidenceView } from '../_data';

const STATUS_EXPLAIN: Record<EvidenceStatus, string> = {
  已上传: '文件已经加密存好了，还没有固化。固化之后内容和时间才会被锁死，公司质疑时才好复核。',
  已固化: '内容哈希和可信时间戳已经记下来了，这份材料从此不能再改。下一步是出具《存证证明》，开庭时随证据一起提交。',
  已出证: '《存证证明》已经生成，上面有存证编号、哈希值和时间戳。对方可以拿编号到验证页自己复核。',
};

/** 哈希太长，卡片里给个头尾缩写；完整值在下面单独一块，可整串复制。 */
function shortHash(sha256: string): string {
  return sha256.length <= 20 ? sha256 : `${sha256.slice(0, 10)}…${sha256.slice(-10)}`;
}

export function EvidenceDetailSheet({
  item,
  busy = false,
  editablePurpose = true,
  certDownloadable = true,
  onClose,
  onRequestFreeze,
  onIssue,
  onSavePurpose,
  onDownload,
}: {
  item: EvidenceView | null;
  /** 固化/出证正在跑：按钮转成等待态，避免重复发起 */
  busy?: boolean;
  /** 真接口暂无「改证明目的」的端点，只有演示数据能改 */
  editablePurpose?: boolean;
  /** 真接口暂无《存证证明》下载端点 */
  certDownloadable?: boolean;
  onClose: () => void;
  onRequestFreeze: (item: EvidenceView) => void;
  onIssue: (item: EvidenceView) => void;
  onSavePurpose: (id: string, purpose: string) => void;
  onDownload: (item: EvidenceView) => void;
}) {
  const toast = useToast();
  const [purpose, setPurpose] = useState('');

  useEffect(() => {
    setPurpose(item?.provePurpose ?? '');
  }, [item]);

  const dirty = item !== null && purpose !== item.provePurpose;
  const att = item?.attestation ?? null;

  return (
    <AppSheet
      open={item !== null}
      onClose={onClose}
      title="证据详情"
      footer={
        item && (
          <div className="flex flex-col gap-2.5">
            {item.status === '已上传' && (
              <Button className="w-full" disabled={busy} onClick={() => onRequestFreeze(item)}>
                {busy ? '正在固化…' : '固化这份证据'}
              </Button>
            )}
            {item.status === '已固化' && (
              <Button className="w-full" disabled={busy} onClick={() => onIssue(item)}>
                {busy ? '正在出具…' : '出具《存证证明》'}
              </Button>
            )}
            <Button
              variant={item.status === '已出证' && certDownloadable ? 'primary' : 'secondary'}
              className="w-full"
              disabled={item.status !== '已出证' || !certDownloadable}
              onClick={() => onDownload(item)}
            >
              下载《存证证明》
            </Button>
            {item.status !== '已出证' ? (
              <p className="text-[13px] leading-5 text-ink-2">
                《存证证明》要先固化、再出证才能下载。
              </p>
            ) : (
              !certDownloadable && (
                <p className="text-[13px] leading-5 text-ink-2">
                  证明文件已经生成好了，下载入口还在接。现在先把下面的验证链接给对方，
                  编号和时间戳一样可以当场核。
                </p>
              )
            )}
          </div>
        )
      }
    >
      {item && (
        <div className="flex flex-col gap-5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <EvidenceBadge status={item.status} />
              <Badge>{item.category}</Badge>
            </div>
            <Sensitive as="div" className="mt-2 text-[16px] leading-7 font-semibold text-ink">
              {item.name}
            </Sensitive>
          </div>

          <p className="rounded-[10px] bg-surface-2 px-3.5 py-3 text-[14px] leading-6 text-ink-2">
            {STATUS_EXPLAIN[item.status]}
          </p>

          <div className="flex flex-col gap-2">
            <TextareaField
              label="这份材料想证明什么"
              rows={3}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              // 只读而不是 disabled：disabled 会把已填的内容压成灰色，读起来像占位符
              readOnly={!editablePurpose}
              placeholder="一句话写明证明目的，仲裁的证据目录里要逐条填。"
              hint={
                editablePurpose
                  ? '固化之后文件本身不能改，但这一栏随时可以改。'
                  : '这一栏的修改入口还在接，现在填的内容以上传时填的为准。'
              }
            />
            {editablePurpose && dirty && (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => onSavePurpose(item.id, purpose)}>
                  保存这句说明
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPurpose(item.provePurpose)}
                >
                  撤销
                </Button>
              </div>
            )}
          </div>

          <dl className="flex flex-col divide-y divide-line text-[15px]">
            <Row label="原始载体" value={item.originalMedium || '未填写'} />
            <Row
              label="大小"
              value={item.sizeBytes === null ? '读取中…' : formatBytes(item.sizeBytes)}
              numeric
            />
            <Row label="入库时间" value={formatDateTime(item.createdAt)} numeric />
          </dl>

          {att && (
            <Card className="bg-secondary p-3.5">
              <h3 className="text-[15px] font-semibold text-ink">存证订单</h3>
              <dl className="mt-2 flex flex-col divide-y divide-line text-[15px]">
                <Row label="存证编号" value={att.orderNo} numeric />
                <Row
                  label="时间戳时间"
                  value={att.tsaGenTime ? formatDateTime(att.tsaGenTime) : '还没盖上'}
                  numeric
                />
                <Row label="文件摘要" value={shortHash(att.sha256)} numeric />
              </dl>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Link
                  href={`/verify/${encodeURIComponent(att.orderNo)}`}
                  className="inline-flex min-h-11 items-center text-[15px] text-primary-ink underline underline-offset-4"
                >
                  打开验证链接
                </Link>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    const url = `${window.location.origin}/verify/${encodeURIComponent(att.orderNo)}`;
                    try {
                      await navigator.clipboard.writeText(url);
                      toast('验证链接已复制，可以直接发给对方', 'success', '已复制');
                    } catch {
                      toast('这个浏览器不给复制，长按链接手动复制一下', 'amber', '没能复制');
                    }
                  }}
                >
                  复制验证链接
                </Button>
              </div>
              <p className="mt-2 text-[13px] leading-6 text-ink-2">
                {att.tsaGenTime
                  ? '任何人打开这个链接都能核一遍哈希和时间戳，不用注册。'
                  : '时间戳还没盖上，这个链接现在只显示「存证处理中」，还不能给对方当凭据。'}
              </p>
            </Card>
          )}

          {item.sha256 && (
            <div>
              <p className="text-[13px] text-ink-2">SHA-256 哈希值</p>
              <p className="num mt-1 break-all rounded-[10px] bg-surface-2 px-3 py-2 text-[13px] leading-6 text-ink-2">
                {item.sha256}
              </p>
            </div>
          )}
        </div>
      )}
    </AppSheet>
  );
}

function Row({
  label,
  value,
  numeric = false,
}: {
  label: string;
  value: string;
  numeric?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5 first:pt-0">
      <dt className="shrink-0 text-[14px] text-ink-2">{label}</dt>
      <dd className={`min-w-0 text-right text-ink ${numeric ? 'num' : ''}`}>{value}</dd>
    </div>
  );
}
