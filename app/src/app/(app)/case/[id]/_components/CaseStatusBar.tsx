'use client';

import { useEffect, useState } from 'react';
import { DeadlineChip } from '@/components/case/DeadlineChip';
import { Badge } from '@/components/shadcn/badge';
import { demoCaseStatus, fetchCaseStatus, hasStatus, type CaseStatus } from './caseStatus';

/**
 * 阶段 + 最近截止日。**卷宗栏排开之后**这两条在那一栏的档案里都有，就不再重复。
 * 判据跟着卷宗栏走（容器 ≥920）而不是视口 xl——否则会出现「1279 收起侧栏，
 * 卷宗栏已经排开、这条却还在」的重复。档案入口本身已经上移到壳层顶栏。
 *
 * 【数据从哪来】演示案件走 mock，其余现查接口（见 caseStatus）。
 * 取不到就整条不出现——这一格是提要不是主体，为它在对话页上弹一个错误不值当；
 * 但**绝不拿演示值顶**：读到「仲裁准备」和一个别人的到期日，比什么都不显示坏得多。
 */
export function CaseStatusBar({ caseId, demo }: { caseId: string; demo: boolean }) {
  const [status, setStatus] = useState<CaseStatus | null>(demo ? demoCaseStatus() : null);

  useEffect(() => {
    if (demo) {
      setStatus(demoCaseStatus());
      return;
    }
    let alive = true;
    setStatus(null);
    void fetchCaseStatus(caseId)
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch(() => {
        // 取不到＝这一条不出现。静默是有意的，见上面的注释
        if (alive) setStatus(null);
      });
    return () => {
      alive = false;
    };
  }, [caseId, demo]);

  if (!hasStatus(status)) return null;
  return <CaseStatusBarBody status={status} />;
}

/** 画法单独一层：不取数、不认 demo，好让「这一条画的是不是真数据」验得出来 */
export function CaseStatusBarBody({ status }: { status: CaseStatus }) {
  return (
    <section className="mb-4 overflow-hidden rounded-[12px] @min-[990px]/work:hidden">
      {/* 分量 4：金色填色顶栏 + 白底内容、**无外框**。
          没有外框是刻意的——行动卡才是「实边框 + 填色顶栏」那一档，
          期限只有顶栏，两者在灰度下也分得开（验收第 2、3 条）。
          金色不用红：红只留给风险条款与不可逆操作。

          **顶栏用淡金 --gold-wash 而不是规格写的深金 --gold**：实测 --ink(#2b1f1a)
          压在深金(#8a7340)上只有 **3.68:1**，14px 正文过不了 4.5；换淡金(#f5e6c8)是
          **13.59:1**。深色模式下同理（淡金档 #2e2717 配浅色 ink 是 12.4:1，
          而深金 #c9a75b 配浅 ink 只有 1.6:1，更糟）。
          顺带的好处：淡金底比行动卡的勃艮第实底轻，**分量 4 在 5 之下这件事因此更明显**。 */}
      <h2 className="bg-gold-wash px-3.5 py-1.5 text-[14px] font-semibold text-ink">
        当前阶段与最近期限
      </h2>
      <div className="flex flex-wrap items-center gap-2 bg-surface px-3.5 py-2.5">
        {/* data-veil 不挂在外层：filter 会拽走 fixed 子孙。
            Badge 又不透传 props，只好在它外面包一层 inline-flex */}
        {status.stage !== null && (
          <span data-veil="" className="inline-flex">
            <Badge tone="primary">{status.stage}</Badge>
          </span>
        )}
        {status.nearestDueAt !== null && <DeadlineChip dueAt={status.nearestDueAt} showDate />}
      </div>
    </section>
  );
}
