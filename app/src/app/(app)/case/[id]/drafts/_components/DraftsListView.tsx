import Link from 'next/link';
import { formatDateTime } from '@/app/_ui/format';
import { NeutralLabel } from '@/app/_ui/NeutralLabel';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { EmptyState } from '@/components/shadcn/empty-state';
import { DraftKindBadge, DraftStatusBadge } from './badges';
import type { DraftView } from './draftsData';

/**
 * 文书列表的画法。**只吃传进来的 drafts**，自己不取数、不认 demo——
 * 演示案件传 mock、真实案件传接口取回的行，两条路走同一份版式。
 * 分出来也是为了让「这一页有没有渲染演示数据」在 node 环境里就验得出来。
 */
export function DraftsListView({
  caseId,
  drafts,
}: {
  caseId: string;
  drafts: DraftView[];
}) {
  return (
    <div className="pt-1">
      <header className="py-3">
        <h1 className="text-[20px] font-semibold text-ink">
          <NeutralLabel plain="文书" neutral={NEUTRAL_WORD.drafts} />
        </h1>
        {/* 标题换了中性词，这句导语里还有「仲裁委」，得进糊层 */}
        <p data-veil="" className="mt-0.5 text-[15px] leading-7 text-ink-2">
          写给公司和仲裁委的东西都在这儿。需要新的一份，去
          <Link href={`/case/${caseId}/ask`} className="mx-1 text-primary-ink underline underline-offset-4">
            问它
          </Link>
          说一句就行。
        </p>
      </header>

      {drafts.length === 0 ? (
        <EmptyState
          title="还没有文书"
          description="要递给公司或仲裁委的东西都会存在这一页。现在一份都还没有——去对话里说清楚你要写什么，它会起草并存进来；手里已有的材料先传进证据库。"
          action={<DraftEntries caseId={caseId} />}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {drafts.map((draft) => (
            <li key={draft.id}>
              <Link href={`/case/${caseId}/drafts/${draft.id}`} className="group block">
                <Card
                  data-veil=""
                  className="p-4 transition-colors duration-150 ease-out group-hover:bg-muted"
                >
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
      )}
    </div>
  );
}

/** 空态的两个去处：起草走对话，材料走证据库。空态里不给「新建文书」——没有那条通路 */
export function DraftEntries({ caseId }: { caseId: string }) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      <Button asChild>
        <Link href={`/case/${caseId}/ask`}>
          去<NeutralLabel plain="问它" neutral={NEUTRAL_WORD.ask} />
        </Link>
      </Button>
      <Button asChild variant="secondary">
        <Link href={`/case/${caseId}/evidence`}>证据库</Link>
      </Button>
    </div>
  );
}
