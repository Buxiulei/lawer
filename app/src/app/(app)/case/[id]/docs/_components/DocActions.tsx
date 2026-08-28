'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useDiscreet } from '@/app/_ui/discreet';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { useToast } from '@/components/ui/Toast';

/**
 * 解读页底部行动：接着聊 / 把这份文件收进证据库。
 * 两个动作都不会被公司看到，不需要二次确认。
 */
export function DocActions({ caseId, docTitle }: { caseId: string; docTitle: string }) {
  const toast = useToast();
  const { discreet } = useDiscreet();
  const [added, setAdded] = useState(false);
  // 这个按钮必须看得懂才能点，不能进糊层：低调模式下换成中性词
  const libWord = discreet ? NEUTRAL_WORD.evidenceLib : '证据库';

  return (
    <Card className="p-4">
      <h2 className="fs-m font-semibold text-ink">接下来</h2>
      <p data-veil="" className="prose-measure mt-1 fs-m text-ink-2">
        对某一条还有疑问，或者想让人帮你把回复的原话写出来，去「问它」接着说。这份文件本身建议收进证据库，仲裁时要用。
      </p>
      <div className="mt-3.5 flex flex-col gap-2 sm:flex-row">
        <Button asChild>
          <Link href={`/case/${caseId}/ask`}>去问它细聊</Link>
        </Button>
        <Button
          variant="secondary"
          disabled={added}
          onClick={() => {
            setAdded(true);
            toast(`《${docTitle}》已加入证据库`, 'success', '已保存到资料库');
          }}
        >
          {added ? `已加入${libWord}` : `加入${libWord}`}
        </Button>
      </div>
    </Card>
  );
}
