import Link from 'next/link';
import { NeutralLabel } from '@/app/_ui/NeutralLabel';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Button } from '@/components/shadcn/button';
import { EmptyState } from '@/components/shadcn/empty-state';

/**
 * 真实案件的文件解读页。**现在恒是空态，这是当前后端的实情**：
 * company_docs 这张表在库里建好了，但整个仓里没有任何一条写入它的生产代码路径
 * （只有测试往里插过行），上传-解读那条流水线还没接。
 *
 * 所以这里不给「上传文件」按钮：同目录的 UploadSheet 是演示件——它跑四步假进度、
 * 不落文件，最后把人送到样张 cd_2。挂在真实案件上就是一个走完全程、
 * 结果拿别家公司的协议冒充「你的解读结果」的按钮。
 * 通路接上之前，能给的只有两个真去处：对话与证据库。
 */
export function DocsEmpty({ caseId }: { caseId: string }) {
  return (
    <div className="pt-1">
      <header className="py-3">
        <h1 className="fs-xl font-semibold text-ink">文件解读</h1>
        <p className="fs-s mt-0.5 text-ink-2">
          公司让你签的东西，先看清楚再决定。
        </p>
      </header>

      <EmptyState
        title="还没有解读过的文件"
        description="逐条标红的解读还在接，现在这一页只会是空的。手里已经有解除通知、协商协议或调岗通知，先传进证据库存好；想马上知道该不该签，把原文说给它听，它当场逐条给你结论。"
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link href={`/case/${caseId}/ask`}>
                去<NeutralLabel plain="问它" neutral={NEUTRAL_WORD.ask} />
              </Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href={`/case/${caseId}/evidence`}>传进证据库</Link>
            </Button>
          </div>
        }
      />
    </div>
  );
}
