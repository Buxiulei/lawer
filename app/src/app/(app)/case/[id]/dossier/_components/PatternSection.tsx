'use client';

import type { DossierPattern } from '@/lib/dossier/contract';
import { formatDate } from '@/app/_ui/format';
import { Sensitive } from '@/components/Sensitive';

/**
 * 套路卡。每条归纳下面逐条列**案号 + 逐字引文**。
 *
 * 【没有 evidence 的 pattern 在这里也渲染不出来】后端已经拦过一道
 * （案号要在库、引文要是全文的逐字子串，不过就丢），这里是第二道。
 * 双保险不是冗余：这两道拦的是不同的失败——后端拦的是模型编造，
 * 这里拦的是"接口哪天松了口径"。一条没有出处的"这家公司惯用XX手段"
 * 是我们替用户说的话，说错了要他去开庭承担。
 */
export function PatternSection({
  patterns,
  dropped,
}: {
  patterns: DossierPattern[];
  dropped: number;
}) {
  const shown = patterns.filter((p) => p.evidence.length > 0);

  return (
    <section className="flex flex-col gap-3">
      {shown.length === 0 && (
        <p data-veil="" className="prose-measure text-[14px] leading-7 text-ink-2">
          还没有归纳出带出处的应诉套路。只有取到全文的判例才会进这一步，
          仅有案号的条目不参与——凭标题归纳等于让模型编案情。
        </p>
      )}

      {shown.map((p) => (
        <article
          key={p.id}
          className="rounded-[12px] border border-border bg-card px-4 py-3.5"
        >
          <Sensitive as="div">
            <h3 className="prose-measure text-[15px] leading-7 font-semibold text-ink">
              {p.pattern}
            </h3>
          </Sensitive>
          <ul className="mt-2.5 flex flex-col gap-2.5">
            {p.evidence.map((ev, i) => (
              <li key={`${ev.caseNo}-${i}`} data-veil="">
                <p className="num text-[13px] leading-6 text-ink-2">{ev.caseNo}</p>
                {/* 引文是文书全文的逐字子串，展示时不改写、不省略号截断 */}
                <blockquote className="mt-0.5 rounded-r-[8px] border-l-4 border-primary bg-surface-2 px-3 py-2 text-[14px] leading-7 text-ink">
                  {ev.quote}
                </blockquote>
                {ev.docUrl && (
                  <a
                    href={ev.docUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex min-h-11 items-center text-[14px] text-primary-ink underline underline-offset-4"
                  >
                    看原文这一段
                  </a>
                )}
              </li>
            ))}
          </ul>
          <p data-veil="" className="mt-2 text-[12.5px] leading-6 text-ink-2">
            由 {p.model} 归纳于 {formatDate(p.generatedAt)}，每条都经案号与引文逐字校验。
          </p>
        </article>
      ))}

      {/* 丢弃计数必须看得见：静默丢弃会把模型编造率藏起来，
          而编造率正是这条红线唯一的体温计。 */}
      {dropped > 0 && (
        <p data-veil="" className="prose-measure text-[13px] leading-6 text-ink-2">
          另有 <span className="num">{dropped}</span> 条归纳因为引文对不上原文、
          或案号不在已入档的清单里被丢弃，没有显示在上面。
        </p>
      )}
    </section>
  );
}
