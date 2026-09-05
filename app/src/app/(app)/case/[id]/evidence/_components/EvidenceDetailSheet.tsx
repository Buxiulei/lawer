'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useDiscreet } from '@/app/_ui/discreet';
import { formatBytes, formatDateTime } from '@/app/_ui/format';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { AppSheet } from '@/components/shadcn/app-sheet';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { TextareaField } from '@/components/shadcn/field';
import { useToast } from '@/components/ui/Toast';
import { EvidenceBadge } from '@/components/case/EvidenceBadge';
import { Sensitive } from '@/components/Sensitive';
import type { EvidenceStatus } from '@/app/_mock/types';
import type { EvidenceView, ExtractMode, ExtractionInfo } from '../_data';

const STATUS_EXPLAIN: Record<EvidenceStatus, string> = {
  已上传: '文件已经加密存好了，还没有固化。固化之后内容和时间才会被锁死，公司质疑时才好复核。',
  已固化: '内容哈希和可信时间戳已经记下来了，这份材料从此不能再改。下一步是出具《存证证明》，开庭时随证据一起提交。',
  已出证: '《存证证明》已经生成，上面有存证编号、哈希值和时间戳。对方可以拿编号到验证页自己复核。',
};

/**
 * 提取状态的人话。**排队中与处理中分开说**：合成一句「处理中」会让排在别人后面的人
 * 以为自己的已经在跑了，然后为"怎么这么慢"再点一次。
 */
const EXTRACT_STATE: Record<string, string> = {
  none: '还没提取过里面的内容',
  queued: '已排队，正在等前面的任务',
  running: '正在提取，完成后这里会出现文字',
  done: '内容已经提取出来了',
  failed: '上次提取没成功，可以重新发起',
};

/** 按文件类型猜默认的提取方式。猜不准不要紧——下面的选择器让人自己改。 */
function suggestMode(mime: string | null, name: string): ExtractMode {
  const m = mime ?? '';
  if (m.startsWith('audio/')) return 'asr';
  if (m.startsWith('video/')) return 'video';
  if (/\.(mp3|wav|m4a|aac|amr)$/i.test(name)) return 'asr';
  if (/\.(mp4|mov|mkv|avi)$/i.test(name)) return 'video';
  return 'ocr';
}

