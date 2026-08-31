'use client';

import type { ReactNode } from 'react';
import type { CompanyGraph, GraphNode } from '@/app/_mock/company-graph';
import { formatDate } from '@/app/_ui/format';
import { AppSheet } from '@/components/shadcn/app-sheet';
import { Badge } from '@/components/shadcn/badge';
import { Sensitive } from '@/components/Sensitive';
import { TIER_RING } from './graphStyle';

const CONFIDENCE_TONE = { 高: 'success', 中: 'neutral', 低: 'amber' } as const;

/**
 * 节点详情抽屉。标题写死「关系详情」——顶栏那一行最容易被旁人瞥见，
 * 公司名放进正文里，低调模式下点一下才显示。
 */
export function NodeSheet({
  graph,
  node,
  onClose,
  onSelect,
}: {
  graph: CompanyGraph;
  node: GraphNode | null;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const links = node
    ? graph.edges
        .filter((e) => e.from === node.id || e.to === node.id)
        .map((e) => {
          const outgoing = e.from === node.id;
          const otherId = outgoing ? e.to : e.from;
          return {
            edge: e,
            outgoing,
            other: graph.nodes.find((n) => n.id === otherId),
          };
        })
    : [];
  const events = node ? graph.events.filter((e) => e.nodeId === node.id) : [];

  return (
    <AppSheet open={node !== null} onClose={onClose} title="关系详情">
      {node && (
        <div className="flex flex-col gap-5">
          <section>
            <Sensitive as="div">
              <h3 className="text-[18px] leading-7 font-semibold text-ink">{node.name}</h3>
            </Sensitive>
            {/* 角色写的是「现用人单位/目标主体」「发薪主体」这类判断，
                比公司名还直白，跟画布上的节点卡一样进糊层 */}
            <p data-veil="" className="mt-1 text-[14px] leading-6 text-ink-2">
              {node.role}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {/* 圈层是监控节奏不是风险结论，红只留给那圈 2px 的环 */}
              <Badge tone="neutral" className="gap-1.5">
                <span aria-hidden className={`size-2.5 rounded-full border-2 ${TIER_RING[node.tier]}`} />
                {graph.meta.tiers[node.tier]}
              </Badge>
              {events.some((e) => e.urgent) && <Badge tone="danger">有紧急动态</Badge>}
            </div>

            {/* 工商信息整块进糊层：「涉诉 N 件 · 近 5 年劳动争议相关」这一行
                单看就说得出用途，内层已有的 Sensitive 由外层接管 */}
            <dl data-veil="" className="mt-3 flex flex-col gap-1.5 text-[14px] leading-6">
              {node.creditCode && (
                <Field label="统一社会信用代码">
                  <Sensitive>
                    <span className="num">{node.creditCode}</span>
                  </Sensitive>
                </Field>
              )}
              {node.legalRep && (
                <Field label="法定代表人">
                  <Sensitive>{node.legalRep}</Sensitive>
                </Field>
              )}
              {node.regCapital && (
                <Field label="注册资本">
                  <span className="num">{node.regCapital}</span>
                </Field>
              )}
              {/* 口径写「已入档」而不是「近 5 年」：真数据里判决日期大量为空
                  （只有案号没有全文的条目照样入档），按 5 年截断会整批筛掉它们，
                  把涉诉多的公司显示得比实际干净。数字不截断，措辞就得跟着改。
                  取数口径见 lib/db/company-graph.ts 的 laborLitigationCounts。 */}
              <Field label="涉诉">
                <span className="num">{node.litigationCount} 件</span>
                <span className="ml-1 text-[13px] text-ink-2">已入档的劳动争议</span>
              </Field>
            </dl>
          </section>

          <section>
            <h4 className="text-[15px] font-semibold text-ink">为什么这样标</h4>
            {/* 判断原文里点着一串公司名和人名，低调模式下整块打码 */}
            <Sensitive as="div" className="mt-2 block">
              <blockquote className="rounded-r-[8px] border-l-4 border-primary bg-surface-2 px-3 py-2.5 text-[14px] leading-7 text-ink">
                {node.note}
              </blockquote>
            </Sensitive>
            <p data-veil="" className="mt-1.5 text-[13px] leading-6 text-ink-2">
              依据：公开检索与裁判文书
            </p>
          </section>

          <section>
            <h4 className="text-[15px] font-semibold text-ink">
              关联关系
              <span className="num ml-2 text-[13px] font-normal text-ink-2">
                {links.length} 条
              </span>
            </h4>
            <ul className="mt-2 flex flex-col gap-3">
              {links.map(({ edge, outgoing, other }) => (
                <li key={`${edge.from}->${edge.to}`} data-veil="">
                  <p className="text-[14px] leading-6 text-ink">
                    {outgoing && <span className="text-ink-2">这家 → </span>}
                    {other ? (
                      <button
                        type="button"
                        onClick={() => onSelect(other.id)}
                        className="text-left text-primary-ink underline underline-offset-2"
                      >
                        <Sensitive>{other.name}</Sensitive>
                      </button>
                    ) : (
                      '未知主体'
                    )}
                    {!outgoing && <span className="text-ink-2"> → 这家</span>}
                  </p>
                  <p className="mt-0.5 text-[14px] leading-6 text-ink-2">
                    {edge.relation}
                  </p>
                  <span className="mt-1 inline-block">
                    <Badge tone={CONFIDENCE_TONE[edge.confidence]}>
                      置信度 {edge.confidence}
                    </Badge>
                  </span>
                  {edge.note && (
                    <p className="mt-1 text-[13px] leading-6 text-ink-2">{edge.note}</p>
                  )}
                </li>
              ))}
              {links.length === 0 && (
                <li className="text-[14px] leading-6 text-ink-2">
                  还没查到这家与其它主体的关系，只作快照存档。
                </li>
              )}
            </ul>
          </section>

          <section>
            <h4 className="text-[15px] font-semibold text-ink">近期事件</h4>
            <ul className="mt-2 flex flex-col gap-3">
              {events.map((e) => (
                <li key={e.id} data-veil="">
                  <p className="num text-[13px] leading-6 text-ink-2">
                    {formatDate(e.happenedAt)} · {e.kind}
                  </p>
                  <p className="text-[15px] leading-6 font-medium text-ink">
                    {e.title}
                    {e.urgent && (
                      <span className="ml-2 align-middle">
                        <Badge tone="danger">紧急</Badge>
                      </span>
                    )}
                  </p>
                  <Sensitive as="div" className="mt-0.5 block text-[14px] leading-6 text-ink-2">
                    {e.detail}
                  </Sensitive>
                </li>
              ))}
              {events.length === 0 && (
                <li className="text-[14px] leading-6 text-ink-2">
                  这家近期没有新的公开动态，按圈层节奏继续盯。
                </li>
              )}
            </ul>
          </section>
        </div>
      )}
    </AppSheet>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-ink-2">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}
