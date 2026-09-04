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
import { ApiError, humanError } from '@/app/_ui/api';
import { readToken, useSignedIn } from '@/app/_ui/auth';
import {
  isRealnameVerified,
  useRealnameGate,
  useRealnameStatus,
  REALNAME_PENDING,
  type RealnameGate,
} from '@/app/_ui/realname';
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
import {
  BatchCategorizeDialog,
  DropVeil,
  useFileDrop,
  type BatchAssignment,
} from '../../_components/DropPanel';
import { EvidenceChecklist } from './EvidenceChecklist';
import { EvidenceDetailSheet } from './EvidenceDetailSheet';
import { UploadBar } from './UploadBar';
import { UploadSheet, type PendingUpload } from './UploadSheet';

/**
 * 列表没读出来。**要连 error_code 一起留着**：
 * 「这个案件不存在」和「这次没读出来」对用户是两件事，能做的也不一样，
 * 只留一句翻译好的话就分不开了。
 */
export interface LoadFailure {
  code: string;
  message: string;
}

/**
 * catch 到的东西 → LoadFailure。**抽出来是为了让 error_code 那根线可测**：
 * 写在 catch 里的时候，把 `err.errorCode` 换成常量 `''` 整套测试照旧全绿——
 * 断的全是 loadFailureAdvice(code)，没有一条真的喂过一个 ApiError。
 * 那样 CASE_NOT_FOUND 会在这里被抹平成 ''，卡上照样说「已上传的材料还在」。
 *
 * 非 ApiError（网络断了、解析炸了）没有 error_code，落回 '' 走通用那一支。
 */
export function toLoadFailure(err: unknown): LoadFailure {
  return {
    code: err instanceof ApiError ? err.errorCode : '',
    message: humanError(err),
  };
}

/**
 * 加载失败那张卡的第二句：为什么会这样 + 现在能做什么。
 * CASE_NOT_FOUND 下**不许**出现「已上传的材料还在」——后端对"不是你的案件"也回这个码
 * （lib/cases/index.ts：不回 403，免得反过来确认案件号有效），
 * 那句话等于替一个用户根本没有的案件担保有材料。
 */
