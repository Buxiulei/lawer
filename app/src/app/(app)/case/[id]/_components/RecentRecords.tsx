'use client';

import Link from 'next/link';
import { NeutralLabel } from '@/app/_ui/NeutralLabel';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Badge } from '@/components/shadcn/badge';
import type { RecordRow } from './dashboardData';

/**
 * 最近的证据与文书，只露最新三条。
 *
 * 这里是**入口不是清单**——完整的在证据/文书两个 tab 里。
 * 驾驶舱多摆一行，用户就少一眼看见「现在做什么」。
 *
 * 行由 dashboardData 备好（真接口或 demo），这一层不自己取数：
 * 它此前直接 import `_mock/demo`，于是真实案件的「最近的材料」里
 * 摆的是演示案件那几份编出来的文件。
 */
export function RecentRecords({ caseId, records }: { caseId: string; records: RecordRow[] }) {
  const rows = records;

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
