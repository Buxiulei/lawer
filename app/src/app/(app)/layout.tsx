import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';

export default function AppGroupLayout({ children }: { children: ReactNode }) {
  // 标题不在这一层定：这个布局包着 /case/[id]、/account、/settings、/intake，
  // 拿不到 [id] 段，只有壳层（客户端、看得见 pathname）知道当前是哪个案件。
  // 这里曾经恒传演示案件标题，于是所有挂壳层的页面标签页都写着别家公司名。
  return <AppShell>{children}</AppShell>;
}
