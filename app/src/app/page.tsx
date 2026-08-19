// app/src/app/page.tsx
// 根路径直接进当前案件的工作台。多案件列表页出现前，先固定到 demo。
import { redirect } from 'next/navigation';

export default function HomePage() {
  redirect('/case/demo');
}
