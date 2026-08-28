// app/src/app/page.tsx
// 落地页「案卷」版（批 5）：设计稿见 DESIGN.md 视觉方向 v3 的公链。
// 已登录的人不看这页——signedInRedirectScript 在首帧前把他送回工作台。
import Link from 'next/link';
import { DISCLAIMER_TEXT } from '@/app/_mock/authpay';
import { signedInRedirectScript } from '@/app/_ui/bootstrap';

/** 卷一的三张文书卡。**全部是示例**，卡上带「示例」角标，不留可被误读成真实数据的余地。 */
const DOCS = [
  {
    title: '该拿的钱，逐项算清',
    rows: [
      ['工作年限', '3 年 7 个月 → 按 4 年', false],
      ['月均工资', '¥18,000', false],
      ['经济补偿 N+1', '¥90,000', true],
    ] as const,
    basis: '每一项都写明依据——这一项：《劳动合同法》第四十七条，满六个月不满一年按一年计。',
  },
] as const;

/** 卷二：五步时间线，覆盖到强制执行。法条依据单独一行，与建议分开排。 */
const STEPS = [
  {
    no: '一',
    when: '今天',
    title: '先别急着签字',
    body: '把解除通知、聊天记录、工资条拍下来传上去。证据固化带权威时间戳——公司删了，你这份还在。',
  },
  {
    no: '二',
    when: '这几天',
    title: '把账算清，带着数字去谈',
    body: '按北京口径逐项算清该拿的钱，每项写明依据。和公司谈的时候，你手里是账，不是情绪。',
  },
  {
    no: '三',
    when: '谈不拢',
    title: '申请劳动仲裁，仲裁委不收费',
    body: '向朝阳区劳动人事争议仲裁委员会提交申请。申请书和证据清单，档案里已经替你备着。',
    law: '依据：《劳动争议调解仲裁法》第五十三条，劳动争议仲裁不收费。',
  },
  {
    no: '四',
    when: '立案后',
    title: '每个节点，提前告诉你',
    body: '仲裁庭应自受理起四十五日内审结。开庭前准备什么、庭上说什么，到点都排在你档案上面。',
    law: '依据：《劳动争议调解仲裁法》第四十三条。',
  },
  {
    no: '五',
    when: '裁决之后',
    title: '起诉或应诉，都接着排',
    body: '对裁决不服的一方——你，或者公司——都可以在收到裁决书起十五日内向法院起诉。公司起诉的，你就是被告：答辩、举证、开庭，每一步照样排进你的档案。一审、二审，直到生效。生效之后对方不给钱，申请法院强制执行，陪到钱到账。',
    law: '依据：《劳动争议调解仲裁法》第五十条。',
  },
] as const;

/** 卷三：三句摆在明面上的话。**收费一句写明按 token 计费，全页无「免费」承诺。** */
const PROMISES = [
  {
    head: '收费',
    em: '明码标价',
    body: '按对话消耗的 token 计费（公道值），价目公开可查；不卖课、不推销、不拿你的焦虑加价。',
  },
  {
    head: '证据',
    em: '只属于你',
    body: '上传的证据加密存放，固化带权威时间戳，随时可以自己验证。',
  },
  {
    head: '边界',
    em: '说在前面',
    body: '这里提供法律信息与行动建议，不构成律师意见、不形成委托代理关系。',
  },
] as const;

/**
 * 两颗 CTA。**窄屏拉满整列**（2026-08-28 用户红框：393 下靠左要居中）——
 * 拉满而不是让两颗不等宽的按钮居中：等宽居中在 <sm 会左右各留一小段空白、
 * 两颗宽度还不一样，看着像没对齐；拉满则边界与上方正文同一条竖线，是"排过版"的样子。
 * 顺带把热区从内容宽扩到整列宽，高度不变（仍是 py-[15px] + 17px 行高 ≥44）。
 * ≥sm 回到并排、按内容宽——桌面上拉满会变成两条横杠。
 */
