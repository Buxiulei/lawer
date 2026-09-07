import type { Metadata } from 'next';
import Link from 'next/link';

import { AiGeneratedNotice } from '@/app/_ui/AiGeneratedNotice';
import { AI_LABELING_TERMS_TITLE } from '@/app/_ui/aiLabelingTerms';
import { AI_LABEL_ATTRIBUTE, AI_LABEL_PROVIDER } from '@/lib/ai-label';
import { TubashuMark } from '@/components/shell/TubashuMark';

import { LAW_QUOTES, type LawQuote } from './quotes';

// app/src/app/terms/ai-labeling/page.tsx
// 《人工智能生成合成内容标识办法》第八条要求的那一节规范说明。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量：这一页在**注册之前**就要能读，那时还没有案件、
// 也就没有领域可问。标识那句话的后半截（"不构成哪一种专业意见"）随档案领域变，
// 所以这一页只说它的**构成**，样例只摆领域中立的前半截。
// ─────────────────────────────────────────────────────
//
// 【它现在不自称"用户服务协议的一节"】§8 说的是"在用户服务协议中明确说明"。
// 本平台的用户服务协议还没起草，这一页先独立存在——**先把该说的说清楚，
// 比先摆一个协议的架子重要**。此前这一页开头写着"是用户服务协议里的那一节"，
// 那是一句在协议本身不存在时无法成立的话：读的人会去找那份协议，
// 而它一处都不在。所以自称改成「规范说明（用户服务协议起草后并入）」——
// 缺什么（协议未起草）、为什么缺（还没写）、怎么办（起草后并入）三样都写在标题里。
//
// 【为什么单起一页，不塞进登录页脚】§8 要的是"明确说明方法与样式"——那是几百字，
// 塞在登录页脚的形态是：它在，但没有人读得下去，而"读不下去"与"没写"在合规上同形。
// 登录页与首页各留一条指过来的链接（注册/首次使用处可见）。
//
// 【条号与原件的关系】本页每一段引文都逐字取自登记过 sha256 的官方原件，
// 出处写在 quotes.ts 里，由 app/__tests__/ai-labeling-quotes.test.ts 逐条机械核对。
// 改引文只能从 knowledge/sources/originals/<source_id>/text.txt 复制，不许照记忆敲。

