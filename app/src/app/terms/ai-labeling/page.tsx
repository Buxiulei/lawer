import type { Metadata } from 'next';
import Link from 'next/link';

import { AiGeneratedNotice } from '@/app/_ui/AiGeneratedNotice';
import { AI_LABEL_ATTRIBUTE, AI_LABEL_PROVIDER } from '@/lib/ai-label';
import { TubashuMark } from '@/components/shell/TubashuMark';

// app/src/app/terms/ai-labeling/page.tsx
// 用户服务协议里的**标识条款**（《人工智能生成合成内容标识办法》第八条：
//「服务提供者应当在用户服务协议中明确说明生成合成内容标识的方法、样式等规范内容，
//  并提示用户仔细阅读并理解相关的标识管理要求。」）
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量：这一页在**注册之前**就要能读，那时还没有案件、
// 也就没有领域可问。标识那句话的后半截（"不构成哪一种专业意见"）随档案领域变，
// 所以这一页只说它的**构成**，样例只摆领域中立的前半截。
// ─────────────────────────────────────────────────────
//
// 【为什么单起一页，不塞进登录页脚】§8 要的是"明确说明方法与样式"——那是几百字，
// 塞在登录页脚的形态是：它在，但没有人读得下去，而"读不下去"与"没写"在合规上同形。
// 登录页与首页各留一条指过来的链接（注册/首次使用处可见）。
//
// 【条号与原件的关系】本页引用的每一个条号都对应一份登记过 sha256 的官方原件
// （source_id: statute-ai-shengcheng-hecheng-neirong-biaoshi-banfa，
//  官方 URL https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm；
//  原件登记与逐字抄录随知识库扎根那一支进仓，本支只引条号）。
// 改条号要先回去核那份原件，不许照记忆改。

export const metadata: Metadata = {
  title: '生成合成内容标识说明',
  description:
    '本平台如何为人工智能生成合成内容添加显式标识与隐式标识，以及使用者的标识义务。',
};

function Section({ no, title, children }: { no: string; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-[17px] font-semibold text-ink">
        <span className="num mr-2 text-ink-2">{no}</span>
        {title}
      </h2>
      <div className="prose-measure mt-2 flex flex-col gap-3 text-[14.5px] leading-7 text-ink-2">
        {children}
      </div>
    </section>
  );
}

export default function AiLabelingTermsPage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[760px] flex-col px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-b border-line pb-5">
        <div className="flex items-center gap-2.5">
          <TubashuMark size={24} className="size-6" />
          <span className="text-[15px] font-semibold text-ink">土八鼠</span>
        </div>
        <h1 className="mt-4 text-[21px] font-semibold text-ink sm:text-[24px]">
          生成合成内容标识说明
        </h1>
        <p className="prose-measure mt-2 text-[14px] leading-7 text-ink-2">
          本说明依《人工智能生成合成内容标识办法》第八条写给你，是用户服务协议里
          关于生成合成内容标识的那一节。请仔细阅读并理解下列标识管理要求。
        </p>
      </header>

      <main className="flex-1">
        <Section no="一" title="哪些内容会被标识">
          <p>
            本平台的对话回复、由对话生成的文书草稿，以及这些内容的分享页与导出文件，
            都是由人工智能生成合成的文本。它们全部按下面第二、三节加标识。
          </p>
          <p>
            你自己上传的材料、以及《存证证明》里的文件哈希、可信时间戳、你自己填写的说明，
            都不是人工智能生成的内容，因此不加这类标识——给它们挂上「由人工智能生成」，
            会让一份本来可以拿出去用的材料被误当成机器编的。
          </p>
        </Section>

        <Section no="二" title="显式标识的方法与样式（办法第四条）">
          <p>
            办法第四条第（一）项要求，对文本类生成合成内容，
            「在文本的起始、末尾或者中间适当位置添加文字提示或者通用符号提示等标识，
            或者在交互场景界面、文字周边添加显著的提示标识」。本平台的做法是：
          </p>
          <ul className="ml-4 flex list-disc flex-col gap-1.5">
            <li>对话界面：消息列上方持续可见一条提示，不随对话滚走、不可关闭。</li>
            <li>文书草稿页与免登录分享页：正文之前同样一条提示。</li>
            <li>
              导出的 PDF：正文之前印一段带框的提示文字
              （办法第四条末款：「服务提供者提供生成合成内容下载、复制、导出等功能时，
              应当确保文件中含有满足要求的显式标识。」）
            </li>
          </ul>
          <p>样式如下，其中前半句逐字固定：</p>
          <AiGeneratedNotice disclaimer="" />
          <p>
            提示语后面还会跟一句「不构成哪一种专业意见」——这半句随你档案所属的领域变，
            在页面与文件上与前半句连着出现。
          </p>
        </Section>

        <Section no="三" title="隐式标识的方法（办法第五条）">
          <p>
            办法第五条要求在文件元数据中添加隐式标识，包含
            「生成合成内容属性信息、服务提供者名称或者编码、内容编号等制作要素信息」。
            本平台导出的 PDF 在文件信息字典中写入这三项：
          </p>
          <ul className="ml-4 flex list-disc flex-col gap-1.5">
            <li>
              属性信息（Subject）：<span className="num">{AI_LABEL_ATTRIBUTE}</span>
            </li>
            <li>
              服务提供者名称（Producer）：{AI_LABEL_PROVIDER}
            </li>
            <li>
              内容编号（Keywords）：这一份文件在本平台的唯一编号，含版本号。
            </li>
          </ul>
          <p>
            这几项用任何 PDF 阅读器的「文档属性」都能看到。它们在显式提示被删掉之后仍然留着，
            是这份文件出自何处的最后一条线索。
          </p>
        </Section>

        <Section no="四" title="你的标识义务（办法第十条）">
          <p>
            你把本平台生成的内容发布到别处时，办法第十条要求你
            「主动声明并使用服务提供者提供的标识功能进行标识」——最省事的做法是保留我们已经加上的那句提示。
          </p>
          <p>
            同一条还规定：任何组织和个人
            「不得恶意删除、篡改、伪造、隐匿本办法规定的生成合成内容标识，
            不得为他人实施上述恶意行为提供工具或者服务，不得通过不正当标识手段损害他人合法权益」。
          </p>
          <p>
            办法第九条允许服务提供者在用户协议明确标识义务与使用责任之后，
            提供不含显式标识的内容。本平台今天没有这个开关——所有导出件一律带标识，
            也就没有相应的约定。需要这类文件请先联系我们。
          </p>
        </Section>

        <Section no="五" title="这一页说的话去哪里核对">
          <p>
            上面引用的条文出自《人工智能生成合成内容标识办法》
            （国信办通字〔2025〕2号，2025 年 9 月 1 日施行），原件在国家互联网信息办公室官网。
            本说明如与办法原文不一致，以原文为准。
          </p>
        </Section>
      </main>

      <footer className="mt-10 border-t border-line pt-5 text-[13px] leading-6 text-ink-2">
        <Link href="/" className="text-primary-ink underline underline-offset-4">
          回到首页
        </Link>
      </footer>
    </div>
  );
}
