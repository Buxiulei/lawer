import type { Metadata } from 'next';
import Link from 'next/link';
import { mockDrafts } from '@/app/_mock/docs-drafts';
import { formatDateTime } from '@/app/_ui/format';
import { Card } from '@/components/shadcn/card';
import { DraftKindBadge, DraftStatusBadge } from './_components/badges';

export const metadata: Metadata = { title: '文书' };

export default async function DraftsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // 接后端前取 mock；后续换成按 caseId 查 drafts。
  const drafts = mockDrafts;

  return (
    <div className="pt-1">
      <header className="py-3">
        <h1 className="text-[20px] font-semibold text-ink">文书</h1>
        <p className="mt-0.5 text-[15px] leading-7 text-ink-2">
          写给公司和仲裁委的东西都在这儿。需要新的一份，去
          <Link href={`/case/${id}`} className="mx-1 text-primary-ink underline underline-offset-4">
            工作台
          </Link>
          说一句就行。
        </p>
      </header>

      <ul className="flex flex-col gap-3">
        {drafts.map((draft) => (
          <li key={draft.id}>
            <Link href={`/case/${id}/drafts/${draft.id}`} className="group block">
              <Card className="p-4 transition-colors duration-150 ease-out group-hover:bg-muted">
              <div className="flex flex-wrap items-center gap-2">
                <DraftKindBadge kind={draft.kind} />
                <DraftStatusBadge status={draft.status} />
                <span className="num text-[13px] text-ink-2">v{draft.version}</span>
              </div>

              <h2 className="mt-2 text-[17px] leading-7 font-semibold text-ink">
                {draft.title}
              </h2>
              <p className="num mt-1.5 text-[13px] text-ink-2">
                更新于 {formatDateTime(draft.updatedAt)}
              </p>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
