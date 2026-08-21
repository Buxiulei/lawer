// app/src/app/page.tsx
// 落地页：没登录的人第一次到站看到的那一屏。
// 已登录的人不看这页——signedInRedirectScript 在首帧前把他送回工作台。
import Link from 'next/link';
import { DISCLAIMER_TEXT } from '@/app/_mock/authpay';
import { signedInRedirectScript } from '@/app/_ui/bootstrap';
import { Button } from '@/components/shadcn/button';
import { LampMark } from '@/components/shell/LampMark';

/** 落地页说的是"到站第一眼看到什么"，逐条对应产品真做得到的事，不写做不到的 */
const WHAT_HAPPENS = [
  '按北京口径把该拿的钱逐项算清楚，每一项写明依据。',
  '把在跑的期限盯住，仲裁时效、答复期限，到点之前提醒你。',
  '异议函、仲裁申请书、证据清单，直接给你能改的草稿。',
];

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      {/* 正文之前同步执行：已登录就地跳走，不闪一下营销页 */}
      <script dangerouslySetInnerHTML={{ __html: signedInRedirectScript }} />

      <div className="w-full max-w-[420px]">
        <header>
          <div className="flex items-center gap-2.5">
            <LampMark className="size-7 text-primary" />
            <span className="text-[18px] font-semibold text-ink">裁员应对专员</span>
          </div>

          <h1 className="prose-measure mt-7 text-[26px] leading-10 font-semibold text-ink">
            被裁员了，不知道下一步？这里有人陪你把每一步走完。
          </h1>
          <p className="prose-measure mt-4 text-[15px] leading-7 text-ink-2">
            说清楚现在走到哪一步、公司给了什么说法，几分钟就能有一份属于你的档案。往后每一天该做什么，都排在上面。
          </p>
        </header>

        <ul className="mt-6 flex flex-col gap-2.5">
          {WHAT_HAPPENS.map((line) => (
            <li
              key={line}
              className="rounded-[10px] bg-surface-2 px-3.5 py-3 text-[15px] leading-7 text-ink"
            >
              {line}
            </li>
          ))}
        </ul>

        <div className="mt-7 flex flex-col gap-3">
          <Button asChild className="w-full">
            <Link href="/login">开始我的案件</Link>
          </Button>
          <Button asChild variant="secondary" className="w-full">
            <Link href="/case/demo">先看看演示案件</Link>
          </Button>
          <p className="text-[13px] leading-6 text-ink-2">
            演示案件是虚构的示例，不用注册就能翻完整个工作台。
          </p>
        </div>
      </div>

      <footer className="mt-10 w-full max-w-[420px] text-[13px] leading-6 text-ink-2">
        {DISCLAIMER_TEXT}
      </footer>
    </div>
  );
}
