'use client';

import Link from 'next/link';
import { Fragment } from 'react';
import { useDiscreet } from '@/app/_ui/discreet';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/shadcn/breadcrumb';

interface Crumb {
  label: string;
  /** 低调模式下顶替 label 的中性词；不给就是本来就中性的栏目名。 */
  discreetLabel?: string;
  href?: string;
}

/**
 * 面包屑只用固定的栏目名，不带案件标题、公司名和金额——
 * 顶栏是最容易被旁人瞥见的一条，低调模式下这里不能有额外信息可泄。
 */
export function crumbsFor(pathname: string, caseId: string): Crumb[] {
  if (pathname === '/intake') {
    return [
      { label: '驾驶舱', discreetLabel: NEUTRAL_WORD.dashboard, href: `/case/${caseId}` },
      { label: '首诊' },
    ];
  }
  if (pathname === '/account') return [{ label: '我的' }];
  if (pathname.startsWith('/settings')) {
    return [{ label: '我的', href: '/account' }, { label: '设置' }];
  }

  const rest = pathname.replace(`/case/${caseId}`, '');
  const home = {
    label: '驾驶舱',
    discreetLabel: NEUTRAL_WORD.dashboard,
    href: `/case/${caseId}`,
  };

  // 只做两级：详情页停在所属栏目，不把文书名/文件名放进顶栏——那里面有公司名。
  if (rest.startsWith('/ask'))
    return [home, { label: '问它', discreetLabel: NEUTRAL_WORD.ask }];
  if (rest.startsWith('/evidence'))
    return [home, { label: '证据', discreetLabel: NEUTRAL_WORD.evidence }];
  if (rest.startsWith('/graph'))
    return [home, { label: '公司图谱', discreetLabel: NEUTRAL_WORD.graph }];
  if (rest.startsWith('/docs')) return [home, { label: '文件解读' }];
  if (rest.startsWith('/drafts'))
    return [home, { label: '文书', discreetLabel: NEUTRAL_WORD.drafts }];
  return [{ label: '驾驶舱', discreetLabel: NEUTRAL_WORD.dashboard }];
}

export function Breadcrumbs({
  pathname,
  caseId,
}: {
  pathname: string;
  caseId: string;
}) {
  const crumbs = crumbsFor(pathname, caseId);
  const { discreet } = useDiscreet();

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => (
          <Fragment key={crumb.label}>
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {crumb.href ? (
                <BreadcrumbLink asChild>
                  <Link href={crumb.href}>{labelOf(crumb, discreet)}</Link>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{labelOf(crumb, discreet)}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function labelOf(crumb: Crumb, discreet: boolean): string {
  return discreet ? (crumb.discreetLabel ?? crumb.label) : crumb.label;
}
