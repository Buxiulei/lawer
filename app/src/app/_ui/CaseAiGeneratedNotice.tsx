'use client';

// app/src/app/_ui/CaseAiGeneratedNotice.tsx
// 案件路由下的显式标识：自己去问这个案子属于哪个领域，取后半截那句话。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量。见 AiGeneratedNotice.tsx 文件头。
// ─────────────────────────────────────────────────────
//
// 【为什么要单独一层】对话页与文书页各写一次 `packOf(useCaseDomain(id))` 的形态是：
// 写两次忘一次，而忘掉的那一处照常渲染出前半截、看着像"标识在的"——
// 只是那句话在这个行当里说的是另一件事。取法与 NodeSheet / DocActions 同一条。
import { packOf } from '@/app/_ui/domain';
import { useCaseDomain } from '@/app/_ui/caseDomain';

import { AiGeneratedNotice } from './AiGeneratedNotice';

export function CaseAiGeneratedNotice({
  caseId,
  className,
}: {
  caseId: string;
  className?: string;
}) {
  const disclaimer = packOf(useCaseDomain(caseId)).copy.pages.aiLabelDisclaimer ?? '';
  return <AiGeneratedNotice disclaimer={disclaimer} className={className} />;
}
