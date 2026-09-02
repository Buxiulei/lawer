/**
 * 助手正文的块级 markdown 必须**真被渲染成元素**，不是把符号原样摊在屏幕上。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * RichText 此前是个手写解析器，只认「段落 / 一层列表 / **加粗**」。
 * 模型照常写 `## 三步走`、`> 尊敬的人力资源部：`、`---`、引用块里再嵌 `1.`、
 * 以及赔偿金测算表格——**一个都没被解析**。用户看到的正文里躺着井号、竖线和星号，
 * 而那恰恰是他要抄进仲裁申请书、抄进发给 HR 的邮件里的那几段。
 * 屏幕上看不出"坏了"，只是难读、抄出去会带着符号。
 *
 * 【判据分三层，缺一层就抓不住对应的退化】
 *  ① 元素层：该出 h/blockquote/hr/ol/ul/code/pre/table 的地方真出了对应标签；
 *  ② 可见文本层：把标签剥光之后，**一个裸符号都不许剩**（`##`/`**`/`|`/`---`）。
 *     只验①会漏掉"标签出了、符号也还在"那一半；
 *  ③ 不许回归层：金额仍进 <Sensitive>、【案号待核实】仍是淡色标注、data-veil 仍在。
 *     这三样是低调模式与引用占位的落点，换渲染器最容易把它们悄悄丢掉——
 *     丢了以后**页面完全正常**，只是低调模式在这些块里再也不打码。
 *
 * 【变异臂】
 *  · A1 RichText 回退成 `<p>{text}</p>`（纯文本）  ⇒ ①②全红
 *  · A2 正文改走 dangerouslySetInnerHTML（"放开 raw HTML"）⇒ 安全那三条红
 *  · A3 `a` 组件去掉空 href 分支                    ⇒ `href=""` 那条红
 *  · A4 `a` 去掉 rel="noopener"                     ⇒ rel 那条红
 *  · A5 table 去掉外层 overflow-x-auto              ⇒ 致宽那条红
 *  · A6 td/th 不再 decorate                          ⇒ 表格里金额打码那条红
 *
 * 【说准一点：skipHtml 不是安全阀】react-markdown 10 默认就不把 raw HTML 变成 DOM，
 * 本组的 script/onerror 判据在去掉 skipHtml 后**依然是绿的**（实测：那时它渲染成
 * 转义可见文字）。所以这里不谎称"删了 skipHtml 会红"——它挡的是观感。
 * 真正会让安全判据变红的是 A2 那种把正文当 HTML 塞进 DOM 的改法。
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
}));

const { RichText, MaskedText } = await import('../RichText');

const ssr = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
const html = (text: string) => ssr(<RichText text={text} />);
/** 剥光标签之后用户眼里剩下的那些字 */
const visible = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");

/** 一段"该有的都有"的回复，逐条对着 charter 里模型真会写的形状来 */
const SAMPLE = [
  '# 你现在的处境',
  '',
  '## 三步走',
  '',
  '先看**第一步**：核对《解除劳动合同通知书》。',
  '',
  '### 邮件模板',
  '',
  '> 尊敬的人力资源部：',
  '>',
  '> 1. 本人不认可解除理由',
  '> 2. 请于三日内书面答复',
  '',
  '---',
  '',
  '- 收集证据',
  '  - 劳动合同',
  '  - 工资流水',
  '- 计算金额',
  '',
  '| 项目 | 金额 |',
  '| --- | --- |',
  '| 违法解除赔偿金 | 82000 元 |',
  '',
  '行内写法 `N+1`，公式：',
  '',
  '```text',
  '2N × 月工资',
  '```',
  '',
  '参考 [北京人社局](https://example.com/rs)。',
].join('\n');

