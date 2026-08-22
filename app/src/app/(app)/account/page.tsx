import type { Metadata } from 'next';
import { AccountView } from './_components/AccountView';

export const metadata: Metadata = { title: '我的' };

export default function AccountPage() {
  return <AccountView />;
}
