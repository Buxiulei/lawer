'use client';

import { useMemo, useState } from 'react';
import { estimateClaims, previewActions } from '@/app/_mock/intake-evidence';
import { formatDate } from '@/app/_ui/format';
import { AmountText } from '@/components/case/AmountText';
import { ActionGroup } from '@/components/case/ActionCard';
import { Badge } from '@/components/shadcn/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/shadcn/card';
import { Sensitive } from '@/components/Sensitive';
import type { SanbeiCap } from '@/lib/cap/sanbei';
import type { ActionItem } from '@/app/_mock/types';
import type { IntakeDraft } from './draft';

/**
 * 档案预览。**封顶基数由外面传进来**（服务端从知识卡取的当前值），
 * 这一页不再拿 `_mock/demo.ts` 里那个封顶常量当法定封顶线——它是给演示案件叙事用的，
 * 却一直参与着真实用户的金额估算。来源与口径见 lib/cap/sanbei（守卫见 lib/cap/__tests__）。
 */
export function StepPreview({ draft, cap }: { draft: IntakeDraft; cap: SanbeiCap | null }) {
  const estimate = useMemo(
    () =>
      estimateClaims({
        stage: draft.stage,
        hiredOn: draft.hiredOn,
        monthlyWageYuan: Number.parseFloat(draft.monthlyWage),
        goals: draft.goals,
        cap,
      }),
    [draft.stage, draft.hiredOn, draft.monthlyWage, draft.goals, cap],
  );

  const actions = useMemo(() => previewActions(draft.stage), [draft.stage]);
  const [done, setDone] = useState<Record<string, boolean>>({});

  const known = estimate.rows.filter((r) => r.amountFen !== null);
  const total = known.reduce((sum, r) => sum + (r.amountFen ?? 0), 0);
  const eventCount = draft.events.filter((e) => e.text.trim()).length;
  const otherGoals = draft.goals.filter(
    (g) => !estimate.rows.some((r) => r.key === g || r.label === g),
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader data-veil="" className="items-center">
          <CardTitle>
            <Sensitive>
              {draft.companyName ? `${draft.companyName} · 应对档案` : '我的应对档案'}
            </Sensitive>
          </CardTitle>
          {draft.stage && (
            <CardAction>
              <Badge tone="primary">{draft.stage}</Badge>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          <dl data-veil="" className="grid grid-cols-2 gap-x-4 gap-y-3 text-[15px]">
            <Meta label="管辖" value="北京 · 朝阳区" />
            <Meta
              label="入职时间"
              value={draft.hiredOn ? formatDate(`${draft.hiredOn}T00:00:00+08:00`) : '待补'}
            />
            <Meta label="岗位" value={draft.position || '待补'} />
            <Meta
              label="工龄折算"
              value={estimate.serviceYears > 0 ? `${estimate.serviceYears} 年` : '待补'}
            />
            <Meta label="合同签署" value={draft.contractCount || '待补'} />
            <Meta
              label="时间线"
              value={
                eventCount > 0 || draft.freeText.trim()
                  ? `${eventCount} 条${draft.freeText.trim() ? ' + 一段自述' : ''}`
                  : '待补'
              }
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>预估诉求金额</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y divide-line">
            {estimate.rows.map((row) => (
              <li key={row.key} data-veil="" className="flex flex-col gap-1 py-3 first:pt-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[15px] leading-7 font-medium text-ink">
                    {row.label}
                  </span>
                  {row.amountFen === null ? (
                    <Badge tone="amber">待补材料</Badge>
                  ) : (
                    <Sensitive>
                      <AmountText fen={row.amountFen} size="sm" />
                    </Sensitive>
                  )}
                </div>
                <p className="text-[14px] leading-6 text-ink-2">{row.note}</p>
              </li>
            ))}
          </ul>

          {known.length > 1 && (
            <div
              data-veil=""
              className="mt-3 flex items-baseline justify-between gap-3 rounded-[10px] bg-primary-wash px-3.5 py-3"
            >
              <span className="text-[15px] font-medium text-primary-ink">
                已能算出的部分合计
              </span>
              <Sensitive>
                <AmountText fen={total} size="md" />
              </Sensitive>
            </div>
          )}

          <p
            data-veil=""
            className="mt-3 border-l-4 border-primary bg-surface-2 px-3.5 py-2.5 text-[14px] leading-6 text-ink-2"
          >
            {estimate.capNote}
          </p>
          <p data-veil="" className="mt-2 text-[14px] leading-6 text-ink-2">
            {estimate.incompleteReason === 'inputs'
              ? '回到第 2 步补上入职时间和月工资，这里就会算出具体金额。'
              : estimate.incompleteReason === 'cap'
                ? '封顶基数取不到，所以这次没算金额——这是我们这边的问题，其余内容照常存进档案。'
                : '这是按你刚才填的数字先算的一版。传上工资流水和劳动合同后，基数和年限会自动校正，金额也会跟着变。'}
          </p>

          {otherGoals.length > 0 && (
            <p data-veil="" className="mt-2 text-[14px] leading-6 text-ink-2">
              另外记下的诉求：{otherGoals.join('、')}。这几项不折算成钱，会写进仲裁请求。
            </p>
          )}
        </CardContent>
      </Card>

      <section>
        {actions.length > 0 ? (
          <ActionGroup
            title="现在做这三件事"
            items={actions.map((a) => withStatus(a, done[a.id]))}
            onToggle={(id, checked) => setDone((prev) => ({ ...prev, [id]: checked }))}
          />
        ) : (
          <p className="rounded-[10px] bg-surface-2 px-3.5 py-3 text-[15px] leading-7 text-ink-2">
            回到第 1 步选一下你现在所处的阶段，这里会给出对应的三件事。
          </p>
        )}
      </section>

      {draft.bottomLine.trim() && (
        <Card data-veil="" className="border-transparent bg-surface-2 shadow-none">
          <CardContent className="pt-4">
            <p className="text-[13px] font-medium text-ink-2">你写下的底线</p>
            <p className="prose-measure mt-1 text-[15px] leading-7 text-ink">
              {draft.bottomLine}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function withStatus(item: ActionItem, checked: boolean | undefined): ActionItem {
  return checked ? { ...item, status: '完成' } : item;
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-ink-2">{label}</dt>
      <dd className="truncate text-[15px] text-ink">{value}</dd>
    </div>
  );
}
