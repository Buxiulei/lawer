// app/src/app/layout.tsx
// 最小根布局占位。视觉设计（字体/配色/AppShell/PWA）归前端窗口（WS3），此处只保证 build 可过。
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '裁员应对专员',
  description: '劳动仲裁全程陪跑：问诊建档、行动建议、文书起草、证据固化。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hans">
      <body>{children}</body>
    </html>
  );
}
