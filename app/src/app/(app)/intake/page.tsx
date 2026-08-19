import type { Metadata } from 'next';
import { PagePlaceholder } from '@/components/shell/PagePlaceholder';

export const metadata: Metadata = { title: '首诊' };

export default function IntakePage() {
  return (
    <PagePlaceholder
      pageName="首诊"
      description="问诊清单、自动建档与诉求初算的引导流程正在开发中。"
    />
  );
}
