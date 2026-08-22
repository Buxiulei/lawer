import { Badge, type BadgeTone } from '@/components/ui/Badge';
import type { EvidenceStatus } from '@/app/_mock/types';

const TONE: Record<EvidenceStatus, BadgeTone> = {
  已上传: 'neutral',
  已固化: 'success',
  已出证: 'primary',
};

export function EvidenceBadge({ status }: { status: EvidenceStatus }) {
  return <Badge tone={TONE[status]}>{status}</Badge>;
}

/** 常驻提示条：固化不替代原件，原始载体必须自己留着。 */
export function OriginalMediumNotice() {
  return (
    <p
      data-veil=""
      className="rounded-[10px] bg-surface-2 px-3 py-2 text-[14px] leading-6 text-ink-2"
    >
      固化只锁定文件内容与时间，不替代原件。原始载体（纸质件、手机里的录音和聊天记录）请自己保留到案件结束。
    </p>
  );
}