describe('一、块级元素真的被渲染出来', () => {
  const markup = html(SAMPLE);

  /** md 的 h1–h3 降到 h3–h5：这是一条聊天消息，不该抢页面的顶级标题 */
  it('标题出 h3/h4/h5，不是一行带井号的段落', () => {
    expect(markup).toContain('<h3');
    expect(markup).toContain('<h4');
    expect(markup).toContain('<h5');
    expect(visible(markup)).toContain('三步走');
  });

  it('引用块出 blockquote，且**块内的有序列表也被解析**（此前它是裸露的 1.）', () => {
    const quote = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/.exec(markup);
    expect(quote, 'blockquote 没渲染出来').not.toBeNull();
    expect(quote![1]).toContain('<ol');
    expect(quote![1]).toContain('<li');
    expect(visible(quote![1])).toContain('本人不认可解除理由');
  });

  it('分隔线出 hr', () => {
    expect(markup).toContain('<hr');
  });

  it('无序列表出 ul/li，且嵌套那一层也在（不是拍平成一层）', () => {
    const uls = markup.match(/<ul/g) ?? [];
    expect(uls.length, '嵌套列表被拍平了').toBeGreaterThanOrEqual(2);
    expect(visible(markup)).toContain('工资流水');
  });

  it('行内代码出 code，围栏代码出 pre 且自己横向滚动', () => {
    expect(markup).toContain('<code');
    const pre = /<pre[^>]*class="([^"]*)"/.exec(markup);
    expect(pre, 'pre 没渲染出来').not.toBeNull();
    expect(pre![1]).toContain('overflow-x-auto');
    expect(visible(markup)).toContain('2N × 月工资');
  });

  it('表格出 table/th/td', () => {
    expect(markup).toContain('<table');
    expect(markup).toContain('<th');
    expect(markup).toContain('<td');
    expect(visible(markup)).toContain('违法解除赔偿金');
  });
});

describe('二、剥光标签之后，一个裸符号都不剩', () => {
  /**
   * 这一条是整组的由头。变异臂 A1（渲染器回退成纯文本）在①层可能只红一半，
   * 这里必红——用户抱怨的正是屏幕上这些符号本身。
   */
  it('可见文本里没有 ## / ** / | / --- / 裸链接语法', () => {
    const text = visible(html(SAMPLE));
    for (const junk of ['#', '**', '|', '---', '](', '```']) {
      expect(text, `可见文本里还留着 ${junk}`).not.toContain(junk);
    }
    // 正对照：内容本身确实渲染进来了，否则上面全是在空字符串上断言
    expect(text).toContain('核对《解除劳动合同通知书》');
    expect(text).toContain('北京人社局');
  });
});

describe('三、不许回归：低调打码 / 引用占位 / 糊层锚点', () => {
  it('正文里的金额仍然进 <Sensitive>（低调模式靠它打码）', () => {
    const markup = html('赔偿金 82000 元，月薪 25000。');
    expect(markup).toContain('class="num"');
    expect(visible(markup)).toContain('82000 元');
  });

  /** 变异臂 A6：td/th 不再 decorate ⇒ 表格里的金额从此不打码，而屏幕上看不出差别 */
  it('**表格单元格里的金额同样打码**——换渲染器最容易漏的正是这一格', () => {
    const markup = html('| 项目 | 金额 |\n| --- | --- |\n| 赔偿金 | 82000 元 |');
    const cell = /<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/.exec(markup);
    expect(cell, 'td 没渲染出来').not.toBeNull();
    expect(cell![2]).toContain('class="num"');
  });

  it('列表项与引用块里的金额也打码', () => {
    expect(html('- 赔偿金 82000 元')).toContain('class="num"');
    expect(html('> 赔偿金 82000 元')).toContain('class="num"');
  });

  it('【案号待核实】仍是淡色标注，不是警报色也不是裸文字', () => {
    const markup = html('参考【案号待核实】的口径。');
    expect(markup).toMatch(/<span class="[^"]*text-ink-2[^"]*">【案号待核实】<\/span>/);
  });

  it('糊层锚点 data-veil 还在（低调模式整块糊靠它）', () => {
    expect(html('随便一句')).toContain('data-veil');
  });

  it('用户消息那一路仍是纯文本，不吃 markdown', () => {
    const markup = ssr(<MaskedText text="## 我说的话 **不该** 被当成标题" />);
    expect(markup).not.toContain('<h');
    expect(markup).not.toContain('<strong');
    expect(visible(markup)).toContain('## 我说的话 **不该** 被当成标题');
  });
});

