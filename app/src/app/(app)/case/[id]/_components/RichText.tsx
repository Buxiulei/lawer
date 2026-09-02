'use client';

import { Children, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sensitive } from '@/components/Sensitive';

/**
 * 助手消息正文的 markdown 渲染。
 *
 * 【为什么换成真渲染器】此前这里是一个只认「段落 / 一层列表 / **加粗**」的手写解析器。
 * 模型照常写 `## 三步走`、`> 尊敬的人力资源部：`、`---`、引用块里再嵌一层 `1.`、
 * 以及赔偿金测算的表格——**这些一个都没被解析，符号原样躺在正文里**。
 * 用户读到的是「## 三步走」和「| 项目 | 金额 |」，那正是他要抄进仲裁申请书的段落。
 * 补规则补不完（嵌套列表、围栏代码、表格对齐行各有一堆边角），所以换真解析器。
 *
 * 【安全边界，说准一点】react-markdown 10 **默认就不把 raw HTML 变成 DOM**
 * （没挂 rehype-raw），所以这一处的 XSS 面本来就是关着的——本文件实测：
 * 不加 `skipHtml` 时 `<script>alert(1)</script>` 渲染成**转义后的可见文字**，
 * 不是可执行节点。因此：
 *  ① `skipHtml` 挡的是**观感**不是 XSS：没有它，模型偶尔吐出的 `<b>` 会以
 *     `&lt;b&gt;` 的样子糊在正文里，跟这次要修的"符号裸露"是同一类毛病。
 *     把它说成安全阀是**高估**，而高估同样是错——下一个人会据此以为这里有道锁。
 *  ② `urlTransform` 才是真在挡事的那道：`javascript:` 一类协议一律成空 href，
 *     下面的 `a` 组件再把空 href 的链接**退化成纯文本**（`<a href="">` 点下去会重载本页）。
 * 真正的红线是**永远不要在这条正文路径上用 dangerouslySetInnerHTML**。
 *
 * 【不变的两件事】金额自动包 `<Sensitive>`（低调模式与档案面板一起打码），
 * 【案号待核实】仍是淡色标注。两者作用在**文本叶子**上，所以下面每个自带文字的
 * 组件都过一遍 `decorate`——漏掉哪个，低调模式在那种块里就静默失效。
 */

/**
 * 金额：带「元 / 万元」的数字，外加裸写的四位以上数字（月薪 25000 这种）。
 * 后一支排除日期与条号，免得把「2026 年」「第 47 条」一起打码。
 */
const MONEY = /(\d[\d,]*(?:\.\d+)?\s*(?:万元|元)|\d{4,}(?![\d\s]*[年月日号条]))/g;

function withMoney(text: string, key: string): ReactNode[] {
  return text.split(MONEY).map((part, i) =>
    i % 2 === 1 ? (
      <Sensitive key={`${key}-m${i}`} className="num">
        {part}
      </Sensitive>
    ) : (
      part
    ),
  );
}

/**
 * 【案号待核实】：服务端拦下编造案号后留的占位（notice: CITATION_BLOCKED）。
 * 淡色标注表示"此处引用待核实"，不用警报色。
 */
const CITE_PENDING = /(【案号待核实】)/g;

function withMarks(text: string, key: string): ReactNode[] {
  return text.split(CITE_PENDING).flatMap((part, i) =>
    i % 2 === 1 ? (
      <span
        key={`${key}-c${i}`}
        className="rounded bg-surface-2 px-1 text-[0.92em] text-ink-2"
      >
        {part}
      </span>
    ) : (
      withMoney(part, `${key}-w${i}`)
    ),
  );
}

/** 纯文本里的金额打码：给不走 markdown 的地方用（用户气泡、档案里的叙述字段）。 */
export function MaskedText({ text }: { text: string }) {
  return <>{withMoney(text, 'mask')}</>;
}

/**
 * 把一个块里的**文本叶子**过一遍金额/占位标注，元素子节点原样传下去
 * （它们各自的组件会再对自己的文本叶子做同样的事）。
 * 代码块不走这里：代码里的数字是代码，打码只会让人抄错。
 */
function decorate(children: ReactNode): ReactNode {
  return Children.map(children, (child, i) =>
    typeof child === 'string' ? withMarks(child, `d${i}`) : child,
  );
}

/**
 * 只放行安全协议。`defaultUrlTransform` 已经按 micromark 的白名单
 *（http/https/mailto/irc/xmpp）判过一遍，这里再显式挡一次 `javascript:`：
 * 这条判据要钉在**我们自己的代码**上，而不是钉在某个依赖将来仍会这么做的默认值上。
 */
function safeUrl(url: string): string {
  if (/^\s*javascript:/i.test(url)) return '';
  return defaultUrlTransform(url);
}

/** 段落之间的基础节奏。小标题上方留得多一点——它是新一段的开头，不是又一行字。 */
const BLOCK = 'mt-3';
const HEADING = 'mt-5 font-semibold text-ink';

