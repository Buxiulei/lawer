// app/src/app/page.tsx
// 落地页：没登录的人第一次到站看到的那一屏。
// 已登录的人不看这页——signedInRedirectScript 在首帧前把他送回工作台。
import Link from 'next/link';
import { DISCLAIMER_TEXT } from '@/app/_mock/authpay';
import { signedInRedirectScript } from '@/app/_ui/bootstrap';
import { Button } from '@/components/shadcn/button';
import { TubashuMark } from '@/components/shell/TubashuMark';

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

      <div className="w-full max-w-[420px] md:max-w-[860px]">
        <header>
          <div className="flex items-center gap-2.5">
            <TubashuMark size={28} className="size-7" />
            <span className="text-[18px] font-semibold text-ink">土八鼠</span>
          </div>

          {/* ≥md 拉成两栏：文案在左、形象在右。窄屏仍是单列，形象排在标题之前——
              先看见"这是谁在陪你"，再看见那句问话。 */}
          <div className="mt-7 md:flex md:items-center md:gap-12">
            {/* hero 用那张 778KB 的 SVG（gzip 272KB）：**只有这一处用全身版**。
                独立文件不内联，好走缓存；eager + 固定宽高防 CLS。 */}
            <picture className="mx-auto block md:order-last md:mx-0 md:shrink-0">
              {/* **原图直出，不经描摹**（2026-08-28 用户裁定：描摹版退役）。
                  源 `土八鼠形象.png` 1239×1270 → 640 宽压 WebP 119KB；
                  手机显示 200px、桌面 320px，640 已覆盖桌面 2× DPR。
                  PNG 兜底给不支持 WebP 的浏览器（<picture> 只会取其中一个）。 */}
              <source srcSet="/brand/tubashu-hero-640.webp" type="image/webp" />
              <img
                src="/brand/tubashu-hero-640.png"
                alt="土八鼠：一只戴眼镜的土拨鼠，穿西装打领带，一手举着判决书，一手抱着法典"
                width={640}
                height={656}
                loading="eager"
                fetchPriority="high"
                className="block h-auto w-[200px] md:w-[320px]"
              />
            </picture>

            <div className="mt-6 md:mt-0 md:min-w-0 md:flex-1">
              <h1 className="prose-measure text-[26px] leading-10 font-semibold text-ink md:text-[34px] md:leading-[1.35]">
                被裁员了，不知道下一步？这里有人陪你把每一步走完。
              </h1>
              <p className="prose-measure mt-4 text-[15px] leading-7 text-ink-2">
                说清楚现在走到哪一步、公司给了什么说法，几分钟就能有一份属于你的档案。往后每一天该做什么，都排在上面。
              </p>
            </div>
          </div>
        </header>

        {/* 下半部分收回可读宽度：上面为 hero 把容器放宽到 860，
            但按钮和条目跟着拉满一整幅会很难读（也不像可点的东西）。 */}
        <div className="md:max-w-[520px]">
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
      </div>

      <footer className="mt-10 w-full max-w-[420px] text-[13px] leading-6 text-ink-2">
        {DISCLAIMER_TEXT}
      </footer>
    </div>
  );
}
