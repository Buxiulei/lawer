import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { demoCase } from '@/app/_mock/demo';

export default function AppGroupLayout({ children }: { children: ReactNode }) {
  // 接后端前，案件标题取自 mock；后续由 params 取当前 case。
  return <AppShell caseTitle={demoCase.title}>{children}</AppShell>;
}
