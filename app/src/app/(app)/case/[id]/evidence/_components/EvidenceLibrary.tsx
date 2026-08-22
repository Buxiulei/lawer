'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EVIDENCE_CATEGORIES,
  mockAttestationNo,
  mockUploadEvidence,
  type UploadSource,
} from '@/app/_mock/intake-evidence';
import { useDiscreet } from '@/app/_ui/discreet';
import { formatBytes, formatDate } from '@/app/_ui/format';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { humanError } from '@/app/_ui/api';
import { readToken, useSignedIn } from '@/app/_ui/auth';
import { useRealnameGate } from '@/app/_ui/realname';
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/alert';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/shadcn/data-table';
import { EmptyState } from '@/components/shadcn/empty-state';
import { Progress } from '@/components/shadcn/progress';
import { SkeletonList } from '@/components/shadcn/skeleton';
import { useToast } from '@/components/ui/Toast';
import { EvidenceBadge, OriginalMediumNotice } from '@/components/case/EvidenceBadge';
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

/**
 * ≥sm 的表格列。<sm 走同一份定义降级成卡片：
 * 名称当标题、状态当徽标、证明目的当副行、大小与时间连成脚注，
 * 类别在卡片上不显示——那边按类别分了节，节标题已经说过一遍。
 */
const COLUMNS: DataTableColumn<EvidenceView>[] = [
  {
    key: 'name',
    header: '名称',
    // 文件名常带公司名和文件性质，低调模式下整格打码；点开详情再看。
    sensitive: true,
    card: 'title',
    // 列宽靠内层 span 的 max-w 卡住：表格是 auto 布局，光给 td 加 max-w 不生效
    cell: (item) => (
      <span className="block max-w-[18rem] truncate font-medium">{item.name}</span>
    ),
  },
  {
    key: 'category',
    header: '类别',
    card: 'hide',
    cell: (item) => <Badge>{item.category}</Badge>,
  },
  {
    key: 'purpose',
    header: '证明目的',
    card: 'meta',
    // 证明目的几乎必然写着金额和公司名（「证明离职前 12 个月平均工资为 25000 元」），
    // 低调模式下和文件名一样整格打码
    sensitive: true,
    className: 'text-muted-foreground',
    // 表格里夹到两行，全文在详情 Sheet 里；卡片那边不夹，窄屏本来就是竖着读
    cell: (item) =>
      item.provePurpose ? (
        <span className="block max-w-[22rem] text-[14px] leading-6 sm:line-clamp-2">
          {item.provePurpose}
        </span>
      ) : (
        ''
      ),
  },
  {
    key: 'status',
    header: '状态',
    card: 'badge',
    cell: (item) => <EvidenceBadge status={item.status} />,
  },
  {
    key: 'size',
    header: '大小',
    numeric: true,
    card: 'footnote',
    cell: (item) => (item.sizeBytes === null ? '' : formatBytes(item.sizeBytes)),
  },
  {
    key: 'createdAt',
    header: '入库时间',
    numeric: true,
    card: 'footnote',
    cell: (item) => formatDate(item.createdAt),
  },
];

