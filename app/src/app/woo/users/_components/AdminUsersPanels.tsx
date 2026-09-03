'use client';

// /woo/users 两块面板的**唯一**协调点。
//
// ── 为什么要有这么一层 ──
// 上面的待审队列和下面的账号管理台看的是同一批人：审核落定那一刻，账号表里那一行的
// 「实名状态」变了、「最近操作」多了一行审计。可两块各自取各自的数——不串一声，
// 操作者面前就是"上面说通过了、下面还写着待审"。他会以为没生效，再点一次（拿到
// 400 BAD_STATE），或者养成"每次都手动刷新"的习惯，而那正是这一页要替他省掉的事。
//
// ── 为什么不写在 page.tsx 里 ──
// page.tsx 是服务端组件（要 export metadata：后台不许被搜索引擎收录）。
// 服务端组件不能把回调函数递给客户端组件，所以「谁审完了」这一声必须在客户端接。
// 这一层只做这一件事：拿一个计数，审完就 +1，往下传。两块面板各自的取数、
// 各自的 404 处置都留在原地，一块不通照旧不拖垮另一块。
import { useState } from 'react';

import { AdminUsersView } from './AdminUsersView';
import { RealnamePendingQueue } from './RealnamePendingQueue';

export function AdminUsersPanels() {
  // 单调递增的一个数，不是布尔：连审两条时布尔翻不回去，第二次就不会触发重取。
  const [reviewed, setReviewed] = useState(0);

  return (
    <>
      <RealnamePendingQueue onReviewed={() => setReviewed((n) => n + 1)} />
      <AdminUsersView refreshKey={reviewed} />
    </>
  );
}