export const metadata: Metadata = {
  title: AI_LABELING_TERMS_TITLE,
  description:
    '本平台如何为人工智能生成合成内容添加显式标识与隐式标识，适用的法条链条，以及使用者的标识义务。',
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

/**
 * 一段逐字引文。**条款位置与原文一起印**：只印原文的形态是，
 * 读的人核不回去（一份规章几十条，凭一段话找不到它在哪）。
 */
function Quote({ q, law }: { q: LawQuote; law: string }) {
  return (
    <blockquote className="border-l-2 border-line pl-3 text-[14px] leading-7 text-ink">
      <span className="text-ink-2">
        {law}
        {q.at}：
      </span>
      「{q.text}」
    </blockquote>
  );
}

const BANFA = '《人工智能生成合成内容标识办法》';
const SHENDU = '《互联网信息服务深度合成管理规定》';

export default function AiLabelingTermsPage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[760px] flex-col px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-b border-line pb-5">
        <div className="flex items-center gap-2.5">
          <TubashuMark size={24} className="size-6" />
          <span className="text-[15px] font-semibold text-ink">土八鼠</span>
        </div>
        <h1 className="mt-4 text-[21px] font-semibold text-ink sm:text-[24px]">
          {AI_LABELING_TERMS_TITLE}
        </h1>
        <p className="prose-measure mt-2 text-[14px] leading-7 text-ink-2">
          本说明依{BANFA}第八条写给你，说明本平台生成合成内容标识的方法、样式等规范内容。
          请仔细阅读并理解下列标识管理要求。本平台的用户服务协议尚未起草；协议起草后，
          这一节将整体并入其中，在此之前它独立生效。
        </p>
      </header>

      <main className="flex-1">
        <Section no="一" title="这些要求为什么适用于本平台">
          <p>
            {BANFA}第四条并不直接说"哪些服务要加标识"，它指向另一份规章：
          </p>
          <Quote q={LAW_QUOTES.banfa4Head} law={BANFA} />
          <p>而那一款列的第一项，正是本平台在做的事：</p>
          <Quote q={LAW_QUOTES.shendu17Head} law={SHENDU} />
          <Quote q={LAW_QUOTES.shendu17Item1} law={SHENDU} />
          <p>
            本平台提供的是对话式问答与由对话生成的文书草稿——{' '}
            <strong className="font-semibold text-ink">
              智能对话、智能写作等模拟自然人进行文本的生成或者编辑服务
            </strong>
            ，落在{SHENDU}第十七条第一款第（一）项上。因此{BANFA}
            第四条（显式标识）与第五条（隐式标识）对本平台适用。
          </p>
          <p>
            隐式标识那一跳同理：{BANFA}第五条要求"按照{SHENDU}第十六条的规定"在文件元数据中添加隐式标识，
            而第十六条是这么写的——
          </p>
          <Quote q={LAW_QUOTES.shendu16} law={SHENDU} />
        </Section>

        <Section no="二" title="哪些内容会被标识">
          <p>
            本平台的对话回复、由对话生成的文书草稿、个案报告与文件解读的建议段，
            以及这些内容的分享页与导出文件，都是由人工智能生成合成的文本。
            它们全部按下面第三、四节加标识。
          </p>
          <p>
            你自己上传的材料、以及《存证证明》里的文件哈希、可信时间戳、你自己填写的说明，
            都不是人工智能生成的内容，因此不加这类标识——给它们挂上「由人工智能生成」，
            会让一份本来可以拿出去用的材料被误当成机器编的。
          </p>
        </Section>

        <Section no="三" title={`显式标识的方法与样式（${BANFA}第四条）`}>
          <p>第四条第一款第（一）项对文本类生成合成内容的要求是：</p>
          <Quote q={LAW_QUOTES.banfa4Item1} law={BANFA} />
          <p>本平台的做法是：</p>
          <ul className="ml-4 flex list-disc flex-col gap-1.5">
            <li>对话界面：消息列上方持续可见一条提示，不随对话滚走、不可关闭。</li>
            <li>文书草稿页、个案报告页与免登录分享页：正文之前同样一条提示。</li>
            <li>文件解读页：模型给出的签署建议那张卡里，同样一条提示。</li>
            <li>导出的 PDF：正文之前印一段带框的提示文字。</li>
          </ul>
          <p>最后一项对应的是第四条第二款：</p>
          <Quote q={LAW_QUOTES.banfa4Tail} law={BANFA} />
          <p>样式如下，其中前半句逐字固定：</p>
          <AiGeneratedNotice disclaimer="" />
          <p>
            提示语后面还会跟一句「不构成哪一种专业意见」——这半句随你档案所属的领域变，
            在页面与文件上与前半句连着出现。
          </p>
        </Section>

        <Section no="四" title={`隐式标识的方法（${BANFA}第五条）`}>
          <p>第五条第一款要求：</p>
          <Quote q={LAW_QUOTES.banfa5} law={BANFA} />
          <p>本平台导出的 PDF 在文件信息字典中写入这三项：</p>
          <ul className="ml-4 flex list-disc flex-col gap-1.5">
            <li>
              属性信息（Subject）：<span className="num">{AI_LABEL_ATTRIBUTE}</span>
            </li>
            <li>服务提供者名称（Producer）：{AI_LABEL_PROVIDER}</li>
            <li>内容编号（Keywords）：这一份文件在本平台的唯一编号，含版本号。</li>
          </ul>
          <p>
            这几项用任何 PDF 阅读器的「文档属性」都能看到。它们在显式提示被删掉之后仍然留着，
            是这份文件出自何处的最后一条线索。
          </p>
        </Section>

        <Section no="五" title={`你的标识义务（${BANFA}第十条）`}>
          <p>你把本平台生成的内容发布到别处时：</p>
          <Quote q={LAW_QUOTES.banfa10Duty} law={BANFA} />
          <p>最省事的做法是保留我们已经加上的那句提示。同一条第二款还规定：</p>
          <Quote q={LAW_QUOTES.banfa10Ban} law={BANFA} />
          <p>第九条允许服务提供者提供不含显式标识的内容：</p>
          <Quote q={LAW_QUOTES.banfa9} law={BANFA} />
          <p>
            本平台今天没有这个开关——所有导出件一律带标识，也就没有相应的约定。
            需要这类文件请先联系我们。
          </p>
        </Section>

        <Section no="六" title="这一页说的话去哪里核对">
          <p>本页所依的那一条是：</p>
          <Quote q={LAW_QUOTES.banfa8} law={BANFA} />
          <p>
            上面逐字引用的条文分别出自{BANFA}
            （国信办通字〔2025〕2号，2025 年 9 月 1 日施行）与{SHENDU}
            （国家互联网信息办公室、工业和信息化部、公安部令第12号，2023 年 1 月 10 日施行），
            两份原件都在国家互联网信息办公室官网。本说明如与两份规章原文不一致，以原文为准。
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
