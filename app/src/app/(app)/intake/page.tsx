import type { Metadata } from 'next';
import { IntakeFlow } from './_components/IntakeFlow';

export const metadata: Metadata = { title: '首诊' };

export default function IntakePage() {
  return <IntakeFlow />;
}
