'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { useToast } from '@/components/ui/Toast';

/**
 * 解读页底部行动：接着聊 / 把这份文件收进证据库。
 * 两个动作都不会被公司看到，不需要二次确认。
 */
export function DocActions({ caseId, docTitle }: { caseId: string; docTitle: string }) {
  const toast = useToast();
  const [added, setAdded] = useState(false);

  return (
    <Card className="p-4">
      <h2 className="text-[15px] font-semibold text-ink">接下来</h2>
      <p data-veil="" className="prose-measure mt-1 text-[15px] leading-7 text-ink-2">
        对某一条还有疑问，或者想让人帮你把回复的原话写出来，去工作台接着说。这份文件本身建议收进证据库，仲裁时要用。
      </p>
      <div className="mt-3.5 flex flex-col gap-2 sm:flex-row">
        <Button asChild>
          <Link href={`/case/${caseId}`}>去工作台细聊</Link>
        </Button>
        <Button
          variant="secondary"
          disabled={added}
          onClick={() => {
            setAdded(true);
            toast(`《${docTitle}》已加入证据库`, 'success', '已保存到资料库');
          }}
        >
          {added ? '已加入证据库' : '加入证据库'}
        </Button>
      </div>
    </Card>
  );
}