describe('四、不可信正文：脚本不落地，javascript: 不落地', () => {
  /** 变异臂 A2：正文改走 dangerouslySetInnerHTML ⇒ 这三条一起红 */
  it('<script> 不产生 script 节点', () => {
    const markup = html('正文一段\n\n<script>alert(1)</script>\n\n正文二段');
    expect(markup).not.toContain('<script');
    expect(visible(markup)).toContain('正文二段');
  });

  it('onerror 一类的事件属性不落地', () => {
    const markup = html('正文\n\n<img src=x onerror=alert(1)>\n\n尾');
    expect(markup).not.toContain('onerror');
    expect(markup).not.toContain('<img');
  });

  /**
   * 变异臂 A3：`a` 组件去掉空 href 分支 ⇒ 会渲染出 `<a href="">`，
   * 点下去重载当前页——正在生成的那一轮回答当场没了。
   */
  it('javascript: 链接退化成纯文字，既不留协议也不留空 href', () => {
    const markup = html('[点我](javascript:alert(1)) 和 [正常](https://example.com/x)');
    expect(markup.toLowerCase()).not.toContain('javascript:');
    expect(markup).not.toContain('href=""');
    expect(visible(markup)).toContain('点我');
    expect(markup).toContain('href="https://example.com/x"');
  });

  /** 变异臂 A4：去掉 rel ⇒ 新标签页拿得到 window.opener */
  it('正常外链新标签页打开且带全 rel', () => {
    const markup = html('参考 [人社局](https://example.com/rs)');
    expect(markup).toContain('target="_blank"');
    expect(markup).toMatch(/rel="[^"]*noopener[^"]*"/);
    expect(markup).toMatch(/rel="[^"]*noreferrer[^"]*"/);
  });
});

describe('五、393 不许致宽：表格一律套在横向滚动容器里', () => {
  /**
   * 变异臂 A5：去掉 table 外层那个 overflow-x-auto ⇒ 宽表格把整页撑宽，
   * 393 下输入框和顶栏会被一起推出屏幕（而在桌面宽度上一切正常，最难当场发现）。
   */
  it('table 的直接外层带 overflow-x-auto', () => {
    const markup = html(
      '| 项目 | 计算方式 | 金额 | 依据 |\n| --- | --- | --- | --- |\n' +
        '| 违法解除赔偿金 | 2N × 月平均工资 | 82000 元 | 劳动合同法第八十七条 |',
    );
    const wrapper = /<div class="([^"]*)"><table/.exec(markup);
    expect(wrapper, 'table 外面没有包裹容器').not.toBeNull();
    expect(wrapper![1]).toContain('overflow-x-auto');
  });
});

describe('六、流式半截 markdown 不许炸', () => {
  /**
   * 正文是一个字一个字流进来的：任何一帧都可能停在半个围栏、半张表、半个 `**` 上。
   * 渲染器在这些中间态上抛异常 = 用户看着回答生成到一半整块白屏。
   */
  it.each([
    ['半个标题', '## 三步'],
    ['半张表', '| 项目 | 金额 |\n| --- |'],
    ['半个加粗', '先看**第一'],
    ['半个引用', '> 尊敬的人力'],
    ['半个嵌套列表', '- 收集证据\n  - 劳动合'],
    ['半个围栏', '```text\n2N × 月工'],
    ['空串', ''],
  ])('%s 也能渲染出来', (_name, partial) => {
    expect(() => html(partial)).not.toThrow();
  });

  it('半截正文里已经成形的那部分照样是元素（不是等收完才渲染）', () => {
    expect(html('## 三步走\n\n先看第一')).toContain('<h4');
  });
});
