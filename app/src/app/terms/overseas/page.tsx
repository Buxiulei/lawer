import type { Metadata } from 'next';
import Link from 'next/link';

import {
  TERMS_HREF,
  TERMS_OVERSEAS_TITLE,
  TERMS_PROCESSORS_HREF,
  TERMS_PROCESSORS_TITLE,
  TERMS_TITLE,
} from '@/app/_ui/termsLinks';

import { Pending, Quote, Section, TermsShell } from '../_components/chrome';
import { TERMS_QUOTES as Q } from '../quotes';
import { OverseasDetails } from './OverseasDetails';

// app/src/app/terms/overseas/page.tsx
// 境外模型与个人信息出境的说明页（协议第五条第 5 款 /《个人信息保护法》第三十九条）。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量：开关在设置页，读这一页的人可能一个案件都没有。
// ─────────────────────────────────────────────────────
//
// 【为什么这一页要能不登录就读到】§39 的同意要"自愿、明确"，而一个人要先读得到告知
// 才谈得上自愿。把它藏在设置页开关后面的形态是：只有已经准备去点开关的人才看得到它，
// 而想先弄清楚"你们到底往境外发什么"再决定要不要注册的人，一处都读不到。
//
// 【这一页不是同意本身】同意在 <OverseasConsent/>（同目录），由设置页那个开关挂。
// 两处念的是同一段告知（OverseasDetails），理由见那个文件的头注释。

export const metadata: Metadata = {
  title: TERMS_OVERSEAS_TITLE,
  description:
    '境外接收方是谁、经谁接入、处理目的与方式、发过去的个人信息种类、哪几类在出境前被替换掉、以及你如何行使权利。',
};

export default function OverseasTermsPage() {
  return (
    <TermsShell
      title={TERMS_OVERSEAS_TITLE}
      lead={
        <>
          <p>
            本页是《{TERMS_TITLE}》第五条第 5 款的组成部分。
            <strong className="font-semibold text-ink">境外模型默认关闭</strong>
            ；这一项要你
            <strong className="font-semibold text-ink">单独勾选同意</strong>
            ——注册时那个单独的勾选框，或此后在设置里改。无论从哪一处开，我们都要先把下面这几项逐项告诉你，并单独取得你的同意。
          </p>
          <p>不开启的，你仍可使用仅境内模型的全部服务——这不是一个二选一的门槛。</p>
        </>
      }
      footer={
        <>
          <Link href={TERMS_HREF} className="text-primary-ink underline underline-offset-4">
            《{TERMS_TITLE}》
          </Link>
          <Link
            href={TERMS_PROCESSORS_HREF}
            className="text-primary-ink underline underline-offset-4"
          >
            {TERMS_PROCESSORS_TITLE}
          </Link>
        </>
      }
    >
      <Section no="一" title="这一页凭什么存在">
        <p>《个人信息保护法》第三十九条要求，向境外提供个人信息前要逐项告知并单独取得同意：</p>
        <Quote q={Q.gebaofa39} />
        <p>
          下面一节按这一条逐项写：接收方名称、联系方式、处理目的、处理方式、个人信息的种类，
          以及你向境外接收方行使权利的方式。
        </p>
      </Section>

      <Section no="二" title="逐项告知">
        <OverseasDetails />
      </Section>

      <Section no="三" title="替换掉的与替换不掉的">
        <p>
          出境前的替换只认<strong className="font-semibold text-ink">有形状的那几类</strong>
          （身份证号、手机号、银行卡号这种能被规则认出来的串）。
          姓名、公司名称与事实经过没有固定形状，认不出来，也就替换不掉——
          这不是我们偷懒，是这一类东西无法在不毁掉正文的前提下被机械识别。
        </p>
        <p>
          所以这一页把它明写出来：
          <strong className="font-semibold text-ink">
            你写进对话里的经过，会原样出境。
          </strong>
          这句话才是决定要不要开启的那一句。
        </p>
      </Section>

      <Section no="四" title="出境路径与备案">
        <p>
          《个人信息保护法》第三十八条对个人信息出境另有路径要求（安全评估、标准合同备案、
          个人信息保护认证三选一）。
          <strong className="font-semibold text-ink">
            那一条与本页的单独同意是两件事，谁也替代不了谁
          </strong>
          ：拿到了你的同意，不等于我们已经走完第三十八条那条路。
        </p>
        <p>
          本平台的开放时点与走哪一条路径尚未定：
          <Pending>
            待主理人确认：境外模型的开放时点与《个人信息保护法》第三十八条所需的出境路径（标准合同备案等）
          </Pending>
          在它被填上之前，这一页只是把该告知的先说清楚——境外模型仍然默认关闭。
        </p>
      </Section>
    </TermsShell>
  );
}
