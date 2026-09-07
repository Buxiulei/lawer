import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AI_LABELING_TERMS_HREF,
  AI_LABELING_TERMS_LINK_TEXT,
} from '@/app/_ui/aiLabelingTerms';
import { TERMS_HREF, TERMS_TITLE } from '@/app/_ui/termsLinks';
import { termsLive } from '@/lib/auth/consent';
import { TubashuMark } from '@/components/shell/TubashuMark';
import { LoginFlow } from './_components/LoginFlow';

export const metadata: Metadata = { title: '登录' };

/**
 * 【为什么这一页从静态预渲染改成了每次现渲】它现在要读协议生效旗（见
 * lib/auth/consent.termsLive）决定摆不摆那三个勾选框。被静态预渲染的形态是：旗**烙进构建产物**——运维打开旗、
 * 重启进程，登录页一点变化都没有，而没有任何一处报错，只有服务端那道闸开始拦人，
 * 于是所有人都注册不了，现象却是"开关没生效"。
 *
 * 【为什么不像领域清单那样走一条端点现问】那一条是浏览器挂载后才问得到的，
 * 首帧一律当"还不知道"。放在这里的代价是同一批框会先不见、再出现（旗开着时），
 * 或者先出现、再消失（旗关着时）——而这一组框正是注册的前置条件，闪一下就是
 * "我明明勾了它却又变回没勾"。旗是**部署期**的常量，本来就该在服务端一次读定。
 */
export const dynamic = 'force-dynamic';

/**
 * 登录：手机号或邮箱，验一个就进；只有新号注册那一次要接着补绑邮箱。裸布局，不套 AppShell。
 */
export default function LoginPage() {
  // 旗只在服务端读得到（见 lib/auth/consent.termsLive 抬头），这里读一次往下递。
  const live = termsLive();
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <header className="mb-7">
          <div className="flex items-center gap-2.5">
            <TubashuMark size={28} className="size-7" />
            <span className="text-[18px] font-semibold text-ink">土八鼠</span>
          </div>
          {/* 引言那一句不在这里：它说的是**眼前这一格**要填什么，得跟着通道换，
              而这一页是**无状态**的服务端组件：通道是客户端的 state，它换不动。
              见 LoginFlow 的 CHANNEL_INTRO。 */}
        </header>

        <LoginFlow termsLive={live} />
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
            形态是：同意已经生效了，条款才第一次出现在他眼前。

            【为什么这一句跟着旗走】它是一句**断言**——"你注册就等于同意了那份协议"。
            协议还没生效时它不成立：那时没有勾选框、服务端也不据它拦人，页面却告诉用户
            他已经同意了一份还在改的文本。留着它的形态是：三个框拿掉了，而"你已经同意"
            这句话原样留在页脚，没有任何一处会报错。 */}
        {live && (
          <>
            <br />
            注册即表示你同意
            <Link href={TERMS_HREF} className="mx-1 text-primary-ink underline underline-offset-4">
              《{TERMS_TITLE}》
            </Link>
            ，其中与你有重大利害关系的条款已加粗。
          </>
        )}
      </footer>
    </div>
  );
}
