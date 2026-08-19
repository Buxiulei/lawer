'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatBytes, formatDateTime } from '@/app/_ui/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { EvidenceBadge } from '@/components/case/EvidenceBadge';
import { Sensitive } from '@/components/Sensitive';
import type { EvidenceItem } from '@/app/_mock/types';

const STATUS_EXPLAIN: Record<EvidenceItem['status'], string> = {
  已上传: '文件已经加密存好了，还没有固化。固化之后内容和时间才会被锁死，公司质疑时才好复核。',
  已固化: '内容哈希和可信时间戳已经记下来了，这份材料从此不能再改。下一步是出具《存证证明》，开庭时随证据一起提交。',
  已出证: '《存证证明》已经生成，上面有存证编号、哈希值和时间戳。对方可以拿编号到验证页自己复核。',
};

export function EvidenceDetailSheet({
  item,
  onClose,
  onRequestFreeze,
  onIssue,
  onSavePurpose,
  onDownload,
}: {
  item: EvidenceItem | null;
  onClose: () => void;
  onRequestFreeze: (item: EvidenceItem) => void;
  onIssue: (item: EvidenceItem) => void;
  onSavePurpose: (id: string, purpose: string) => void;
  onDownload: (item: EvidenceItem) => void;
}) {
  const [purpose, setPurpose] = useState('');

  useEffect(() => {
    setPurpose(item?.provePurpose ?? '');
  }, [item]);

  const dirty = item !== null && purpose !== item.provePurpose;

  return (
    <Sheet
      open={item !== null}
      onClose={onClose}
      title="证据详情"
      footer={
        item && (
          <div className="flex flex-col gap-2.5">
            {item.status === '已上传' && (
              <Button fullWidth onClick={() => onRequestFreeze(item)}>
                固化这份证据
              </Button>
            )}
            {item.status === '已固化' && (
              <Button fullWidth onClick={() => onIssue(item)}>
                出具《存证证明》
              </Button>
            )}
            <Button
              variant={item.status === '已出证' ? 'primary' : 'secondary'}
              fullWidth
              disabled={item.status !== '已出证'}
              onClick={() => onDownload(item)}
            >
              下载《存证证明》
            </Button>
            {item.status !== '已出证' && (
              <p className="text-[13px] leading-5 text-ink-2">
                《存证证明》要先固化、再出证才能下载。
              </p>
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
            <Textarea
              label="这份材料想证明什么"
              rows={3}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="一句话写明证明目的，仲裁的证据目录里要逐条填。"
              hint="固化之后文件本身不能改，但这一栏随时可以改。"
            />
            {dirty && (
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
            <Row label="大小" value={formatBytes(item.sizeBytes)} numeric />
            <Row label="入库时间" value={formatDateTime(item.createdAt)} numeric />
            {item.attestationNo && <Row label="存证编号" value={item.attestationNo} numeric />}
          </dl>

          <div>
            <p className="text-[13px] text-ink-2">SHA-256 哈希值</p>
            <p className="num mt-1 break-all rounded-[10px] bg-surface-2 px-3 py-2 text-[13px] leading-6 text-ink-2">
              {item.sha256}
            </p>
          </div>

          {item.attestationNo && (
            <Link
              href={`/verify/${item.attestationNo}`}
              className="flex min-h-11 items-center text-[15px] text-primary-ink underline underline-offset-4"
            >
              打开验证页，自己复核一遍哈希和时间戳
            </Link>
          )}
        </div>
      )}
    </Sheet>
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
