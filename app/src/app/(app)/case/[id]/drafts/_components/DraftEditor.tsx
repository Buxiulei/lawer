'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { versionsOf, type DraftVersion } from '@/app/_mock/docs-drafts';
import type { Draft } from '@/app/_mock/types';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import { formatDateTime } from '@/app/_ui/format';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';
import { Textarea } from '@/components/shadcn/textarea';
import { useToast } from '@/components/ui/Toast';
import { DraftKindBadge, DraftStatusBadge } from './badges';
import { ShareLinkPanel } from './ShareLinkPanel';

/** 高度跟着内容走的 textarea，不引编辑器库。 */
function AutoTextarea({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <Textarea
      ref={ref}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      // 高度由上面的 useLayoutEffect 接管，这里要关掉手动拖拽和滚动条
      className="resize-none overflow-hidden px-3.5 py-3 leading-8"
    />
  );
}

export function DraftEditor({ draft }: { draft: Draft }) {
  const toast = useToast();
  const { discreet } = useDiscreet();

  const [versions, setVersions] = useState<DraftVersion[]>(() => versionsOf(draft));
  const latest = versions[versions.length - 1];
  const [viewing, setViewing] = useState<number>(latest.version);
  const [content, setContent] = useState(latest.content);
  const [savedContent, setSavedContent] = useState(latest.content);
  const [status, setStatus] = useState<Draft['status']>(draft.status);
  const [shareOpen, setShareOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  const current = versions.find((v) => v.version === viewing) ?? latest;
  const onLatest = viewing === latest.version;
  const dirty = onLatest && content !== savedContent;

  const save = () => {
    setSavedContent(content);
    setVersions((prev) =>
      prev.map((v) =>
        v.version === latest.version
          ? { ...v, content, updatedAt: new Date().toISOString() }
          : v,
      ),
    );
    toast('已保存', 'success', '已保存');
  };

  const restore = () => {
    const next: DraftVersion = {
      version: latest.version + 1,
      content: current.content,
      updatedAt: new Date().toISOString(),
      note: `恢复自 v${current.version}`,
    };
    setVersions((prev) => [...prev, next]);
    setViewing(next.version);
    setContent(next.content);
    setSavedContent(next.content);
    toast(`已恢复到 v${current.version} 的内容，存为 v${next.version}`, 'success', '已保存');
  };

  const markSent = () => {
    setStatus('已发出');
    setSendOpen(false);
    toast('已标记为发出，时间线里也记了一笔', 'success', '有一条新的更新');
  };

  return (
    <div className="flex flex-col gap-4 pt-1">
      <header className="pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <DraftKindBadge kind={draft.kind} />
          <DraftStatusBadge status={status} />
          <span className="num text-[13px] text-ink-2">
            v{latest.version} · 更新于 {formatDateTime(latest.updatedAt)}
          </span>
        </div>
        <h1 className="mt-1.5 text-[22px] leading-8 font-semibold text-ink">{draft.title}</h1>
      </header>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={save} disabled={!onLatest || !dirty}>
          {dirty ? '保存修改' : '已保存'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => toast('导出 PDF 还在开发中', 'neutral', '功能开发中')}
        >
          导出 PDF
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setShareOpen(true)}>
          分享链接
        </Button>
        {status !== '已发出' && (
          <Button size="sm" variant="secondary" onClick={() => setSendOpen(true)}>
            标记已发送给公司
          </Button>
        )}
      </div>

      {discreet ? (
        // 文书正文整篇都是公司名、金额和主张，低调模式下不适合只打码局部
        <Card className="border-dashed px-4 py-10 text-center shadow-none">
          <p className="prose-measure mx-auto text-[15px] leading-7 text-ink-2">
            低调模式开着，正文先不显示。要看或者要改，点顶栏那只眼睛关掉低调模式。
          </p>
        </Card>
      ) : onLatest ? (
        <AutoTextarea value={content} onChange={setContent} label={`${draft.title} 正文`} />
      ) : (
        <Card className="bg-secondary px-3.5 py-3 shadow-none">
          <p className="mb-2 text-[14px] text-ink-2">
            正在看 v{current.version}（{formatDateTime(current.updatedAt)}），历史版本不能直接改。
          </p>
          <pre className="font-sans text-[16px] leading-8 whitespace-pre-wrap text-ink">
            {current.content}
          </pre>
          <div className="mt-3">
            <Button size="sm" onClick={restore}>
              恢复这一版
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="text-[15px] font-semibold text-ink">版本历史</h2>
        <p className="mt-1 text-[14px] leading-6 text-ink-2">
          恢复旧版本不会覆盖现在这一版，会另存成新的一版，两版都留着。
        </p>
        <ul className="mt-3 flex flex-col gap-2">
          {[...versions].reverse().map((v) => {
            const active = v.version === viewing;
            return (
              <li key={v.version}>
                <button
                  type="button"
                  onClick={() => setViewing(v.version)}
                  aria-pressed={active}
                  className={cn(
                    'flex min-h-11 w-full items-start gap-3 rounded-[10px] border px-3 py-2.5 text-left transition-colors duration-150 ease-out',
                    active
                      ? 'border-primary bg-primary-wash'
                      : 'border-line bg-surface hover:bg-surface-2',
                  )}
                >
                  <span className="num shrink-0 text-[15px] font-semibold text-ink">
                    v{v.version}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] leading-6 text-ink">{v.note}</span>
                    <span className="num mt-0.5 block text-[13px] text-ink-2">
                      {formatDateTime(v.updatedAt)}
                      {v.version === latest.version ? ' · 当前版本' : ''}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      <ShareLinkPanel
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        draftId={draft.id}
        draftTitle={draft.title}
      />

      <ConfirmDialog
        open={sendOpen}
        title="标记为已发送给公司"
        description={
          <>
            这份文书（{draft.title}）的全文会被公司看到，内容里的措辞、金额和你的主张都会成为对方的准备材料。
            标记之后本文书状态变成「已发出」，时间线会记下发出时间，后续再改只能另起新版本。
            请确认你确实已经把这一版发给了公司。
          </>
        }
        confirmLabel="确认已发送给公司"
        tone="danger"
        onConfirm={markSent}
        onCancel={() => setSendOpen(false)}
      />
    </div>
  );
}
