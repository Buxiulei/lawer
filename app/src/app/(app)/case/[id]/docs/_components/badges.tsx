import { Badge, type BadgeTone } from '@/components/shadcn/badge';
import type { CompanyDoc, CompanyDocType } from '@/app/_mock/types';

/** 文件类型徽标一律中性色：颜色留给结论，不给分类。 */
export function DocTypeBadge({ docType }: { docType: CompanyDocType }) {
  // 类型名本身就是「协商协议」「解除通知」这类用途词，跟着正文一起进糊层
  return <Badge data-veil="" tone="neutral">{docType}</Badge>;
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

/**
 * 结论的字色。**只给字色不填色**——填色是批 1 行动卡那一档的标记，
 * 结论若也填色，两者会在同一页上抢同一种"最重"的读法。
 *
 * 「不签」用 danger 是红色在本产品里的**合法用途**（风险条款、不可逆动作）；
 * 其余三档避开红。字色一律取 `-ink` 档：它们是为「压在浅底上的小字」调的，
 * 实测压在标题栏底 `--surface-2` 上分别是
 * 不签 4.55 / 改签 4.64 / 待定 4.83 / 签 5.96（浅色），均 ≥4.5。
 */
export const ADVICE_INK: Record<Advice, string> = {
  签: 'text-success-ink',
  不签: 'text-danger-ink',
  改签: 'text-amber-ink',
  待定: 'text-ink-2',
};

export function RiskCountBadge({ count }: { count: number }) {
  if (count === 0) return <Badge tone="neutral">无标红条款</Badge>;
  return <Badge tone="neutral">{count} 处标红</Badge>;
}
