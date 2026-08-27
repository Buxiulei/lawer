import { Badge, type BadgeTone } from '@/components/shadcn/badge';
import type { EvidenceStatus } from '@/app/_mock/types';

const TONE: Record<EvidenceStatus, BadgeTone> = {
  已上传: 'neutral',
  已固化: 'success',
  已出证: 'primary',
};

export function EvidenceBadge({ status }: { status: EvidenceStatus }) {
  return <Badge tone={TONE[status]}>{status}</Badge>;
}

/**
 * 常驻提示：固化不替代原件，原始载体必须自己留着。
 *
 * 借 GOV.UK Inset text——**左侧一条竖线、不填色**。
 * 此前是一整块填色公告，每次进证据页都占掉首屏一大块；
 * 而它是"一直成立的背景知识"，不是"这次要你做的事"，不该有那个分量。
 * 填色这一档留给批 1 的行动卡。
 *
 * 第二句（交回原件前先自己留一份）收进 Details：它只在被要求交原件时才用得上，
 * 常驻会稀释第一句。**折叠不等于藏起来**，摘要行本身就说明了里面是什么。
 */
export function OriginalMediumNotice() {
  return (
    <div data-veil="" className="border-l-4 border-line pl-3">
      <p className="fs-s text-ink-2">
        固化只锁定文件内容与时间，不替代原件。原始载体（纸质件、手机里的录音和聊天记录）请自己保留到案件结束。
      </p>
      <details className="mt-1">
        <summary className="flex min-h-11 cursor-pointer list-none items-center fs-s text-primary-ink marker:hidden">
          公司要求交回原件怎么办
        </summary>
        <p className="mb-2 fs-s text-ink-2">
          先自己拍照或复印留一份再交。交回之后你手上就只剩复制件，固化记录能证明内容和时间，但证明不了原件长什么样。
        </p>
      </details>
    </div>
  );
}
