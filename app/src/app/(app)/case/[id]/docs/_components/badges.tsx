import { Badge, type BadgeTone } from '@/components/ui/Badge';
import type { CompanyDoc, CompanyDocType } from '@/app/_mock/types';

/** 文件类型徽标一律中性色：颜色留给结论，不给分类。 */
export function DocTypeBadge({ docType }: { docType: CompanyDocType }) {
  return <Badge tone="neutral">{docType}</Badge>;
}

type Advice = CompanyDoc['advice'];

export const ADVICE_TONE: Record<Advice, BadgeTone> = {
  签: 'success',
  不签: 'danger',
  改签: 'amber',
  待定: 'neutral',
};

/** 结论一句话：徽标旁边跟着它，避免只有一个字看不懂。 */
export const ADVICE_SUMMARY: Record<Advice, string> = {
  签: '核对无误后可以签，签完自己留一份',
  不签: '这一版不要签，签了会让后面的主张变难',
  改签: '条款改掉之后再签，逐条改法见下',
  待定: '现在还不用做决定，先按下面的方式回复',
};

export function AdviceBadge({ advice }: { advice: Advice }) {
  return <Badge tone={ADVICE_TONE[advice]}>{advice}</Badge>;
}

export function RiskCountBadge({ count }: { count: number }) {
  if (count === 0) return <Badge tone="neutral">无标红条款</Badge>;
  return <Badge tone="neutral">{count} 处标红</Badge>;
}
