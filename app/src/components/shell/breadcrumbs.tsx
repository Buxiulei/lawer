'use client';

import Link from 'next/link';
import { Fragment } from 'react';
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
  href?: string;
}

/**
 * 面包屑只用固定的栏目名，不带案件标题、公司名和金额——
 * 顶栏是最容易被旁人瞥见的一条，低调模式下这里不能有额外信息可泄。
 */
export function crumbsFor(pathname: string, caseId: string): Crumb[] {
  if (pathname === '/intake') {
    return [{ label: '工作台', href: `/case/${caseId}` }, { label: '首诊' }];
  }
  if (pathname === '/account') return [{ label: '我的' }];
  if (pathname.startsWith('/settings')) {
    return [{ label: '我的', href: '/account' }, { label: '设置' }];
  }

  const rest = pathname.replace(`/case/${caseId}`, '');
  const workbench = { label: '工作台', href: `/case/${caseId}` };

  // 只做两级：详情页停在所属栏目，不把文书名/文件名放进顶栏——那里面有公司名。
  if (rest.startsWith('/evidence')) return [workbench, { label: '证据' }];
  if (rest.startsWith('/docs')) return [workbench, { label: '文件解读' }];
  if (rest.startsWith('/drafts')) return [workbench, { label: '文书' }];
  return [{ label: '工作台' }];
}

export function Breadcrumbs({
  pathname,
  caseId,
}: {
  pathname: string;
  caseId: string;
}) {
  const crumbs = crumbsFor(pathname, caseId);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => (
          <Fragment key={crumb.label}>
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {crumb.href ? (
                <BreadcrumbLink asChild>
                  <Link href={crumb.href}>{crumb.label}</Link>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
