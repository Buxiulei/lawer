import type { Metadata } from 'next';
import { ConnectGuide } from './_components/ConnectGuide';

/** 标题本身就是中性的，低调模式下也不必换——它不含任何案情词 */
export const metadata: Metadata = { title: '接入你自己的助手' };

export default function AgentConnectPage() {
  return <ConnectGuide />;
}
