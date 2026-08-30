'use client';

import Link from 'next/link';
import { NeutralLabel } from '@/app/_ui/NeutralLabel';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { demoCompanyDocs, demoEvidence } from '@/app/_mock/demo';
import { Badge, type BadgeTone } from '@/components/shadcn/badge';

/** 证据状态 → 徽标色。与证据库那张表同一套，别在两处各调各的 */
const EVIDENCE_TONE: Record<string, BadgeTone> = {
  已上传: 'neutral',
  已固化: 'success',
  已出证: 'primary',
};

interface Row {
  key: string;
  name: string;
  tag: string;
  tone: BadgeTone;
  href: string;
  at: string;
}

/**
 * 最近的证据与文书，只露最新三条。
 *
 * 这里是**入口不是清单**——完整的在证据/文书两个 tab 里。
 * 驾驶舱多摆一行，用户就少一眼看见「现在做什么」。
 */
export function RecentRecords({ caseId }: { caseId: string }) {
  const rows: Row[] = [
    ...demoEvidence.map((e) => ({
      key: `ev-${e.id}`,
      name: e.name,
      tag: e.status,
      tone: EVIDENCE_TONE[e.status] ?? ('neutral' as BadgeTone),
      href: `/case/${caseId}/evidence`,
      at: e.createdAt,
    })),
    ...demoCompanyDocs.map((d) => ({
      key: `doc-${d.id}`,
      name: d.title,
      // 「签不签」是这类文件上最重的一个字，列表里也不降级成「已解读」
      tag: `结论：${d.advice}`,
      tone: (d.advice === '不签' ? 'danger' : 'neutral') as BadgeTone,
      href: `/case/${caseId}/docs/${d.id}`,
      at: d.createdAt,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 3);

  if (rows.length === 0) return null;

  return (
    <section className="mt-5">
      <h2 className="mb-1.5 text-[13px] font-semibold text-ink-2">最近的材料</h2>
      <ul className="divide-y divide-line rounded-[10px] border border-line bg-surface">
        {rows.map((r) => (
          <li key={r.key}>
            <Link
              href={r.href}
              className="flex min-h-11 items-center gap-2 px-3 py-2 no-underline"
            >
              <span data-veil="" className="min-w-0 flex-1 truncate text-[14px] text-ink">
                {r.name}
              </span>
              {/* 徽标也进糊层：「结论：不签」「已固化」照样是案情，
                  只糊文件名等于把最短的那句话留在了外面 */}
              <Badge tone={r.tone} data-veil="" className="shrink-0">
                {r.tag}
              </Badge>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[12.5px] text-ink-2">
        全部在
        {/* 这两条行内链接实测 25×14，**有意不补到 44**：它们是句子里的词，
            撑成 44px 会把这行说明拆成阶梯状；误点的代价只是跳到证据/文书页、退回来即可。
            决策见审查台账 P-03。 */}
        <Link href={`/case/${caseId}/evidence`} className="mx-1 text-primary-ink underline underline-offset-4">
          <NeutralLabel plain="证据" neutral={NEUTRAL_WORD.evidence} />
        </Link>
        和
        <Link href={`/case/${caseId}/drafts`} className="mx-1 text-primary-ink underline underline-offset-4">
          <NeutralLabel plain="文书" neutral={NEUTRAL_WORD.drafts} />
        </Link>
        里。
      </p>
    </section>
  );
}
