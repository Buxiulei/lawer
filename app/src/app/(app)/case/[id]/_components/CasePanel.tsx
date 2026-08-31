"use client";

import Link from "next/link";
import { useState } from "react";
import type {
  ActionItem,
  Claim,
  Deadline,
  EvidenceItem,
  EvidenceStatus,
  TimelineEvent,
  TimelineKind,
} from "@/app/_mock/types";
import {
  demoClaims,
  demoDeadlines,
  demoEvidence,
  demoMessages,
  demoTimeline,
} from "@/app/_mock/demo";
import { mockCompanyGraph } from "@/app/_mock/company-graph";
import { useDiscreet } from "@/app/_ui/discreet";
import { NEUTRAL_WORD } from "@/app/_ui/neutral";
import { cn } from "@/app/_ui/cn";
import { formatDate } from "@/app/_ui/format";
import { AmountText } from "@/components/case/AmountText";
import { DeadlineChip } from "@/components/case/DeadlineChip";
import {
  EvidenceBadge,
  OriginalMediumNotice,
} from "@/components/case/EvidenceBadge";
import { Badge } from "@/components/shadcn/badge";
import { Sensitive } from "@/components/Sensitive";
import { citedLaws, evidenceCiteId, lawCiteId } from "./citations";
import { MaskedText } from "./RichText";

/**
 * 案件档案面板：时间线 / 诉求金额 / 证据摘要 / 本案依据 / 待办与截止日。
 * PC 右栏常驻，移动端在 Sheet 里复用同一组件。
 *
 * 本面板同时是**引用桥的卷宗侧**（批B，设计 §四）：时间线每条挂 data-cite
 * （它靠哪几份材料记下的），证据行挂 data-cite-target，「本案依据」每行挂
 * data-cite-target 指向对话里那几张法条卡。桥本身装在 Workbench 上、只在有 hover
 * 的设备生效，触屏一行属性都不读。
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
      <CompanyGraphBlock caseId={caseId} />
      <ClaimsBlock claims={demoClaims} />
      <EvidenceBlock caseId={caseId} items={demoEvidence} />
      {/* **不能排在最后**：本块窄屏 display:none，但 `:last-child` 照样命中它，
          排最后会把 TodoBlock 的 last:border-b-0 顶掉、在手机上凭空多一条底线
          （display:none 不改变结构伪类——这条坑值得写下来）。 */}
      <LawBasisBlock />
      <TodoBlock actions={actions} deadlines={demoDeadlines} />
    </div>
  );
}

/* ── 时间线 ───────────────────────────────────────────────── */

const KIND_DOT: Record<TimelineKind, string> = {
  公司动作: "bg-amber",
  我方动作: "bg-primary",
  系统动作: "bg-ink-2",
  期限: "bg-amber",
};

const VISIBLE_EVENTS = 4;

function TimelineBlock({ events }: { events: TimelineEvent[] }) {
  const [all, setAll] = useState(false);
  const ordered = [...events].sort((a, b) =>
    b.happenedAt.localeCompare(a.happenedAt),
  );
  const shown = all ? ordered : ordered.slice(0, VISIBLE_EVENTS);

  return (
    <section className="border-b border-line pb-4 last:border-b-0">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="fs-m font-semibold text-ink">时间线</h3>
        <span className="num fs-xs text-ink-2">{events.length} 条</span>
      </header>
      <div>
        <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 fs-xs text-ink-2">
          {(["公司动作", "我方动作", "系统动作"] as const).map((kind) => (
            <span key={kind} className="inline-flex items-center gap-1.5">
              <span
                className={cn("size-2 rounded-full", KIND_DOT[kind])}
                aria-hidden
              />
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
            // data-cite：这一条是靠哪几份材料记下来的。停在它上面，下面证据行里
            // 对应那几条一起亮；反过来停在证据上，用过它的时间线条目也亮。
            <li
              key={e.id}
              data-veil=""
              data-cite={
                e.evidenceIds.length > 0
                  ? e.evidenceIds.map(evidenceCiteId).join(" ")
                  : undefined
              }
              className="relative"
            >
              <span
                aria-hidden
                className={cn(
                  "absolute top-[7px] -left-5 size-2 rounded-full ring-4 ring-surface",
                  KIND_DOT[e.kind],
                )}
              />
              <p className="num fs-xs text-ink-2">
                {formatDate(e.happenedAt)}
              </p>
              <p className="fs-m font-medium text-ink">
                {e.title}
              </p>
              <p className="mt-0.5 line-clamp-2 fs-s text-ink-2">
                <MaskedText text={e.detail} />
              </p>
            </li>
          ))}
        </ol>

        {ordered.length > VISIBLE_EVENTS && (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            className="mt-2 min-h-11 fs-s text-primary-ink"
          >
            {all ? "只看最近 4 条" : `展开全部 ${ordered.length} 条`}
          </button>
        )}
      </div>
    </section>
  );
}

