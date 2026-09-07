'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useCaseDomain } from '@/app/_ui/caseDomain';
import { packOf } from '@/app/_ui/domain';
import { formatDateTime } from '@/app/_ui/format';
import { NeutralLabel } from '@/app/_ui/NeutralLabel';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { EmptyState } from '@/components/shadcn/empty-state';
import { DraftKindBadge, DraftStatusBadge } from './badges';
import { unknownKinds, type DraftView } from './draftsData';

/**
 * 文书列表的画法。**只吃传进来的 drafts**，自己不取数、不认 demo——
 * 演示案件传 mock、真实案件传接口取回的行，两条路走同一份版式。
 * 分出来也是为了让「这一页有没有渲染演示数据」在 node 环境里就验得出来。
 *
 * 【导语与空态那两句按领域取】文书递到谁手里，是这一页唯一按行当变的东西。
 * 写死的形态是：第二个领域的用户在自己的文书页上读到一个跟他无关的收件人，
 * 而页面照常渲染、列表照常是他的那几份。
 */
export function DraftsListView({
  caseId,
  drafts,
}: {
  caseId: string;
  drafts: DraftView[];
}) {
  const pack = packOf(useCaseDomain(caseId));
  const copy = pack.copy.pages;

  /**
   * 【词表外的种类要出声，但屏幕上一个字都不改】库里这一类不在本领域的 `docKinds` 里，
   * 说明写它的那一侧与本领域的词表对不上——那是要人去看的事。
   *
   * 从前这个信号是在数据层顺手发的，而那一层只有 caseId、认不出领域，于是挂了一份写死的
   * 缺省领域词表：第二个领域的**每一份**文书都触发一次告警，并被折成「其他」。
   * 判在这里之后词表是这个案子自己的那份，**而渲染的字一个都没被改过**——
   * 出声与改归类从前绑在一起，现在拆开了。
   *
   * 【为什么判在这一层，不判在 RealDrafts】领域是问出来的，而这一层本来就问了一次
   *（导语与空态那两句按领域取）。挪到取数那一层的形态是：文书页在"取数失败"和"一份都没有"
   * 这两屏上也会多问一次案件详情——多一条谁都用不上的请求，只为一句控制台日志。
   */
  useEffect(() => {
    const unknown = unknownKinds(drafts.map((d) => d.kind), pack.docKinds);
    if (unknown.length > 0) {
      console.warn('[drafts] 这个领域的文书词表里没有这几类，已照原样渲染：', unknown.join('、'));
    }
  }, [drafts, pack]);

  return (
    <div className="pt-1">
      <header className="py-3">
        <h1 className="text-[20px] font-semibold text-ink">
          <NeutralLabel plain="文书" neutral={NEUTRAL_WORD.drafts} />
        </h1>
        {/* 标题换了中性词，这句导语里还点着收件人（各领域各有各的），得进糊层。
            拆成前后两截是因为中间夹着「问它」那条行内链接，见领域包 draftsIntroBefore。 */}
        <p data-veil="" className="mt-0.5 text-[15px] leading-7 text-ink-2">
          {copy.draftsIntroBefore}
          <Link href={`/case/${caseId}/ask`} className="mx-1 text-primary-ink underline underline-offset-4">
            问它
          </Link>
          {copy.draftsIntroAfter}
        </p>
      </header>

      {drafts.length === 0 ? (
        <EmptyState
          title="还没有文书"
          description={copy.draftsEmptyDescription}
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