function CtaRow({ center = false }: { center?: boolean }) {
  return (
    <div
      className={`flex flex-col gap-3.5 sm:flex-row sm:flex-wrap ${center ? 'sm:justify-center' : ''}`}
    >
      <Link
        href="/login"
        className="block w-full rounded-[6px] bg-primary px-8 py-[15px] text-center text-[17px] font-semibold text-on-primary shadow-[0_3px_0_var(--primary-ink)] transition-colors hover:bg-primary-ink sm:w-auto"
      >
        开始我的案件
      </Link>
      <Link
        href="/case/demo"
        className="block w-full rounded-[6px] border-[1.5px] border-ink px-8 py-[15px] text-center text-[17px] font-semibold text-ink transition-colors hover:bg-kraft sm:w-auto"
      >
        先看看演示案件
      </Link>
    </div>
  );
}

function SectionTab({ no, title }: { no: string; title: string }) {
  return (
    // 卷标题是 h2：页面层级必须 h1 → h2 → h3，缺一档 Lighthouse 判 heading-order 失败，
    // 屏幕阅读器按标题跳读时也会直接从 h1 掉进 h3
    <h2 className="anjuan-tab">
      <span className="font-serif-static text-[15px] font-black tracking-[0.2em] text-primary">
        {no}
      </span>
      <span className="font-serif-static text-[22px] font-black tracking-[0.05em]">{title}</span>
    </h2>
  );
}

