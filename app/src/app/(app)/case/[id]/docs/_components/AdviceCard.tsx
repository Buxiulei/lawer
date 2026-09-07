import { Card } from '@/components/shadcn/card';
import { cn } from '@/components/shadcn/utils';
import type { CompanyDoc } from '@/app/_mock/types';
import { CaseAiGeneratedNotice } from '@/app/_ui/CaseAiGeneratedNotice';
import { ADVICE_SUMMARY } from './badges';
import { SensitiveText } from './SensitiveText';

type Advice = CompanyDoc['advice'];

/**
 * 签 / 不签 / 改签 / 待定 四态大卡：结论要在 3 秒内被看到。
 * 「不签」用 danger 底 + 左边线，与正文里被标红的条款是同一套视觉语言；
 * 其余三态不占用红色。
 */
const SKIN: Record<Advice, { box: string; word: string; line: string }> = {
  签: {
    box: 'bg-success-wash border-transparent',
    word: 'text-success',
    line: 'bg-success',
  },
  不签: {
    box: 'bg-danger-wash border-transparent',
    word: 'text-danger',
    line: 'bg-danger',
  },
  改签: {
    box: 'bg-amber-wash border-transparent',
    word: 'text-amber',
    line: 'bg-amber',
  },
  待定: {
    box: 'bg-surface-2 border-transparent',
    word: 'text-ink',
    line: 'bg-ink-2',
  },
};

/**
 * 【为什么标识挂在这一件里，而不是挂在两个调用方的页面上】这张卡的每一个字——
 * 签/不签的结论、那段说明、逐条改签要点——都是模型读完文件之后写的。
 * 它有两个调用方（演示样张页与真实解读页），各写一遍标识的形态是：
 * 写两次忘一次，而忘掉的那一页照常渲染出一张四态大卡，看不出少了什么。
 * 收在这里之后，"有没有标识"与"有没有这张卡"是同一件事。
 *
 * @param caseId 问哪个案子的领域（标识后半截随行当变）。**必填**：让它可省的形态是
 *   某个调用方不传，那一页的后半句静静退回缺省领域的行当话。
 */
export function AdviceCard({
  caseId,
  advice,
  detail,
  revisePoints,
}: {
  caseId: string;
  advice: Advice;
  detail: string;
  revisePoints?: string[];
}) {
  const skin = SKIN[advice];

  return (
    <Card
      aria-label={`签署建议：${advice}`}
      className={cn('relative overflow-hidden pl-4 shadow-none', skin.box)}
    >
      <span className={cn('absolute inset-y-0 left-0 w-1', skin.line)} aria-hidden />

      <div data-veil="" className="px-4 py-4">
        <p className="fs-xs font-medium text-ink-2">签署建议</p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <strong className={cn('fs-xl font-semibold', skin.word)}>
            {advice}
          </strong>
          <span className="fs-m text-ink">{ADVICE_SUMMARY[advice]}</span>
        </div>

        <p className="prose-measure mt-3 fs-m text-ink">
          <SensitiveText text={detail} />
        </p>

        {revisePoints && revisePoints.length > 0 && (
          <div className="mt-4 rounded-[10px] bg-card p-3.5">
            <h3 className="fs-m font-semibold text-ink">逐条改成这样再签</h3>
            <ol className="mt-2 flex flex-col gap-2">
              {revisePoints.map((point, i) => (
                <li key={i} className="flex gap-2.5 fs-m text-ink-2">
                  <span className="num mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 fs-xs font-semibold text-ink">
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <SensitiveText text={point} />
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {/* 建议段是模型写的：标识排在这张卡的末尾（标识办法 §4 第（一）项允许
          「在文本的起始、末尾或者中间适当位置」）。放在结论**之后**是有意的——
          这张卡的头等大事是三秒内看到"签/不签"，把提示插在结论之前会把它挤下去；
          而读到理由那一段的人，正好在这里读到"这是谁写的"。

          【为什么摆在 data-veil 那一块**外面**】糊层是 `filter: blur` 罩整棵子树：
          放进去的形态是，开着低调模式的人连「以下内容由人工智能生成合成」这半句
          也读不到，而 §4 要的正是"可以被用户明显感知到"。
          带行当的后半截自己进糊层（见 AiGeneratedNotice），不靠这一块罩。 */}
      <div className="px-4 pb-4">
        <CaseAiGeneratedNotice caseId={caseId} />
      </div>
    </Card>
  );
}
