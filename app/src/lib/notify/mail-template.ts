// app/src/lib/notify/mail-template.ts
//
// 【所有外发邮件的唯一排版入口】
//
// 来由与 copy.ts 同源：文案只许写在一个文件里，**版式也只许写在一个文件里**。
// 上一轮的教训是"独立写 N 次就会忘 N 次"——若每封信各自拼一遍 HTML，
// 下次改品牌色就要记得改 N 处，漏掉的那一处不会报错，只会**发出去之后才被看见**。
// 所以这里是收口：copy.ts 出内容，本文件出版式，email.ts 只管投递。
//
// 【版式为什么是 table 套 table 这种上古写法】
// Outlook 桌面版用 Word 渲染引擎：不认 flex、不认 grid、不认外部/嵌入 <style> 里的多数规则。
// 邮件里能稳的只有 table 布局 + 行内样式。这不是没见过现代 CSS，是收件端画不出来。
//
// 【图片为什么走 cid 内联附件，而不是外链或 data: URI】
//   · data: URI —— Gmail 与 Outlook 直接剥掉 img，图必然消失；
//   · 外链 https —— 要求 LAWER_PUBLIC_URL 配对，且**会把平台域名写进邮件源码**。
//     期限提醒信当前正文一个链接都没有（见 copy.ts「连事项类型都不给」），
//     为了放个 logo 反倒把域名塞进去，是拿隐私换装饰；
//   · cid 内联 —— 各家客户端都认，且整封信自包含，不向外发一次请求。
// 三者里只有 cid 同时满足"画得出"和"不多说一个字"。

import { NOTIFY_BRAND } from './copy';
import type { MailBlock, MailCopy } from './copy';
import { LOGO, MASCOT } from './brand-assets';
import type { BrandAsset } from './brand-assets';

/**
 * 勃艮第红。用户 2026-08-31 点名的验证码颜色，也是品牌头的字色。
 * 定在这里而不是各封信里各写一遍——**改色只该改一处**。
 */
export const BURGUNDY = '#8b2942';

const INK = '#2c2622';
const MUTED = '#857b72';
const RULE = '#ece6df';
const PAGE_BG = '#f5f2ee';
const CARD_BG = '#ffffff';

// 邮件里字体只能靠系统栈：webfont 在多数客户端被剥。
const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const MONO = "SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace";

/** 渲染好的一封信，字段与 nodemailer sendMail 的入参同名，传输层不再加工。 */
export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
  attachments: BrandAsset[];
}

/**
 * HTML 转义。
 * 文案里会出现来自库里的 `kind`（期限类型，detailed 模式下进正文），
 * 那是用户可写的字段 —— 不转义就是把用户输入直接拼进 HTML。
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把一段可能含 \n 的文字拆成若干单行 */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 没给 blocks 时的兜底：把纯文本按 \n 拆成段。
 * **期限提醒信走的就是这条路**——它一个字都没改，版式却照样套上了。
 */
function blocksFromText(text: string): MailBlock[] {
  return lines(text).map((line) => ({ kind: 'text', text: line }) as MailBlock);
}

/**
 * 一段普通正文。含 \n 的按行拆成多个 <p>。
 *
 * 【为什么这里也要拆，明明 blocksFromText 已经拆过了】
 * 两条路进来的文字必须排得一样。blocks 里的一段本身就可能带 \n
 * （验证码信的尾段就是「N 分钟内有效…\n若非本人操作…」）——
 * 不拆的话 HTML 会把换行折成一个空格，于是**同一句话，走兜底是两行、走 blocks 是一行**。
 * 目视样例里就是这么发现的：提醒信三行分明，验证码信的尾巴挤成了一行。
 * 版式只写一处的意义，就是不许出现"看输入从哪条路来"的差别。
 */
function textBlock(text: string): string {
  return lines(text)
    .map(
      (line) =>
        `<p style="margin:0 0 12px;font:400 15px/1.75 ${SANS};color:${INK};">${escapeHtml(line)}</p>`,
    )
    .join('');
}

