// app/src/lib/cases/paging.ts
// 清单类 REST 端点的翻页入参与回包外壳。四条清单端点共用，保证「一页多大、下一页从哪开始」
// 只有一种写法——各写一份的形态是：一条端点的 limit 封顶到 200、另一条没封，
// 而两条端点的文档写的是同一句话。
import { NextResponse } from 'next/server';

import { LIST_DEFAULT_LIMIT } from './index';

/** ?limit= / ?offset= 解析。缺省 limit = 50；非法值当作没传，不夹成 1（夹成 1 更难察觉） */
export function pageParams(url: URL): { limit: number; offset: number } {
  const raw = Number(url.searchParams.get('limit'));
  const rawOffset = Number(url.searchParams.get('offset'));
  return {
    // 封顶交给 lib/cases 的 paginate（正本在那里，这里再封一次就是第二份口径）
    limit: Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : LIST_DEFAULT_LIMIT,
    offset: Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0,
  };
}

/**
 * 分页回包。`items` 是这一页，`total` 是过滤后的真总数，`next_offset` 没有下一页时为 null。
 *
 * 【为什么还留着 legacyKey】页面早就在读 `evidence` / `actions` / `deadlines` 这几个键。
 * 只换成 `items` 的形态是：端点回 200、结构合法，而页面上那一栏空了——没有任何一处报错。
 * 两个键指向同一个数组，不是两份数据。
 */
export function pageResponse<T>(
  legacyKey: string,
  page: { items: T[]; total: number; offset: number; next_offset: number | null },
): NextResponse {
  return NextResponse.json({
    ok: true,
    items: page.items,
    total: page.total,
    offset: page.offset,
    next_offset: page.next_offset,
    [legacyKey]: page.items,
  });
}
