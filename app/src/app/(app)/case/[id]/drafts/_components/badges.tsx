import { Badge, type BadgeTone } from '@/components/shadcn/badge';
import type { Draft, DraftKind } from '@/app/_mock/types';

/** 文书类型是分类，用中性色；颜色留给状态。 */
export function DraftKindBadge({ kind }: { kind: DraftKind }) {
  // 类型名本身就是「仲裁申请书」这类用途词，跟着正文一起进糊层
  return <Badge data-veil="" tone="neutral">{kind}</Badge>;
}

const STATUS_TONE: Record<Draft['status'], BadgeTone> = {
  草稿: 'neutral',
  待定稿: 'primary',
  已发出: 'success',
};

export function DraftStatusBadge({ status }: { status: Draft['status'] }) {
  return <Badge tone={STATUS_TONE[status]}>{status}</Badge>;
}