export function loadFailureAdvice(code: string): string {
  if (code === 'CASE_NOT_FOUND') {
    return '地址里的案件号可能抄漏了一位；如果这是别人转给你的链接，得用他那个账号登录才看得到。';
  }
  return '已经上传的材料还在，只是这次没读出来。';
}

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
        <span className="block max-w-[22rem] fs-s sm:line-clamp-2">
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
  const { status: rnStatus, loading: rnLoading } = useRealnameStatus();
  const { discreet } = useDiscreet();
  // 空状态标题与表格说明都不进糊层（一个是唯一的指路，一个是读屏用），低调下换中性词
  const libWord = discreet ? NEUTRAL_WORD.evidenceLib : '证据库';

  // 只有 demo 这个假案件走演示数据。真实案件登录失效时给「重新登录」，
  // 绝不回落到演示证据——在真案件下摆一堆别人的材料，比空列表危险得多。
  const isDemo = caseId === 'demo';

  // 实名闸（前移到上传，spec D1）：未实名的证据不落库、不落盘。真拦在服务端 requireRealname，
  // 这里只提前把入口收起来、给一张「去实名」的提示卡。
  //   · demo 走本地 mockUpload、不落真库，不卡；
  //   · 实名态还没取回来（rnLoading）时按放行处理——已实名用户零闪动，抢跑的那一下服务端兜底。
  const rnGate: RealnameGate = {
    blocked: !isDemo && !rnLoading && !isRealnameVerified(rnStatus),
    pending: !isDemo && !rnLoading && rnStatus === REALNAME_PENDING,
    discreet,
  };

  const [items, setItems] = useState<EvidenceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadFailure | null>(null);
  const [needSignIn, setNeedSignIn] = useState(false);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const [job, setJob] = useState<UploadJob | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [freezeTarget, setFreezeTarget] = useState<EvidenceView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 批B（桌面）：拖进来的一批文件 / 表格里勾中的那几行 / 批量固化的确认
  const [dropped, setDropped] = useState<File[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [batchFreeze, setBatchFreeze] = useState(false);

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
      setLoadError(toLoadFailure(err));
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

  /**
   * 拖进来的文件（批B，桌面）。
   * **一份走原来那张 Sheet**——单份材料本来就该逐字写清证明目的；
   * 多份才弹批量归类表，不弹 N 次 Sheet（设计 §四）。
   */
  const handleDropped = useCallback(
    (files: File[]) => {
      if (needSignIn) {
        toast('登录后才能往这个案件里存材料', 'amber', '需要先登录');
        return;
      }
      // 未实名：拖进来的一律不发请求、不开归类表——与 UploadBar 禁用入口同一道闸。
      if (rnGate.blocked) {
        toast(
          discreet ? '未实名的资料无法保存，先完成实名认证' : '未实名的证据无法保存，先完成实名认证',
          'amber',
          '需要先实名',
        );
        return;
      }
      if (files.length === 1) {
        const f = files[0];
        setPending({ source: 'file', file: f, name: f.name, sizeBytes: f.size });
        return;
      }
      setDropped(files);
    },
    [needSignIn, rnGate.blocked, discreet, toast],
  );

  const { dragging, handlers } = useFileDrop(handleDropped);

  /** 批量入库：逐个走与单份完全相同的那条路，不另开一个「批量接口」。 */
  const runBatch = async (assignments: BatchAssignment[], provePurpose: string) => {
    setDropped([]);
    for (const { file, category } of assignments) {
      const input = { category, provePurpose, originalMedium: '' };
      if (isDemo) {
        const item = mockUploadEvidence({
          caseId,
          name: file.name,
          sizeBytes: file.size,
          ...input,
        });
        setItems((prev) => [demoView(item), ...prev]);
      } else {
        await runUpload({ caseId, file, name: file.name, ...input }, file.size);
      }
    }
    toast(`${assignments.length} 份已存进证据库，还没固化`, 'success', '已保存');
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

  /** 批量固化：逐件走同一个幂等接口，中途失败的那几件再点一次从断处续跑 */
  const runBatchAttest = async () => {
    setBatchFreeze(false);
    const targets = items.filter((i) => selected.has(i.id) && i.status !== '已出证');
    for (const t of targets) await runAttest(t);
    setSelected(new Set());
  };

  return (
    // relative 只为给拖拽遮罩当定位参照：flex 流里加 position 不改任何盒子的位置。
    // 靶区就是这一块，遮罩画到哪儿、能松手的就到哪儿——不画整个视口去骗人。
    <div className="relative flex flex-col gap-4 pt-1" {...handlers}>
      <DropVeil show={dragging} />
      <OriginalMediumNotice />

      {/* 列表没读出来时也把上传入口收起来：案件根本不存在的话，上传必然失败；
          就算只是这次没读出来，传进去的东西也会落在一个用户看不见的列表里。 */}
      {!needSignIn && !loadError && <UploadBar onPick={handlePick} realname={rnGate} />}

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
          <AlertTitle data-veil="">{loadError.message}</AlertTitle>
          <AlertDescription data-veil="" className="mt-1">
            {loadFailureAdvice(loadError.code)}
          </AlertDescription>
          {/* 案件不存在时不给「重新加载」：同一个案件号再读一次还是不存在，
              按钮只会让人反复点。那一支的出路写在上面那句话里。 */}
          {loadError.code !== 'CASE_NOT_FOUND' && (
            <Button size="sm" className="mt-3" onClick={() => void load()}>
              重新加载
            </Button>
          )}
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
          <p data-veil="" className="num fs-s text-ink-2">
            共 {items.length} 份 · 已固化 {frozen} 份 · 已出证 {issued} 份
          </p>

          {/* 批量条（批B，桌面）：只跟表格那副面孔一起出现，卡片面孔没有多选 */}
          {selected.size > 0 && (
            <div className="hidden items-center gap-3 rounded-[10px] border border-primary bg-primary-wash px-3.5 py-2.5 sm:flex">
              <span className="num fs-s font-medium text-ink">已选 {selected.size} 件</span>
              <Button size="sm" onClick={() => setBatchFreeze(true)}>
                批量固化
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                取消选择
              </Button>
            </div>
          )}

          {/* ≥sm 一张平表，类别在表里是一列 */}
          <DataTable
            faces="table"
            caption={libWord}
            columns={COLUMNS}
            rows={items}
            rowKey={(item) => item.id}
            rowLabel={(item) => item.name}
            selected={selected}
            onSelectedChange={setSelected}
            onRowClick={(item) => setOpenId(item.id)}
          />

          {/* <sm 仍按类别分节，节标题带条数 */}
          <div className="flex flex-col gap-5 sm:hidden">
            {groups.map((g) => (
              <section key={g.category}>
                <h3
                  data-veil=""
                  className="mb-2 flex items-baseline gap-2 fs-m font-semibold text-ink"
                >
                  {g.category}
                  <span className="num fs-xs font-normal text-ink-2">
                    {g.list.length}
                  </span>
                </h3>
                <DataTable
                  faces="cards"
                  cardStyle="row"
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
        realname={rnGate}
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
        confirmLabel={discreet ? `确认${NEUTRAL_WORD.freeze}` : '确认固化'}
        cancelLabel="再检查一下"
        onConfirm={() => freezeTarget && void runAttest(freezeTarget)}
        onCancel={() => setFreezeTarget(null)}
      />

      <BatchCategorizeDialog
        files={dropped}
        onCancel={() => setDropped([])}
        onConfirm={(assignments, provePurpose) => void runBatch(assignments, provePurpose)}
      />

      <ConfirmDialog
        open={batchFreeze}
        title={
          discreet
            ? `${NEUTRAL_WORD.freeze}这 ${selected.size} 份后不能再改`
            : `固化这 ${selected.size} 份后不能再改`
        }
        description={
          <div data-veil="">
            会逐份算哈希、申请可信时间戳，
            <strong className="font-semibold text-ink">删不掉也换不了</strong>
            。已经出过证的那几份会跳过，不会重复扣费。
          </div>
        }
        confirmLabel={discreet ? `确认${NEUTRAL_WORD.freeze}` : '确认固化'}
        cancelLabel="再检查一下"
        onConfirm={() => void runBatchAttest()}
        onCancel={() => setBatchFreeze(false)}
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
          className="min-w-0 flex-1 truncate fs-m font-medium text-ink"
        >
          {job.input.name}
        </span>
        <span className="num shrink-0 fs-xs text-ink-2">
          {formatBytes(job.sizeBytes)}
        </span>
      </div>

      {job.error ? (
        <>
          <p className="mt-1.5 fs-s text-danger-ink">{job.error}</p>
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
          <p className="num mt-1.5 fs-xs text-ink-2">正在上传 {percent}%</p>
        </>
      )}
    </Card>
  );
}