/* ── 公司图谱入口 ─────────────────────────────────────────── */

function CompanyGraphBlock({ caseId }: { caseId: string }) {
  return (
    <section className="border-b border-line pb-4 last:border-b-0">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="fs-m font-semibold text-ink">公司图谱</h3>
        <span className="num fs-xs text-ink-2">
          {mockCompanyGraph.nodes.length} 个主体
        </span>
      </header>
      <div>
        <p data-veil="" className="fs-s text-ink-2">
          跟你签合同的、给你发工资的、背后控股的，常常不是同一家。
        </p>
        <Link
          href={`/case/${caseId}/graph`}
          className="mt-1 inline-flex min-h-11 items-center fs-s text-primary-ink"
        >
          看它们的关系 →
        </Link>
      </div>
    </section>
  );
}

/* ── 诉求金额 ─────────────────────────────────────────────── */

const CLAIM_TONE = {
  已确认: "success",
  待补证: "amber",
  初算: "neutral",
} as const;

function ClaimsBlock({ claims }: { claims: Claim[] }) {
  const total = claims.reduce((sum, c) => sum + c.amountFen, 0);

  return (
    <section className="border-b border-line pb-4 last:border-b-0">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="fs-m font-semibold text-ink">
          <span data-veil="">诉求金额</span>
        </h3>
      </header>
      <div>
        <table className="w-full border-collapse">
          <caption className="sr-only">诉求种类、金额与依据</caption>
          <tbody>
            {claims.map((c) => (
              <tr
                key={c.id}
                data-veil=""
                className="border-t border-line align-top first:border-t-0"
              >
                <th scope="row" className="py-2.5 pr-2 text-left font-normal">
                  <span className="block fs-m font-medium text-ink">
                    {c.label}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge tone={CLAIM_TONE[c.status]}>{c.status}</Badge>
                  </span>
                  <span className="mt-1 line-clamp-2 fs-xs text-ink-2">
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
            <tr data-veil="" className="border-t-2 border-line">
              <th
                scope="row"
                className="py-3 text-left fs-m font-semibold text-ink"
              >
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
        <p data-veil="" className="mt-1 fs-xs text-ink-2">
          初算值，随证据补充调整；北京口径，月工资未触及三倍社平封顶。
        </p>
      </div>
    </section>
  );
}

/* ── 证据摘要 ─────────────────────────────────────────────── */

const EVIDENCE_ORDER: EvidenceStatus[] = ["已出证", "已固化", "已上传"];

function EvidenceBlock({
  caseId,
  items,
}: {
  caseId: string;
  items: EvidenceItem[];
}) {
  const { discreet } = useDiscreet();
  const counts = EVIDENCE_ORDER.map((status) => ({
    status,
    n: items.filter((i) => i.status === status).length,
  })).filter((c) => c.n > 0);

  return (
    <section className="border-b border-line pb-4 last:border-b-0">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="fs-m font-semibold text-ink">
          <span data-veil="">证据清单</span>
        </h3>
        <span className="num fs-xs text-ink-2">{items.length} 件</span>
      </header>
      <div>
        <div data-veil="" className="flex flex-wrap items-center gap-2">
          {counts.map(({ status, n }) => (
            <span key={status} className="inline-flex items-center gap-1">
              <EvidenceBadge status={status} />
              <span className="num fs-xs text-ink-2">{n}</span>
            </span>
          ))}
        </div>

        <ul className="mt-3 flex flex-col gap-2">
          {items.slice(0, 3).map((item) => (
            <li
              key={item.id}
              data-veil=""
              data-cite-target={evidenceCiteId(item.id)}
              className="flex items-start gap-2"
            >
              <span
                className="mt-2 size-1.5 shrink-0 rounded-full bg-line"
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate fs-s text-ink">
                  {item.name}
                </span>
                <span className="fs-xs text-ink-2">
                  {item.category}
                </span>
              </span>
            </li>
          ))}
        </ul>

        {/* 链接文字得留着能读（进糊层就没法当入口用了），所以走换词：
            低调下「证据」一律读作「资料」，与底部 Tab 同一套 */}
        <Link
          href={`/case/${caseId}/evidence`}
          className="mt-2 inline-flex min-h-11 items-center fs-s text-primary-ink"
        >
          查看全部 {items.length} 件{discreet ? NEUTRAL_WORD.evidence : "证据"}{" "}
          →
        </Link>

        <div className="mt-1">
          <OriginalMediumNotice />
        </div>
      </div>
    </section>
  );
}

/* ── 本案依据（引用桥的卷宗侧）────────────────────────────── */

/**
 * 对话里引过的法条速查。每一行挂 data-cite-target：停在它上面，对话里引过这条的
 * 每一张法条卡都亮；点它，查看器开出逐字原件（点击由 Workbench 上的桥统一接管，
 * 这里不各挂一个 onClick）。
 *
 * **门用容器查询而不是视口 xl**：卷宗栏本身在容器 ≥990 时才排开，本块的显隐必须
 * 跟它同一个阈值——否则会出现「卷宗栏在、本案依据这半却不在」的窄桌面带，
 * 停在法条卡上没有任何一行能亮。移动端 Sheet 里没有 work 容器，
 * `@min-[990px]/work:block` 永不命中 → 一个像素不占（移动端零回归的落点）。
 */
function LawBasisBlock() {
  const laws = citedLaws(demoMessages);
  if (laws.length === 0) return null;

  return (
    <section className="hidden border-b border-line pb-4 last:border-b-0 @min-[990px]/work:block">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="fs-m font-semibold text-ink">本案依据</h3>
        <span className="num fs-xs text-ink-2">{laws.length} 条</span>
      </header>
      <p className="mb-2 fs-xs text-ink-2">
        指着一条看，对话里引过它的每一处都会亮起来；点开看逐字原文。
      </p>
      <ul className="flex flex-col gap-0.5">
        {laws.map(({ cite, count }) => (
          <li key={cite}>
            <button
              type="button"
              data-cite-target={lawCiteId(cite)}
              className="w-full rounded-[6px] px-1.5 py-1.5 text-left"
            >
              {/* 条号本身不含案情，不进糊层：低调模式下它仍是这一行的路标 */}
              <span className="block fs-s text-primary-ink">{cite}</span>
              <span className="num fs-xs text-ink-2">引用 {count} 处</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
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
    .filter((a) => a.status !== "完成")
    .sort(
      (a, b) =>
        a.priority - b.priority || (a.dueAt ?? "").localeCompare(b.dueAt ?? ""),
    );
  const done = actions.filter((a) => a.status === "完成");
  const sortedDeadlines = [...deadlines].sort((a, b) =>
    a.dueAt.localeCompare(b.dueAt),
  );

  return (
    <section className="border-b border-line pb-4 last:border-b-0">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="fs-m font-semibold text-ink">待办与截止日</h3>
        <span className="num fs-xs text-ink-2">
          {done.length}/{actions.length}
        </span>
      </header>
      <div>
        <ul className="flex flex-col gap-3">
          {open.map((a) => (
            <li key={a.id} data-veil="">
              <p className="fs-m text-ink">{a.title}</p>
              {a.dueAt && (
                <span className="mt-1 inline-block">
                  <DeadlineChip dueAt={a.dueAt} />
                </span>
              )}
            </li>
          ))}
          {done.map((a) => (
            <li
              key={a.id}
              data-veil=""
              className="fs-m text-ink-2 line-through"
            >
              {a.title}
            </li>
          ))}
        </ul>

        <div className="mt-4 border-t border-line pt-3">
          <h3 className="mb-2 fs-s font-semibold text-ink">截止日</h3>
          <ul className="flex flex-col gap-3">
            {sortedDeadlines.map((d) => (
              <li key={d.id} data-veil="">
                <p className="fs-m text-ink">{d.title}</p>
                <span className="mt-1 inline-block">
                  <DeadlineChip dueAt={d.dueAt} showDate />
                </span>
                <p className="mt-1 fs-xs text-ink-2">
                  {d.derivedFrom}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