/**
 * 元素表。**md 的 h1–h3 一律降到 h3–h5**：这是一条聊天消息，页面上已经有 h1/h2 了，
 * 让模型的措辞去抢文档大纲的顶级标题，读屏的人会以为跳到了另一页。
 * 视觉上三级都是「段落小标题」，只差字号。
 */
const COMPONENTS: Components = {
  p: ({ children }) => <p className={BLOCK}>{decorate(children)}</p>,
  strong: ({ children }) => (
    <strong className="font-semibold text-ink">{decorate(children)}</strong>
  ),
  em: ({ children }) => <em className="italic">{decorate(children)}</em>,
  del: ({ children }) => (
    <del className="text-ink-2 line-through">{decorate(children)}</del>
  ),

  h1: ({ children }) => <h3 className={`${HEADING} text-[17px]`}>{decorate(children)}</h3>,
  h2: ({ children }) => <h4 className={`${HEADING} text-[16px]`}>{decorate(children)}</h4>,
  h3: ({ children }) => <h5 className={`${HEADING} text-[15px]`}>{decorate(children)}</h5>,
  // 四级往下不再新增字号档：再细分只会让人分不清层级，统一按最小那一档画
  h4: ({ children }) => <h6 className={`${HEADING} text-[15px]`}>{decorate(children)}</h6>,
  h5: ({ children }) => <h6 className={`${HEADING} text-[15px]`}>{decorate(children)}</h6>,
  h6: ({ children }) => <h6 className={`${HEADING} text-[15px]`}>{decorate(children)}</h6>,

  /**
   * 引用块按「可以整段抄走的模板」画：模型用它写要发给 HR 的邮件、要递的异议函正文。
   * 所以给底色和左界线，让它在正文里看起来是一块**独立的东西**，而不是被强调的一句话。
   */
  blockquote: ({ children }) => (
    <blockquote
      className={`${BLOCK} rounded-[8px] border-l-2 border-line bg-surface-2 px-3.5 py-3 [&>*:first-child]:mt-0`}
    >
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-5 border-0 border-t border-line" />,

  ul: ({ children }) => (
    <ul className={`${BLOCK} list-disc space-y-2 pl-6 marker:text-ink-2`}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className={`${BLOCK} list-decimal space-y-2 pl-6 marker:text-ink-2`}>{children}</ol>
  ),
  // 松列表里每个 li 的正文被包成 <p>，首段不能再吃一次 mt-3——否则条目之间会散架
  li: ({ children }) => <li className="[&>p:first-child]:mt-0">{decorate(children)}</li>,

  code: ({ children, className }) => (
    <code className={`rounded bg-surface-2 px-1 py-0.5 text-[0.92em] ${className ?? ''}`}>
      {children}
    </code>
  ),
  /**
   * 围栏代码块自己横向滚动。块里那个 `<code>` 会带上上面那套行内药丸样式，
   * 在这里就地抵消——靠 `language-` 前缀猜"是不是块级"会在无语言的围栏上判错。
   */
  pre: ({ children }) => (
    <pre
      className={`${BLOCK} overflow-x-auto rounded-[8px] bg-surface-2 p-3 text-[13px] leading-6 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em]`}
    >
      {children}
    </pre>
  ),

  /**
   * 表格外面永远套一层横向滚动容器。393 宽度下赔偿金测算表放不下是常态，
   * **让表格自己撑宽页面是整页横滚**——那一下会把输入框和顶栏一起推出屏幕。
   */
  table: ({ children }) => (
    <div className={`${BLOCK} overflow-x-auto`}>
      <table className="w-full border-collapse text-left text-[14px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line bg-surface-2 px-2.5 py-1.5 align-top font-semibold">
      {decorate(children)}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-line px-2.5 py-1.5 align-top">{decorate(children)}</td>
  ),

  /**
   * 链接一律新标签页打开，并带全 `rel`：正文里的链接来自模型，
   * 不能让它拿到 `window.opener`。`href` 被 urlTransform 判空时不画成链接——
   * 一个 `href=""` 的 `<a>` 点下去会重载当前页，比不给链接更糟。
   */
  a: ({ children, href }) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="underline decoration-ink-2/60 underline-offset-2"
      >
        {decorate(children)}
      </a>
    ) : (
      <>{decorate(children)}</>
    ),
};

const PLUGINS = [remarkGfm];

export function RichText({ text }: { text: string }) {
  return (
    <div
      data-veil=""
      data-rich-text=""
      className="prose-measure text-[16px] leading-[1.75] text-ink [&>*:first-child]:mt-0"
    >
      <Markdown
        remarkPlugins={PLUGINS}
        components={COMPONENTS}
        skipHtml
        urlTransform={safeUrl}
      >
        {text}
      </Markdown>
    </div>
  );
}