export default function LandingPage() {
  return (
    <>
      {/* 正文之前同步执行：已登录就地跳走，不闪一下营销页 */}
      <script dangerouslySetInnerHTML={{ __html: signedInRedirectScript }} />

      <header className="border-b border-kraft-deep">
        <div className="mx-auto flex max-w-[1120px] items-center justify-between px-6 py-5">
          {/*
            徽章自带「土八鼠」中文字标，旁边不再另写一遍（2026-08-28 用户令）。
            源 `素材/品牌/土八鼠logo.png` 整枚徽章（alpha 裁边 70 0 1253 1167），压 WebP 192px。
            **尺寸 56/64 而不是 48**：实测 4× 放大逐档看，40px 的「鼠」是一团墨、
            48px 勉强认形，**56px 才看得出内部笔画**。字标是这里唯一的名字来源，
            读不出就等于没写——同「传不到就只是噪点」那条判据。
            名字由 alt 承担，不靠像素。
          */}
          <Link href="/" className="no-underline">
            <img
              src="/brand/badge-192.webp"
              alt="土八鼠"
              width={57}
              height={56}
              className="h-14 w-auto md:h-16"
            />
          </Link>
          <Link
            href="/case/demo"
            className="text-[14px] text-ink-2 underline underline-offset-4"
          >
            先看看演示案件
          </Link>
        </div>
      </header>

      <div className="pt-11 md:pt-[72px]">
        <div className="mx-auto grid max-w-[1120px] grid-cols-1 items-end gap-2 px-6 md:grid-cols-[7fr_5fr] md:gap-10">
          {/* 形象在窄屏排到文案之前：先看见"谁在陪你"，再看见那句问话 */}
          <figure className="anjuan-figure relative order-first text-center md:order-last">
            <picture>
              <source srcSet="/brand/tubashu-hero-640.webp" type="image/webp" />
              <img
                src="/brand/tubashu-hero-640.png"
                alt="土八鼠：一只戴眼镜的土拨鼠，穿西装打领带，一手举着劳动仲裁判决书，一手抱着中国劳动法"
                width={640}
                height={656}
                loading="eager"
                fetchPriority="high"
                className="relative z-[1] mx-auto block h-auto w-[min(62vw,300px)] md:w-[400px]"
              />
            </picture>
          </figure>

          <div className="relative order-last pb-11 md:order-first md:pb-16">
            <span className="inline-block rounded-t-[8px] border border-b-0 border-kraft-line bg-kraft px-[18px] pt-1.5 pb-[5px] text-[13px] font-semibold tracking-[0.28em] text-gold-on-kraft">
              北京 · 朝阳 · 劳动仲裁陪跑
            </span>
            <h1 className="font-serif-static mt-0 border-t-[3px] border-ink pt-[26px] text-[clamp(34px,5.2vw,58px)] leading-[1.32] font-black tracking-[0.02em] text-balance">
              被裁员了，不知道下一步？
              <br />
              <span className="text-primary">有人陪你，把每一步走完。</span>
            </h1>
            <p className="mt-[22px] max-w-[34em] text-[17px] text-ink-2">
              说清楚现在走到哪一步、公司给了什么说法，几分钟就能有一份属于你的档案。该拿的钱、在跑的期限、能直接改的文书草稿，都排在上面。
            </p>
            <div className="mt-[34px]">
              <CtaRow />
            </div>
            <p className="mt-3.5 text-[13.5px] text-ink-2">
              演示案件是虚构示例，不用注册就能翻完整个工作台。
            </p>

            <div
              aria-label="印章：土八鼠印"
              className="anjuan-stamp font-serif-static pointer-events-none absolute -top-[18px] right-0 grid size-[92px] place-items-center rounded-[8px] border-[3.5px] border-primary text-[23px] leading-[1.25] font-black tracking-[0.1em] text-primary opacity-[0.92] md:-top-[34px] md:right-[2%] md:size-[118px] md:text-[30px]"
            >
              <span className="w-[2.4em] text-center">土八鼠印</span>
            </div>
          </div>
        </div>
      </div>

      <hr className="border-0 border-t-[1.5px] border-kraft-deep" />

      {/* ── 卷一 ── */}
      <section className="pt-[76px]">
        <div className="mx-auto max-w-[1120px] px-6">
          <SectionTab no="卷一" title="几分钟后，你手里有的东西" />
          <div className="border-t-[1.5px] border-kraft-line pt-[34px]">
            <div className="overflow-hidden rounded-[10px] border border-kraft-line bg-linear-[175deg,var(--kraft)_0%,var(--kraft-deep)_100%] px-[18px] pt-[26px] pb-[30px] md:px-[34px] md:pt-[38px] md:pb-[42px]">
              <div className="grid grid-cols-1 items-stretch gap-[22px] md:grid-cols-3">
                {DOCS.map((d) => (
                  <article
                    key={d.title}
                    className="anjuan-doc relative rounded-[4px] border-t-4 border-primary bg-surface px-[22px] pt-5 pb-[22px] shadow-[0_2px_5px_rgba(43,35,32,.14),0_10px_24px_rgba(43,35,32,.08)]"
                  >
                    <span className="absolute top-3 right-3.5 rounded-[3px] border border-kraft-line px-1.5 py-px text-[11px] tracking-[0.1em] text-gold">
                      示例
                    </span>
                    <h3 className="font-serif-static mb-3 text-[17px] font-black tracking-[0.04em]">
                      {d.title}
                    </h3>
                    {d.rows.map(([k, v, hot]) => (
                      <div
                        key={k}
                        className="anjuan-row flex justify-between gap-3 py-[7px] text-[14px]"
                      >
                        <span className="text-ink-2">{k}</span>
                        <span
                          className={`font-mono-num font-semibold whitespace-nowrap tabular-nums ${hot ? 'text-primary' : ''}`}
                        >
                          {v}
                        </span>
                      </div>
                    ))}
                    <p className="mt-2.5 border-l-[3px] border-kraft-deep pl-2.5 text-[12.5px] leading-[1.6] text-ink-2">
                      {d.basis}
                    </p>
                  </article>
                ))}

                <article className="anjuan-doc relative rounded-[4px] border-t-4 border-primary bg-surface px-[22px] pt-5 pb-[22px] shadow-[0_2px_5px_rgba(43,35,32,.14),0_10px_24px_rgba(43,35,32,.08)]">
                  <span className="absolute top-3 right-3.5 rounded-[3px] border border-kraft-line px-1.5 py-px text-[11px] tracking-[0.1em] text-gold">
                    示例
                  </span>
                  <h3 className="font-serif-static mb-3 text-[17px] font-black tracking-[0.04em]">
                    在跑的期限，盯住
                  </h3>
                  <div className="py-1.5 text-center">
                    <div className="font-mono-num text-[44px] leading-[1.1] font-bold tabular-nums text-primary">
                      347
                    </div>
                    <div className="text-[14px] text-ink-2">
                      仲裁时效剩余天数（自离职起一年）
                    </div>
                  </div>
                  <div className="anjuan-row flex justify-between gap-3 py-[7px] text-[14px]">
                    <span className="text-ink-2">下一个到点</span>
                    <span className="font-mono-num font-semibold whitespace-nowrap tabular-nums text-primary">
                      3 天后
                    </span>
                  </div>
                  <p className="mt-3 text-[12.5px] text-ink-2">
                    到点之前提醒你，不让任何一个期限在你不知道的时候过去。
                  </p>
                </article>

                <article className="anjuan-doc relative rounded-[4px] border-t-4 border-primary bg-surface px-[22px] pt-5 pb-[22px] shadow-[0_2px_5px_rgba(43,35,32,.14),0_10px_24px_rgba(43,35,32,.08)]">
                  <span className="absolute top-3 right-3.5 rounded-[3px] border border-kraft-line px-1.5 py-px text-[11px] tracking-[0.1em] text-gold">
                    示例
                  </span>
                  <h3 className="font-serif-static mb-3 text-[17px] font-black tracking-[0.04em]">
                    直接能改的草稿
                  </h3>
                  <p className="anjuan-draftline font-serif-dynamic text-[14.5px] leading-[2]">
                    异议函：本人对《解除劳动合同通知书》所述解除理由不予认可，现书面提出异议如下……
                  </p>
                  <p className="mt-3 text-[12.5px] text-ink-2">
                    异议函、仲裁申请书、证据清单——给你的是能改能导出的稿，不是模板链接。
                  </p>
                </article>
              </div>
              <p className="mt-[26px] text-center text-[14px] text-gold-on-kraft">
                这三张纸，就是你档案的第一页。往后每发生一步，档案跟着长。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── 卷二 ── */}
      <section className="pt-[76px]">
        <div className="mx-auto max-w-[1120px] px-6">
          <SectionTab no="卷二" title="接下来每一步，都排着" />
          <div className="border-t-[1.5px] border-kraft-line pt-[34px]">
            <ol className="anjuan-steps max-w-[720px] list-none">
              {STEPS.map((s) => (
                <li key={s.no} data-no={s.no} className="relative pb-[34px] pl-[58px]">
                  <span className="text-[13px] font-semibold tracking-[0.18em] text-gold">
                    {s.when}
                  </span>
                  <h3 className="font-serif-static mt-0.5 mb-1.5 text-[19px] font-black tracking-[0.03em]">
                    {s.title}
                  </h3>
                  <p className="max-w-[36em] text-[15px] text-ink-2">{s.body}</p>
                  {'law' in s && s.law && (
                    <p className="mt-1 text-[12.5px] text-ink-2">{s.law}</p>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* ── 卷三 ── */}
      <section className="pt-[76px]">
        <div className="mx-auto max-w-[1120px] px-6">
          <SectionTab no="卷三" title="三句放在明面上的话" />
          <div className="border-t-[1.5px] border-kraft-line pt-[34px]">
            <div className="grid grid-cols-1 overflow-hidden rounded-[8px] border-[1.5px] border-ink md:grid-cols-3">
              {PROMISES.map((p, i) => (
                <div
                  key={p.head}
                  className={`px-7 py-[26px] ${i > 0 ? 'border-t-[1.5px] border-kraft-deep md:border-t-0 md:border-l-[1.5px]' : ''}`}
                >
                  <h3 className="font-serif-static mb-2 text-[18px] font-black">
                    {p.head}
                    <em className="not-italic text-primary">{p.em}</em>
                  </h3>
                  <p className="text-[14.5px] text-ink-2">{p.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="px-6 pt-[84px] pb-[72px] text-center">
        <div className="mx-auto max-w-[1120px]">
          <h2 className="font-serif-static text-[clamp(26px,3.6vw,38px)] font-black tracking-[0.03em] text-balance">
            现在走到哪一步了？
            <br />
            说给它听，几分钟后你有一份档案。
          </h2>
          <div className="mt-[34px]">
            <CtaRow center />
          </div>
        </div>
      </div>

      <footer className="border-t border-kraft-deep px-6 pt-[26px] pb-10 text-center text-[13px] text-ink-2">
        <div className="mx-auto max-w-[1120px]">{DISCLAIMER_TEXT}</div>
      </footer>
    </>
  );
}