export function EvidenceLibrary({ caseId }: { caseId: string }) {
  const toast = useToast();
  const signedIn = useSignedIn();
  const { guard, dialog: realnameDialog } = useRealnameGate();
  const { discreet } = useDiscreet();
  // 空状态标题与表格说明都不进糊层（一个是唯一的指路，一个是读屏用），低调下换中性词
  const libWord = discreet ? NEUTRAL_WORD.evidenceLib : '证据库';

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
        <p data-veil="" className="px-3.5 text-[13px] leading-6 text-ink-2">
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
        <Alert>
          {/* needSignIn 只在本机压根没有 token 时置起，说"失效"会让从没登录过的人以为自己弄坏了什么 */}
          {/* 糊在标题上而不是整块 Alert：下面的「去登录」得看得见才点得动 */}
          <AlertTitle data-veil="">登录后才能看到这个案件里的材料。</AlertTitle>
          <Button size="sm" className="mt-3" asChild>
            <Link href="/login">去登录</Link>
          </Button>
        </Alert>
      ) : loadError ? (
        <Alert>
          <AlertTitle data-veil="">{loadError}</AlertTitle>
          <AlertDescription data-veil="" className="mt-1">
            已经上传的材料还在，只是这次没读出来。
          </AlertDescription>
          <Button size="sm" className="mt-3" onClick={() => void load()}>
            重新加载
          </Button>
        </Alert>
      ) : items.length === 0 ? (
        <div className="flex flex-col gap-5">
          {/* 空态是指路的，糊掉就没人知道从哪下手，所以走换词不进糊层。
              低调下只摘掉「流水」「约谈」两个词，句子结构和指路照旧。
              description 是 string，塞不进 data-veil，也只能这么办。 */}
          <EmptyState
            title={`${libWord}还是空的`}
            description={
              discreet
                ? '从上面三个入口挑一个开始：手边有纸质文件就拍照，手机里有截图就选文件，录音直接传原始文件。'
                : '从上面三个入口挑一个开始：手边有纸质文件就拍照，手机里有截图或流水就选文件，约谈录音直接传原始文件。'
            }
          />
          <EvidenceChecklist />
        </div>
      ) : (
        <>
          <p data-veil="" className="num text-[14px] text-ink-2">
            共 {items.length} 份 · 已固化 {frozen} 份 · 已出证 {issued} 份
          </p>

          {/* ≥sm 一张平表，类别在表里是一列 */}
          <DataTable
            faces="table"
            caption={libWord}
            columns={COLUMNS}
            rows={items}
            rowKey={(item) => item.id}
            onRowClick={(item) => setOpenId(item.id)}
          />

          {/* <sm 仍按类别分节，节标题带条数 */}
          <div className="flex flex-col gap-5 sm:hidden">
            {groups.map((g) => (
              <section key={g.category}>
                <h3
                  data-veil=""
                  className="mb-2 flex items-baseline gap-2 text-[15px] font-semibold text-ink"
                >
                  {g.category}
                  <span className="num text-[13px] font-normal text-ink-2">
                    {g.list.length}
                  </span>
                </h3>
                <DataTable
                  faces="cards"
                  columns={COLUMNS}
                  rows={g.list}
                  rowKey={(item) => item.id}
                  onRowClick={(item) => setOpenId(item.id)}
                />
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
        // title 是 string，挂不上 data-veil，只能换词
        title={
          discreet
            ? `${NEUTRAL_WORD.freeze}后这份${NEUTRAL_WORD.evidence}不能再改`
            : '固化后这份证据不能再改'
        }
        description={
          // 糊层挂在描述自己身上：弹窗根容器是 fixed，filter 会把它拽进自己的坐标系
          <div data-veil="">
            固化会算出文件的哈希值并申请可信时间戳，从此内容和时间都被锁死，
            <strong className="font-semibold text-ink">删不掉也换不了</strong>
            。传错文件的话，先取消，删掉重传再固化。
          </div>
        }
        confirmLabel={discreet ? `确认${NEUTRAL_WORD.freeze}，不再修改` : '确认固化，不再修改'}
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
    <Card className="p-3.5">
      <div className="flex items-start justify-between gap-3">
        <span
          data-veil=""
          className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink"
        >
          {job.input.name}
        </span>
        <span className="num shrink-0 text-[13px] text-ink-2">
          {formatBytes(job.sizeBytes)}
        </span>
      </div>

      {job.error ? (
        <>
          <p className="mt-1.5 text-[14px] leading-6 text-danger-ink">{job.error}</p>
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
          <Progress className="mt-2" value={percent} label="上传进度" />
          <p className="num mt-1.5 text-[13px] text-ink-2">正在上传 {percent}%</p>
        </>
      )}
    </Card>
  );
}