/**
 * 验证码那一行。用户原话：**单独成行、放大、加粗、勃艮第红**。
 *
 * letter-spacing 右侧会多留一格，靠等量 padding-left 把整体拉回视觉居中——
 * 少了这一下，六位码看起来是偏左的。
 */
function codeBlock(code: string): string {
  return (
    `<p style="margin:0 0 12px;text-align:center;">` +
    `<span style="display:inline-block;padding:14px 18px 14px 26px;` +
    `font:700 32px/1.25 ${MONO};letter-spacing:8px;` +
    `color:${BURGUNDY};background:#faf4f5;border-radius:10px;">` +
    `${escapeHtml(code)}</span></p>`
  );
}

function renderBlocks(blocks: MailBlock[]): string {
  return blocks
    .map((b) => (b.kind === 'code' ? codeBlock(b.code) : textBlock(b.text)))
    .join('');
}

/** `<img>` 走 cid 引用；宽高都写死，图没加载出来时版面不会塌。 */
function img(asset: BrandAsset, alt: string): string {
  return (
    `<img src="cid:${asset.cid}" alt="${escapeHtml(alt)}" ` +
    `width="${asset.widthPx}" height="${asset.widthPx}" ` +
    `style="display:block;border:0;width:${asset.widthPx}px;height:${asset.widthPx}px;" />`
  );
}

/**
 * 预览行（preheader）。
 *
 * 【为什么非有不可】收件箱列表与手机横幅显示的是"主题 + 正文开头"。
 * 品牌头排在 HTML 最前，不管的话横幅上就会冒出「土八鼠」——
 * 而 copy.ts 顶部那条约束防的正是**手机在工位上亮起来的那一眼**。
 * 用一段隐藏文字把预览抢回中性正文，主题与正文本身一个字不动。
 * 末尾那串零宽空格是业界通行做法：挡住客户端把后面的品牌头续到预览里。
 */
function preheader(text: string): string {
  const first = text.split('\n')[0] ?? '';
  return (
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;` +
    `font-size:1px;line-height:1px;color:${PAGE_BG};opacity:0;">` +
    `${escapeHtml(first)}${'&#8203;&nbsp;'.repeat(30)}</div>`
  );
}

/**
 * 把一份文案渲染成可投递的一封信。
 *
 * @param copy copy.ts 出的文案。**subject 与 text 原样透传，本函数一个字都不改。**
 */
export function renderMail(copy: MailCopy): RenderedMail {
  const blocks = copy.blocks ?? blocksFromText(copy.text);

  const html =
    `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width,initial-scale=1" />` +
    `<meta name="color-scheme" content="light only" />` +
    `<title>${escapeHtml(copy.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:${PAGE_BG};">` +
    preheader(copy.text) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="background:${PAGE_BG};"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;max-width:600px;background:${CARD_BG};border-radius:14px;` +
    `border:1px solid ${RULE};">` +
    // ── 品牌头 ──
    `<tr><td style="padding:20px 28px;border-bottom:1px solid ${RULE};">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="vertical-align:middle;">${img(LOGO, NOTIFY_BRAND)}</td>` +
    `<td style="vertical-align:middle;padding-left:12px;` +
    `font:700 19px/1.2 ${SANS};color:${BURGUNDY};letter-spacing:1px;">${NOTIFY_BRAND}</td>` +
    `</tr></table></td></tr>` +
    // ── 正文 ──
    `<tr><td style="padding:26px 28px 8px;">${renderBlocks(blocks)}</td></tr>` +
    // ── 吉祥物配图 ──
    `<tr><td align="center" style="padding:4px 28px 20px;">${img(MASCOT, '')}</td></tr>` +
    // ── 页脚 ──
    `<tr><td style="padding:14px 28px 22px;border-top:1px solid ${RULE};` +
    `font:400 12px/1.7 ${SANS};color:${MUTED};">` +
    `本邮件由系统自动发出，请勿直接回复。</td></tr>` +
    `</table></td></tr></table></body></html>`;

  return {
    subject: copy.subject,
    text: copy.text,
    html,
    attachments: [LOGO, MASCOT],
  };
}
