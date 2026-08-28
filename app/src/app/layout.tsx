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
    default: '土八鼠',
    template: '%s · 土八鼠',
  },
  description: '劳动仲裁全程陪跑：问诊建档、行动建议、文书起草、证据固化。',
  applicationName: '土八鼠',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: '陪跑',
    statusBarStyle: 'default',
  },
  icons: {
    // 全部由用户提供的原图裁切而来，不用手绘简化版（2026-08-28 用户拍板）。
    // apple-touch 只给 PNG：Safari 不吃 WebP 的 apple-touch-icon。
    icon: [
      { url: '/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.webp', sizes: '192x192', type: 'image/webp' },
    ],
    apple: [{ url: '/icon-180.png', sizes: '180x180', type: 'image/png' }],
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
        {/* 衬线子集预加载：@font-face 里的字体要等 CSS 解析完才被发现，
            preload 让它与文档并行下载。**这一条是试出来的不是抄来的**——
            LCP 里 82% 是 Render Delay，preload 能不能收回要看实测。 */}
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          href="/fonts/tubashu-serif-700.woff2"
          crossOrigin="anonymous"
        />
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
