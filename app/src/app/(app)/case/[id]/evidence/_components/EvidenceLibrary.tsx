'use client';

import { useMemo, useState } from 'react';
import {
  EVIDENCE_CATEGORIES,
  mockAttestationNo,
  mockUploadEvidence,
  type UploadSource,
} from '@/app/_mock/intake-evidence';
import { demoEvidence } from '@/app/_mock/demo';
import { formatBytes, formatDate } from '@/app/_ui/format';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { EvidenceBadge, OriginalMediumNotice } from '@/components/case/EvidenceBadge';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import type { EvidenceCategory, EvidenceItem } from '@/app/_mock/types';
import { EvidenceChecklist } from './EvidenceChecklist';
import { EvidenceDetailSheet } from './EvidenceDetailSheet';
import { UploadBar } from './UploadBar';
import { UploadSheet, type PendingUpload } from './UploadSheet';

export function EvidenceLibrary({ caseId }: { caseId: string }) {
  const toast = useToast();
  const [items, setItems] = useState<EvidenceItem[]>(demoEvidence);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [freezeTarget, setFreezeTarget] = useState<EvidenceItem | null>(null);

  const open = openId ? (items.find((i) => i.id === openId) ?? null) : null;

  const groups = useMemo(() => {
    return EVIDENCE_CATEGORIES.map((category) => ({
      category,
      list: items.filter((i) => i.category === category),
    })).filter((g) => g.list.length > 0);
  }, [items]);

  const frozen = items.filter((i) => i.status !== '已上传').length;
  const issued = items.filter((i) => i.status === '已出证').length;

  const handlePick = (source: UploadSource, file: File) => {
    setPending({ source, name: file.name, sizeBytes: file.size });
  };

  const handleUpload = (input: {
    category: EvidenceCategory;
    provePurpose: string;
    originalMedium: string;
  }) => {
    if (!pending) return;
    const item = mockUploadEvidence({
      caseId,
      name: pending.name,
      sizeBytes: pending.sizeBytes,
      ...input,
    });
    setItems((prev) => [item, ...prev]);
    setPending(null);
    toast('已存进证据库，还没固化', 'success', '已保存');
  };

  const handleFreeze = (target: EvidenceItem) => {
    setItems((prev) =>
      prev.map((i) => (i.id === target.id ? { ...i, status: '已固化' } : i)),
    );
    setFreezeTarget(null);
    toast('已固化，内容和时间被锁定', 'success', '已完成');
  };

  const handleIssue = (target: EvidenceItem) => {
    setItems((prev) =>
      prev.map((i) =>
        i.id === target.id
          ? { ...i, status: '已出证', attestationNo: i.attestationNo ?? mockAttestationNo() }
          : i,
      ),
    );
    toast('《存证证明》已出具', 'success', '已完成');
  };

  const handleSavePurpose = (id: string, provePurpose: string) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, provePurpose } : i)));
    toast('说明已更新', 'success', '已保存');
  };

  return (
    <div className="flex flex-col gap-4 pt-1">
      <div className="flex flex-col gap-1.5">
        <OriginalMediumNotice />
        <p className="px-3.5 text-[13px] leading-6 text-ink-2">
          公司要求交回原件时，先自己拍照或复印留一份再交。
        </p>
      </div>

      <UploadBar onPick={handlePick} />

      {items.length === 0 ? (
        <div className="flex flex-col gap-5">
          <EmptyState
            title="证据库还是空的"
            description="从上面三个入口挑一个开始：手边有纸质文件就拍照，手机里有截图或流水就选文件，约谈录音直接传原始文件。"
          />
          <EvidenceChecklist />
        </div>
      ) : (
        <>
          <p className="num text-[14px] text-ink-2">
            共 {items.length} 份 · 已固化 {frozen} 份 · 已出证 {issued} 份
          </p>

          <div className="flex flex-col gap-5">
            {groups.map((g) => (
              <section key={g.category}>
                <h3 className="mb-2 flex items-baseline gap-2 text-[15px] font-semibold text-ink">
                  {g.category}
                  <span className="num text-[13px] font-normal text-ink-2">
                    {g.list.length}
                  </span>
                </h3>
                <ul className="flex flex-col gap-2">
                  {g.list.map((item) => (
                    <li key={item.id}>
                      <EvidenceRow item={item} onOpen={() => setOpenId(item.id)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <EvidenceChecklist collapsible />
        </>
      )}

      <UploadSheet
        pending={pending}
        onCancel={() => setPending(null)}
        onConfirm={handleUpload}
      />

      <EvidenceDetailSheet
        item={open}
        onClose={() => setOpenId(null)}
        onRequestFreeze={setFreezeTarget}
        onIssue={handleIssue}
        onSavePurpose={handleSavePurpose}
        onDownload={(item) =>
          toast(`《存证证明》${item.attestationNo} 已开始下载`, 'success', '已开始下载')
        }
      />

      <ConfirmDialog
        open={freezeTarget !== null}
        title="固化后这份证据不能再改"
        description={
          <>
            固化会算出文件的哈希值并申请可信时间戳，从此内容和时间都被锁死，
            <strong className="font-semibold text-ink">删不掉也换不了</strong>
            。传错文件的话，先取消，删掉重传再固化。
          </>
        }
        confirmLabel="确认固化，不再修改"
        cancelLabel="再检查一下"
        onConfirm={() => freezeTarget && handleFreeze(freezeTarget)}
        onCancel={() => setFreezeTarget(null)}
      />
    </div>
  );
}

function EvidenceRow({
  item,
  onOpen,
}: {
  item: EvidenceItem;
  onOpen: () => void;
}) {
  const { discreet } = useDiscreet();

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 rounded-[12px] border border-line bg-surface p-3.5 text-left transition-colors duration-150 ease-out hover:bg-surface-2"
    >
      <div className="flex items-start justify-between gap-3">
        {/* 文件名常带公司名和文件性质，低调模式下整行打码；点开详情再点按查看。 */}
        <span
          className={cn(
            'min-w-0 flex-1 text-[15px] leading-7 font-medium text-ink',
            discreet && 'discreet-blur',
          )}
        >
          {item.name}
        </span>
        <span className="shrink-0">
          <EvidenceBadge status={item.status} />
        </span>
      </div>
      {item.provePurpose && (
        <span className="text-[14px] leading-6 text-ink-2">{item.provePurpose}</span>
      )}
      <span className="num text-[13px] text-ink-2">
        {formatBytes(item.sizeBytes)} · {formatDate(item.createdAt)}
      </span>
    </button>
  );
}
