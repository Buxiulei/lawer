'use client';

import { useEffect, useState } from 'react';
import {
  EVIDENCE_CATEGORIES,
  UPLOAD_DEFAULT_CATEGORY,
  UPLOAD_DEFAULT_MEDIUM,
  type UploadSource,
} from '@/app/_mock/intake-evidence';
import { useDiscreet } from '@/app/_ui/discreet';
import { formatBytes } from '@/app/_ui/format';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { AppSheet } from '@/components/shadcn/app-sheet';
import { Button } from '@/components/shadcn/button';
import { InputField, TextareaField } from '@/components/shadcn/field';
import type { EvidenceCategory } from '@/app/_mock/types';
import { CategoryPicker } from './CategoryPicker';

export interface PendingUpload {
  source: UploadSource;
  /** 原始 File 一路带到上传那一刻：失败重试时不用让用户再选一次 */
  file: File;
  name: string;
  sizeBytes: number;
}

/**
 * 选完文件先补两件事：归到哪一类、想证明什么。
 * 这两栏在仲裁提交证据目录时要逐条填，现在花十秒，开庭前少熬一夜。
 */
export function UploadSheet({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingUpload | null;
  onCancel: () => void;
  onConfirm: (input: {
    category: EvidenceCategory;
    provePurpose: string;
    originalMedium: string;
  }) => void;
}) {
  const { discreet } = useDiscreet();
  const [category, setCategory] = useState<EvidenceCategory>('其他');
  const [provePurpose, setProvePurpose] = useState('');
  const [originalMedium, setOriginalMedium] = useState('');

  useEffect(() => {
    if (!pending) return;
    setCategory(UPLOAD_DEFAULT_CATEGORY[pending.source]);
    setOriginalMedium(UPLOAD_DEFAULT_MEDIUM[pending.source]);
    setProvePurpose('');
  }, [pending]);

  return (
    <AppSheet
      open={pending !== null}
      onClose={onCancel}
      title="补两句说明再入库"
      footer={
        <div className="flex gap-2.5">
          <Button variant="secondary" onClick={onCancel} className="min-w-24">
            取消
          </Button>
          <Button
            className="w-full"
            onClick={() => onConfirm({ category, provePurpose, originalMedium })}
          >
            存进{discreet ? NEUTRAL_WORD.evidenceLib : '证据库'}
          </Button>
        </div>
      }
    >
      {pending && (
        <div className="flex flex-col gap-5">
          <div data-veil="" className="rounded-[10px] bg-surface-2 px-3.5 py-3">
            <p className="truncate fs-m font-medium text-ink">{pending.name}</p>
            <p className="num mt-0.5 fs-xs text-ink-2">
              {formatBytes(pending.sizeBytes)}
            </p>
          </div>

          <div data-veil="" className="flex flex-col gap-2">
            <p className="fs-s font-medium text-ink">归到哪一类</p>
            <CategoryPicker
              categories={EVIDENCE_CATEGORIES}
              value={category}
              onChange={setCategory}
            />
          </div>

          {/* placeholder 里带着「解除」「公司」：整块进糊层，聚焦时 data-veil-focus 会让它清晰 */}
          <div data-veil="">
            <TextareaField
              label="这份材料想证明什么"
              rows={3}
              value={provePurpose}
              onChange={(e) => setProvePurpose(e.target.value)}
              placeholder="例如：证明公司单方解除的时间、理由与补偿标准。"
              hint="一句话就够。现在想不出来可以留空，之后在详情里补。"
            />
          </div>

          <InputField
            label="原始载体在哪"
            value={originalMedium}
            onChange={(e) => setOriginalMedium(e.target.value)}
            placeholder="例如：纸质原件，本人保管"
            hint="记下来是为了将来公司质疑真实性时，你知道去哪儿取原件。"
          />
        </div>
      )}
    </AppSheet>
  );
}
