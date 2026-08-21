import { Badge, type BadgeTone } from '@/components/shadcn/badge';
import type { Draft, DraftKind } from '@/app/_mock/types';

/** 文书类型是分类，用中性色；颜色留给状态。 */
export function DraftKindBadge({ kind }: { kind: DraftKind }) {
  return <Badge tone="neutral">{kind}</Badge>;
}

const STATUS_TONE: Record<Draft['status'], BadgeTone> = {
  草稿: 'neutral',
  待定稿: 'primary',
  已发出: 'success',
};

export function DraftStatusBadge({ status }: { status: Draft['status'] }) {
  return <Badge tone={STATUS_TONE[status]}>{status}</Badge>;
}
