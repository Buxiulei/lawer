'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { caseIdFromPath } from '@/app/_ui/currentCase';
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/alert';
import { Button } from '@/components/shadcn/button';

/**
 * 全站 404：所有 `notFound()` 的落点。
 *
 * 这一页在 (app) 路由组里是**只换正文**的——顶栏、演示横幅、底部 Tab 由外层布局照旧渲染
 * （证据：`draft-detail_notfound_404.png` 里壳层完好，只有正文是框架自带的英文 404），
 * 所以这里只出一张卡，不铺整页版式。
 *
 * 文案照证据库 loadError 卡的三段式：出了什么事 / 为什么 / 现在能做什么。
 * **不进低调糊层**：整段没有案件名、公司名、金额，糊掉只会让唯一的解释也读不了。
 */
export default function NotFound() {
  const pathname = usePathname() ?? '/';
  // 404 页没有案件上下文，取路径里的 id；非案件页兜底到 demo（回驾驶舱总得有个去处）
  const caseId = caseIdFromPath(pathname) ?? 'demo';

  return (
    <div className="pt-6">
      <Alert>
        <AlertTitle>这个地址上没有内容。</AlertTitle>
        <AlertDescription className="mt-1">
          链接里的编号可能抄漏了一位或已经过期，也可能这份材料确实被删掉了。
        </AlertDescription>
        <Button size="sm" className="mt-3" asChild>
          <Link href={`/case/${caseId}`}>回驾驶舱</Link>
        </Button>
      </Alert>
    </div>
  );
}
