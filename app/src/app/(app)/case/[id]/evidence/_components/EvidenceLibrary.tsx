'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EVIDENCE_CATEGORIES,
  mockAttestationNo,
  mockUploadEvidence,
  type UploadSource,
} from '@/app/_mock/intake-evidence';
import { formatBytes, formatDate } from '@/app/_ui/format';
import { humanError } from '@/app/_ui/api';
import { readToken, useSignedIn } from '@/app/_ui/auth';
import { useRealnameGate } from '@/app/_ui/realname';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonList } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { EvidenceBadge, OriginalMediumNotice } from '@/components/case/EvidenceBadge';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import type { EvidenceCategory } from '@/app/_mock/types';
import {
  attestEvidence,
  demoEvidenceViews,
  demoView,
  fetchEvidenceDetail,
  fetchEvidenceList,
  uploadEvidence,
  type EvidenceView,
  type UploadInput,
} from '../_data';
import { EvidenceChecklist } from './EvidenceChecklist';
import { EvidenceDetailSheet } from './EvidenceDetailSheet';
import { UploadBar } from './UploadBar';
import { UploadSheet, type PendingUpload } from './UploadSheet';

/** 上传中/失败的那一条。失败后原样留着，点重试直接重发同一个 File。 */
interface UploadJob {
  input: UploadInput;
  sizeBytes: number;
  ratio: number;
  error: string | null;
}

