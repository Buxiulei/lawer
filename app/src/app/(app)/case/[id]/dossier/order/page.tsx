import type { Metadata } from 'next';
import { OrderQuote } from './_components/OrderQuote';

export const metadata: Metadata = { title: '建档报价' };

export default async function DossierOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <OrderQuote caseId={id} />;
}