const MODE_LABEL: Record<ExtractMode, string> = {
  ocr: '图片 / PDF 认字',
  asr: '录音转文字（分说话人）',
  video: '视频（音轨 + 画面）',
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
  extractBusy = false,
  onClose,
  onRequestFreeze,
  onIssue,
  onSavePurpose,
  onDownload,
  onRequestExtract,
}: {
  item: EvidenceView | null;
  /** 固化/出证正在跑：按钮转成等待态，避免重复发起 */
  busy?: boolean;
  /** 真接口暂无「改证明目的」的端点，只有演示数据能改 */
  editablePurpose?: boolean;
  /** 真接口暂无《存证证明》下载端点 */
  certDownloadable?: boolean;
  /** 正在问价：按钮转等待态，避免重复问 */
  extractBusy?: boolean;
  onClose: () => void;
  onRequestFreeze: (item: EvidenceView) => void;
  onIssue: (item: EvidenceView) => void;
  onSavePurpose: (id: string, purpose: string) => void;
  onDownload: (item: EvidenceView) => void;
  /** 点「提取」：先问价，报价弹窗由上层的 ConfirmDialog 接手（不传 = 不显示提取区，demo 用） */
  onRequestExtract?: (item: EvidenceView, mode: ExtractMode) => void;
}) {
  const toast = useToast();
  const { discreet } = useDiscreet();
  const [purpose, setPurpose] = useState('');
  const [mode, setMode] = useState<ExtractMode>('ocr');
  const [showText, setShowText] = useState(false);

  useEffect(() => {
    setPurpose(item?.provePurpose ?? '');
    setShowText(false);
    if (item) setMode(suggestMode(item.extraction?.mime ?? null, item.name));
  }, [item]);

  const dirty = item !== null && purpose !== item.provePurpose;
  const att = item?.attestation ?? null;

  return (
    <AppSheet
      open={item !== null}
      onClose={onClose}
      title={`${discreet ? NEUTRAL_WORD.evidence : '证据'}详情`}
      footer={
        item && (
          <div className="flex flex-col gap-2.5">
            {/* 三个主操作必须看得懂才能点，不能进糊层：低调模式下只换字 */}
            {item.status === '已上传' && (
              <Button className="w-full" disabled={busy} onClick={() => onRequestFreeze(item)}>
                {discreet
                  ? busy
                    ? `正在${NEUTRAL_WORD.freeze}…`
                    : `${NEUTRAL_WORD.freeze}这份${NEUTRAL_WORD.evidence}`
                  : busy
                    ? '正在固化…'
                    : '固化这份证据'}
              </Button>
            )}
            {item.status === '已固化' && (
              <Button className="w-full" disabled={busy} onClick={() => onIssue(item)}>
                {discreet
                  ? busy
                    ? '正在生成…'
                    : `生成${NEUTRAL_WORD.cert}`
                  : busy
                    ? '正在出具…'
                    : '出具《存证证明》'}
              </Button>
            )}
            <Button
              variant={item.status === '已出证' && certDownloadable ? 'primary' : 'secondary'}
              className="w-full"
              disabled={item.status !== '已出证' || !certDownloadable}
              onClick={() => onDownload(item)}
            >
              {discreet ? `下载${NEUTRAL_WORD.cert}` : '下载《存证证明》'}
            </Button>
            {item.status !== '已出证' ? (
              <p data-veil="" className="fs-xs text-ink-2">
                《存证证明》要先固化、再出证才能下载。
              </p>
            ) : (
              !certDownloadable && (
                <p data-veil="" className="fs-xs text-ink-2">
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
          <div data-veil="">
            <div className="flex flex-wrap items-center gap-2">
              <EvidenceBadge status={item.status} />
              <Badge>{item.category}</Badge>
            </div>
            <Sensitive as="div" className="mt-2 fs-m font-semibold text-ink">
              {item.name}
            </Sensitive>
          </div>

          <p
            data-veil=""
            className="rounded-[10px] bg-surface-2 px-3.5 py-3 fs-s text-ink-2"
          >
            {STATUS_EXPLAIN[item.status]}
          </p>

          <div data-veil="" className="flex flex-col gap-2">
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

          <dl data-veil="" className="flex flex-col divide-y divide-line fs-m">
            <Row label="原始载体" value={item.originalMedium || '未填写'} />
            <Row
              label="大小"
              value={item.sizeBytes === null ? '读取中…' : formatBytes(item.sizeBytes)}
              numeric
            />
            <Row label="入库时间" value={formatDateTime(item.createdAt)} numeric />
          </dl>

          {att && (
            <Card data-veil="" className="bg-secondary p-3.5">
              <h3 className="fs-m font-semibold text-ink">存证订单</h3>
              <dl className="mt-2 flex flex-col divide-y divide-line fs-m">
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
                  className="inline-flex min-h-11 items-center fs-m text-primary-ink underline underline-offset-4"
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
              <p className="mt-2 fs-xs text-ink-2">
                {att.tsaGenTime
                  ? '任何人打开这个链接都能核一遍哈希和时间戳，不用注册。'
                  : '时间戳还没盖上，这个链接现在只显示「存证处理中」，还不能给对方当凭据。'}
              </p>
            </Card>
          )}

          {onRequestExtract && (
            <ExtractionPanel
              item={item}
              mode={mode}
              onModeChange={setMode}
              busy={extractBusy}
              showText={showText}
              onToggleText={() => setShowText((v) => !v)}
              onRequestExtract={onRequestExtract}
            />
          )}

          {item.sha256 && (
            <div data-veil="">
              <p className="fs-xs text-ink-2">SHA-256 哈希值</p>
              <p className="num mt-1 break-all rounded-[10px] bg-surface-2 px-3 py-2 fs-xs text-ink-2">
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
      <dt className="shrink-0 fs-s text-ink-2">{label}</dt>
      <dd className={`min-w-0 text-right text-ink ${numeric ? 'num' : ''}`}>{value}</dd>
    </div>
  );
}

/**
 * 内容提取与简报。三件事一屏：现在是什么状态、简报说了什么、原文长什么样。
 *
 * 【为什么原文默认折叠、简报默认展开】简报是"这份材料能干什么"的结论，是人来这一屏要的答案；
 * 原文是核对用的，几千字铺开会把结论挤出屏幕。
 *
 * 【为什么按钮上不写价】价随材料大小浮动，写死一个数就会与真正扣的数不一致。
 * 点下去先问价（免费），价在确认弹窗里逐项列出来，确认才扣。
 */
function ExtractionPanel({
  item,
  mode,
  busy,
  showText,
  onModeChange,
  onToggleText,
  onRequestExtract,
}: {
  item: EvidenceView;
  mode: ExtractMode;
  busy: boolean;
  showText: boolean;
  onModeChange: (m: ExtractMode) => void;
  onToggleText: () => void;
  onRequestExtract: (item: EvidenceView, mode: ExtractMode) => void;
}) {
  const ex: ExtractionInfo | null = item.extraction;
  const state = ex?.status ?? 'none';
  const running = state === 'queued' || state === 'running';

  return (
    <Card data-veil="" className="p-3.5">
      <h3 className="fs-m font-semibold text-ink">内容与简报</h3>
      <p className="mt-1 fs-s text-ink-2">{EXTRACT_STATE[state] ?? EXTRACT_STATE.none}</p>

      {ex?.brief ? (
        <div className="mt-3 flex flex-col gap-2.5 fs-s">
          <BriefBlock label="这份材料能证明什么" text={ex.brief.proves} />
          {ex.brief.key_facts.length > 0 && (
            <div>
              <p className="fs-xs text-ink-2">关键事实</p>
              <ul className="mt-1 flex flex-col gap-1.5">
                {ex.brief.key_facts.map((f, i) => (
                  <li key={i} className="text-ink">
                    <span className="num text-ink-2">{[f.when, f.where].filter(Boolean).join(' · ') || '时间未标'}</span>
                    {'　'}
                    {[f.who, f.what].filter(Boolean).join('：')}
                    {f.quote && <span className="text-ink-2">「{f.quote}」</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <BriefBlock label="和你的诉求什么关系" text={ex.brief.relation_to_claims} />
          <BriefList label="对方可能拿来反驳的地方" items={ex.brief.weaknesses} />
          <BriefList label="还该补什么" items={ex.brief.suggested_followups} />
          <BriefList label="引用位置" items={ex.brief.citations} />
        </div>
      ) : (
        state === 'done' && (
          <p className="mt-2 fs-s text-ink-2">
            文字已经提取出来了，简报还没生成。下面可以直接看原文。
          </p>
        )
      )}

      {ex && ex.textChars > 0 && (
        <div className="mt-3">
          <Button size="sm" variant="ghost" onClick={onToggleText}>
            {showText ? '收起原文' : `展开原文（${ex.textChars} 字）`}
          </Button>
          {showText && (
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-surface-2 px-3 py-2 fs-xs text-ink-2">
              {ex.text}
              {ex.truncated && '\n\n（后面还有，这里只显示前面一段）'}
            </pre>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          className="min-h-11 rounded-[10px] border border-line bg-surface px-3 fs-s text-ink"
          value={mode}
          onChange={(e) => onModeChange(e.target.value as ExtractMode)}
          aria-label="提取方式"
        >
          {(Object.keys(MODE_LABEL) as ExtractMode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant={state === 'done' ? 'secondary' : 'primary'}
          disabled={busy || running}
          onClick={() => onRequestExtract(item, mode)}
        >
          {busy ? '正在问价…' : running ? '正在处理…' : state === 'done' ? '重新提取' : '提取内容'}
        </Button>
      </div>
      <p className="mt-2 fs-xs text-ink-2">
        点「提取」只是先看价，不会扣费；价会逐项列出来，确认之后才开始跑、才扣。
      </p>
    </Card>
  );
}

function BriefBlock({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div>
      <p className="fs-xs text-ink-2">{label}</p>
      <p className="mt-0.5 text-ink">{text}</p>
    </div>
  );
}

function BriefList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="fs-xs text-ink-2">{label}</p>
      <ul className="mt-0.5 list-disc pl-4 text-ink">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}