export function EvidenceLibrary({ caseId }: { caseId: string }) {
  const toast = useToast();
  const signedIn = useSignedIn();
  const { guard, dialog: realnameDialog } = useRealnameGate();

  // 只有 demo 这个假案件走演示数据。真实案件登录失效时给「重新登录」，
  // 绝不回落到演示证据——在真案件下摆一堆别人的材料，比空列表危险得多。
  const isDemo = caseId === 'demo';

  const [items, setItems] = useState<EvidenceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needSignIn, setNeedSignIn] = useState(false);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const [job, setJob] = useState<UploadJob | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [freezeTarget, setFreezeTarget] = useState<EvidenceView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setNeedSignIn(false);
    if (isDemo) {
      setItems(demoEvidenceViews());
      setLoading(false);
      return;
    }
    // 直接读 token 而不是用 signedIn：水合那一帧 hook 还可能是 null
    if (!readToken()) {
      setItems([]);
      setNeedSignIn(true);
      setLoading(false);
      return;
    }
    try {
      setItems(await fetchEvidenceList(caseId));
    } catch (err) {
      setLoadError(humanError(err));
    } finally {
      setLoading(false);
    }
  }, [caseId, isDemo]);

  // signedIn 变化也要重来：401 会就地清掉 token，这里跟着切到「重新登录」
  useEffect(() => {
    void load();
  }, [load, signedIn]);

  const open = openId ? (items.find((i) => i.id === openId) ?? null) : null;

  // 列表接口不带大小/哈希/存证订单，打开详情时才补齐这一条
  useEffect(() => {
    if (isDemo || !open || open.detailed) return;
    let cancelled = false;
    fetchEvidenceDetail(open.id)
      .then((fresh) => {
        if (!cancelled) setItems((prev) => prev.map((i) => (i.id === fresh.id ? fresh : i)));
      })
      .catch(() => {
        // 详情取不到不影响列表，Sheet 里该字段留空即可
      });
    return () => {
      cancelled = true;
    };
  }, [isDemo, open]);

  const groups = useMemo(() => {
    return EVIDENCE_CATEGORIES.map((category) => ({
      category,
      list: items.filter((i) => i.category === category),
    })).filter((g) => g.list.length > 0);
  }, [items]);

  const frozen = items.filter((i) => i.status !== '已上传').length;
  const issued = items.filter((i) => i.status === '已出证').length;

  const handlePick = (source: UploadSource, file: File) => {
    setPending({ source, file, name: file.name, sizeBytes: file.size });
  };

  const runUpload = useCallback(
    async (input: UploadInput, sizeBytes: number) => {
      setJob({ input, sizeBytes, ratio: 0, error: null });
      try {
        const created = await uploadEvidence(input, (ratio) =>
          setJob((prev) => (prev ? { ...prev, ratio } : prev)),
        );
        setItems((prev) => [created, ...prev]);
        setJob(null);
        toast('已存进证据库，还没固化', 'success', '已保存');
      } catch (err) {
        setJob((prev) => (prev ? { ...prev, error: humanError(err) } : prev));
      }
    },
    [toast],
  );

  const handleUpload = (input: {
    category: EvidenceCategory;
    provePurpose: string;
    originalMedium: string;
  }) => {
    if (!pending) return;
    const { file, name, sizeBytes } = pending;
    setPending(null);

    if (isDemo) {
      const item = mockUploadEvidence({ caseId, name, sizeBytes, ...input });
      setItems((prev) => [demoView(item), ...prev]);
      toast('已存进证据库，还没固化', 'success', '已保存');
      return;
    }
    void runUpload({ caseId, file, name, ...input }, sizeBytes);
  };

  /** 固化与出证是同一个幂等接口：中途失败再点一次从断的那一段续跑。 */
  const runAttest = async (target: EvidenceView) => {
    setFreezeTarget(null);
    if (isDemo) {
      setItems((prev) =>
        prev.map((i) =>
          i.id === target.id
            ? {
                ...i,
                status: '已出证',
                attestation: i.attestation ?? {
                  orderNo: mockAttestationNo(),
                  status: 'certified',
                  sha256: i.sha256 ?? '',
                  tsaGenTime: new Date().toISOString(),
                  tsaSerial: null,
                  certPdfFileId: 0,
                },
              }
            : i,
        ),
      );
      toast('已固化并出具《存证证明》', 'success', '已完成');
      return;
    }

    setBusyId(target.id);
    try {
      const attestation = await guard(() => attestEvidence(target.id));
      if (attestation === null) return; // 被实名拦截，弹窗已经接手
      const fresh = await fetchEvidenceDetail(target.id);
      setItems((prev) => prev.map((i) => (i.id === fresh.id ? fresh : i)));
      toast('已固化并出具《存证证明》', 'success', '已完成');
    } catch (err) {
      // 时间戳可能已经拿到、只是证明没出成：刷一次详情让状态跟上真实进度
      const fresh = await fetchEvidenceDetail(target.id).catch(() => null);
      if (fresh) setItems((prev) => prev.map((i) => (i.id === fresh.id ? fresh : i)));
      toast(humanError(err), 'amber', '这一步没成功');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4 pt-1">
      <div className="flex flex-col gap-1.5">
        <OriginalMediumNotice />
        <p className="px-3.5 text-[13px] leading-6 text-ink-2">
          公司要求交回原件时，先自己拍照或复印留一份再交。
        </p>
      </div>

      {!needSignIn && <UploadBar onPick={handlePick} />}

      {job && (
        <UploadProgress
          job={job}
          onRetry={() => void runUpload(job.input, job.sizeBytes)}
          onDismiss={() => setJob(null)}
        />
      )}

      {loading ? (
        <SkeletonList />
      ) : needSignIn ? (
        <div className="rounded-[12px] border border-line bg-surface p-5">
          <p className="text-[15px] leading-7 text-ink">登录状态已失效，材料没丢，重新验证一下手机号就能看到。</p>
          <Link
            href="/login"
            className="mt-3 inline-flex h-11 items-center justify-center rounded-[10px] bg-primary px-4 text-[15px] font-medium text-white transition-opacity duration-150 ease-out hover:opacity-90"
          >
            去登录
          </Link>
        </div>
      ) : loadError ? (
        <div className="rounded-[12px] border border-line bg-surface p-5">
          <p className="text-[15px] leading-7 text-ink">{loadError}</p>
          <p className="mt-1 text-[14px] leading-6 text-ink-2">
            已经上传的材料还在，只是这次没读出来。
          </p>
          <Button size="sm" className="mt-3" onClick={() => void load()}>
            重新加载
          </Button>
        </div>
      ) : items.length === 0 ? (
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
        busy={open !== null && busyId === open.id}
        editablePurpose={isDemo}
        certDownloadable={isDemo}
        onClose={() => setOpenId(null)}
        onRequestFreeze={setFreezeTarget}
        onIssue={(item) => void runAttest(item)}
        onSavePurpose={(id, provePurpose) => {
          setItems((prev) => prev.map((i) => (i.id === id ? { ...i, provePurpose } : i)));
          toast('说明已更新', 'success', '已保存');
        }}
        onDownload={(item) =>
          toast(
            `《存证证明》${item.attestation?.orderNo ?? ''} 已开始下载`,
            'success',
            '已开始下载',
          )
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
        onConfirm={() => freezeTarget && void runAttest(freezeTarget)}
        onCancel={() => setFreezeTarget(null)}
      />

      {realnameDialog}
    </div>
  );
}

/** 上传进度条；失败后停在原地，点重试重发同一个文件，不用再选一次。 */
function UploadProgress({
  job,
  onRetry,
  onDismiss,
}: {
  job: UploadJob;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const percent = Math.round(job.ratio * 100);

  return (
    <div className="rounded-[12px] border border-line bg-surface p-3.5">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">
          {job.input.name}
        </span>
        <span className="num shrink-0 text-[13px] text-ink-2">
          {formatBytes(job.sizeBytes)}
        </span>
      </div>

      {job.error ? (
        <>
          <p className="mt-1.5 text-[14px] leading-6 text-danger">{job.error}</p>
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" onClick={onRetry}>
              重试上传
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              取消
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="num mt-1.5 text-[13px] text-ink-2">正在上传 {percent}%</p>
        </>
      )}
    </div>
  );
}

function EvidenceRow({
  item,
  onOpen,
}: {
  item: EvidenceView;
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
        {item.sizeBytes === null ? '' : `${formatBytes(item.sizeBytes)} · `}
        {formatDate(item.createdAt)}
      </span>
    </button>
  );
}
