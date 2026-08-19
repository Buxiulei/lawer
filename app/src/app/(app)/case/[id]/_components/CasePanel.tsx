'use client';

import Link from 'next/link';
import { useState } from 'react';
import type {
  ActionItem,
  Claim,
  Deadline,
  EvidenceItem,
  EvidenceStatus,
  TimelineEvent,
  TimelineKind,
} from '@/app/_mock/types';
import {
  demoClaims,
  demoDeadlines,
  demoEvidence,
  demoTimeline,
} from '@/app/_mock/demo';
import { cn } from '@/app/_ui/cn';
import { formatDate } from '@/app/_ui/format';
import { AmountText } from '@/components/case/AmountText';
import { DeadlineChip } from '@/components/case/DeadlineChip';
import {
  EvidenceBadge,
  OriginalMediumNotice,
} from '@/components/case/EvidenceBadge';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Sensitive } from '@/components/Sensitive';
import { MaskedText } from './RichText';

/**
 * 案件档案面板：时间线 / 诉求金额 / 证据摘要 / 待办与截止日。
 * PC 右栏常驻，移动端在 Sheet 里复用同一组件。
 */
export function CasePanel({
  caseId,
  actions,
}: {
  caseId: string;
  actions: ActionItem[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <TimelineBlock events={demoTimeline} />
      <ClaimsBlock claims={demoClaims} />
      <EvidenceBlock caseId={caseId} items={demoEvidence} />
      <TodoBlock actions={actions} deadlines={demoDeadlines} />
    </div>
  );
}

/* ── 时间线 ───────────────────────────────────────────────── */

const KIND_DOT: Record<TimelineKind, string> = {
  公司动作: 'bg-amber',
  我方动作: 'bg-primary',
  系统动作: 'bg-ink-2',
  期限: 'bg-amber',
};

const VISIBLE_EVENTS = 4;

function TimelineBlock({ events }: { events: TimelineEvent[] }) {
  const [all, setAll] = useState(false);
  const ordered = [...events].sort((a, b) => b.happenedAt.localeCompare(a.happenedAt));
  const shown = all ? ordered : ordered.slice(0, VISIBLE_EVENTS);

  return (
    <Card>
      <CardHeader
        title="时间线"
        action={<span className="num text-[13px] text-ink-2">{events.length} 条</span>}
      />
      <CardBody>
        <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-ink-2">
          {(['公司动作', '我方动作', '系统动作'] as const).map((kind) => (
            <span key={kind} className="inline-flex items-center gap-1.5">
              <span className={cn('size-2 rounded-full', KIND_DOT[kind])} aria-hidden />
              {kind}
            </span>
          ))}
        </div>

        <ol className="relative flex flex-col gap-4 pl-5">
          <span
            aria-hidden
            className="absolute top-2 bottom-2 left-[3.5px] w-px bg-line"
          />
          {shown.map((e) => (
            <li key={e.id} className="relative">
              <span
                aria-hidden
                className={cn(
                  'absolute top-[7px] -left-5 size-2 rounded-full ring-4 ring-surface',
                  KIND_DOT[e.kind],
                )}
              />
              <p className="num text-[13px] leading-6 text-ink-2">
                {formatDate(e.happenedAt)}
              </p>
              <p className="text-[15px] leading-6 font-medium text-ink">{e.title}</p>
              <p className="mt-0.5 line-clamp-2 text-[14px] leading-6 text-ink-2">
                <MaskedText text={e.detail} />
              </p>
            </li>
          ))}
        </ol>

        {ordered.length > VISIBLE_EVENTS && (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            className="mt-2 min-h-11 text-[14px] text-primary-ink"
          >
            {all ? '只看最近 4 条' : `展开全部 ${ordered.length} 条`}
          </button>
        )}
      </CardBody>
    </Card>
  );
}

/* ── 诉求金额 ─────────────────────────────────────────────── */

const CLAIM_TONE = {
  已确认: 'success',
  待补证: 'amber',
  初算: 'neutral',
} as const;

function ClaimsBlock({ claims }: { claims: Claim[] }) {
  const total = claims.reduce((sum, c) => sum + c.amountFen, 0);

  return (
    <Card>
      <CardHeader title="诉求金额" />
      <CardBody>
        <table className="w-full border-collapse">
          <caption className="sr-only">诉求种类、金额与依据</caption>
          <tbody>
            {claims.map((c) => (
              <tr key={c.id} className="border-t border-line align-top first:border-t-0">
                <th scope="row" className="py-2.5 pr-2 text-left font-normal">
                  <span className="block text-[15px] leading-6 font-medium text-ink">
                    {c.label}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge tone={CLAIM_TONE[c.status]}>{c.status}</Badge>
                  </span>
                  <span className="mt-1 line-clamp-2 text-[13px] leading-6 text-ink-2">
                    {c.basis}
                  </span>
                </th>
                <td className="py-2.5 text-right whitespace-nowrap">
                  <Sensitive>
                    <AmountText fen={c.amountFen} size="sm" />
                  </Sensitive>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line">
              <th scope="row" className="py-3 text-left text-[15px] font-semibold text-ink">
                合计
              </th>
              <td className="py-3 text-right">
                <Sensitive>
                  <AmountText fen={total} size="md" />
                </Sensitive>
              </td>
            </tr>
          </tfoot>
        </table>
        <p className="mt-1 text-[13px] leading-6 text-ink-2">
          初算值，随证据补充调整；北京口径，月工资未触及三倍社平封顶。
        </p>
      </CardBody>
    </Card>
  );
}

/* ── 证据摘要 ─────────────────────────────────────────────── */

const EVIDENCE_ORDER: EvidenceStatus[] = ['已出证', '已固化', '已上传'];

function EvidenceBlock({
  caseId,
  items,
}: {
  caseId: string;
  items: EvidenceItem[];
}) {
  const counts = EVIDENCE_ORDER.map((status) => ({
    status,
    n: items.filter((i) => i.status === status).length,
  })).filter((c) => c.n > 0);

  return (
    <Card>
      <CardHeader
        title="证据清单"
        action={<span className="num text-[13px] text-ink-2">{items.length} 件</span>}
      />
      <CardBody>
        <div className="flex flex-wrap items-center gap-2">
          {counts.map(({ status, n }) => (
            <span key={status} className="inline-flex items-center gap-1">
              <EvidenceBadge status={status} />
              <span className="num text-[13px] text-ink-2">{n}</span>
            </span>
          ))}
        </div>

        <ul className="mt-3 flex flex-col gap-2">
          {items.slice(0, 3).map((item) => (
            <li key={item.id} className="flex items-start gap-2">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-line" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] leading-6 text-ink">
                  {item.name}
                </span>
                <span className="text-[13px] leading-5 text-ink-2">{item.category}</span>
              </span>
            </li>
          ))}
        </ul>

        <Link
          href={`/case/${caseId}/evidence`}
          className="mt-2 inline-flex min-h-11 items-center text-[14px] text-primary-ink"
        >
          查看全部 {items.length} 件证据 →
        </Link>

        <div className="mt-1">
          <OriginalMediumNotice />
        </div>
      </CardBody>
    </Card>
  );
}

/* ── 待办与截止日 ─────────────────────────────────────────── */

function TodoBlock({
  actions,
  deadlines,
}: {
  actions: ActionItem[];
  deadlines: Deadline[];
}) {
  const open = actions
    .filter((a) => a.status !== '完成')
    .sort((a, b) => a.priority - b.priority || (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
  const done = actions.filter((a) => a.status === '完成');
  const sortedDeadlines = [...deadlines].sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  return (
    <Card>
      <CardHeader
        title="待办与截止日"
        action={
          <span className="num text-[13px] text-ink-2">
            {done.length}/{actions.length}
          </span>
        }
      />
      <CardBody>
        <ul className="flex flex-col gap-3">
          {open.map((a) => (
            <li key={a.id}>
              <p className="text-[15px] leading-6 text-ink">{a.title}</p>
              {a.dueAt && (
                <span className="mt-1 inline-block">
                  <DeadlineChip dueAt={a.dueAt} />
                </span>
              )}
            </li>
          ))}
          {done.map((a) => (
            <li key={a.id} className="text-[15px] leading-6 text-ink-2 line-through">
              {a.title}
            </li>
          ))}
        </ul>

        <div className="mt-4 border-t border-line pt-3">
          <h3 className="mb-2 text-[14px] font-semibold text-ink">截止日</h3>
          <ul className="flex flex-col gap-3">
            {sortedDeadlines.map((d) => (
              <li key={d.id}>
                <p className="text-[15px] leading-6 text-ink">{d.title}</p>
                <span className="mt-1 inline-block">
                  <DeadlineChip dueAt={d.dueAt} showDate />
                </span>
                <p className="mt-1 text-[13px] leading-6 text-ink-2">{d.derivedFrom}</p>
              </li>
            ))}
          </ul>
        </div>
      </CardBody>
    </Card>
  );
}
