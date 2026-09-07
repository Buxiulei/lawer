import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AI_LABELING_TERMS_HREF,
  AI_LABELING_TERMS_LINK_TEXT,
} from '@/app/_ui/aiLabelingTerms';
import { TERMS_HREF, TERMS_TITLE } from '@/app/_ui/termsLinks';
import { TubashuMark } from '@/components/shell/TubashuMark';
import { LoginFlow } from './_components/LoginFlow';

export const metadata: Metadata = { title: '登录' };

/**
 * 登录：手机号或邮箱，验一个就进；只有新号注册那一次要接着补绑邮箱。裸布局，不套 AppShell。
 */
export default function LoginPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <header className="mb-7">
          <div className="flex items-center gap-2.5">
            <TubashuMark size={28} className="size-7" />
            <span className="text-[18px] font-semibold text-ink">土八鼠</span>
          </div>
          {/* 引言那一句不在这里：它说的是**眼前这一格**要填什么，得跟着通道换，
              而这一页是无状态的服务端组件（/login 要保持静态预渲染），换不动。
              见 LoginFlow 的 CHANNEL_INTRO。 */}
        </header>

        <LoginFlow />
      </div>

      <footer className="mt-10 w-full max-w-[420px] text-[13px] leading-6 text-ink-2">
        手机号与身份信息加密存储，只用于验证、通知和存证出具。
        {/* 注册就是在这一页发生的：标识办法 §8 要的"提示用户仔细阅读"得摆在这之前，
            不是等他建完档案再说。 */}
        <br />
        平台的回复与文书由人工智能生成，发出前请读一遍
        <Link
          href={AI_LABELING_TERMS_HREF}
          className="mx-1 text-primary-ink underline underline-offset-4"
        >
          {AI_LABELING_TERMS_LINK_TEXT}
        </Link>
        。
        {/* 注册在这一页发生，而协议是"勾选同意"的那一份：民法典 §496 第二款要的"合理方式
            提示对方注意"，前提是他在按下按钮之前**读得到**它。只在注册完成后才给入口的
            形态是：同意已经生效了，条款才第一次出现在他眼前。 */}
        <br />
        注册即表示你同意
        <Link href={TERMS_HREF} className="mx-1 text-primary-ink underline underline-offset-4">
          《{TERMS_TITLE}》
        </Link>
        ，其中与你有重大利害关系的条款已加粗。
      </footer>
    </div>
  );
}
