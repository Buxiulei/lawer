// app/src/app/layout.tsx
// 根布局：字体/配色 token、主题与低调模式的首屏落定、PWA metadata。
// AppShell 不在这里挂——它只包 (app) 路由组，/login 与 /verify 走裸布局。
import type { Metadata, Viewport } from 'next';
import {
  discreetBootstrapScript,
  themeBootstrapScript,
} from '@/app/_ui/bootstrap';
import { DiscreetProvider } from '@/app/_ui/discreet';
import { ThemeProvider } from '@/app/_ui/theme';
import { ToastProvider } from '@/components/ui/Toast';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: '裁员应对专员',
    template: '%s · 裁员应对专员',
  },
  description: '劳动仲裁全程陪跑：问诊建档、行动建议、文书起草、证据固化。',
  applicationName: '裁员应对专员',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: '陪跑',
    statusBarStyle: 'default',
  },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/icon-maskable.svg', type: 'image/svg+xml' }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFCF5' },
    { media: '(prefers-color-scheme: dark)', color: '#171310' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hans" suppressHydrationWarning>
      <head>
        {/* 首屏前落定主题与低调模式，避免闪白和金额一闪而过 */}
        <script
          dangerouslySetInnerHTML={{
            __html: themeBootstrapScript + discreetBootstrapScript,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <DiscreetProvider>
            <ToastProvider>{children}</ToastProvider>
          </DiscreetProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
