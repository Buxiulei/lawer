// app/src/lib/notify/__tests__/mail-template.test.ts
//
// 版式层的闸。两类断言，性质完全不同，别混：
//   ① 外观：用户点名要的东西（验证码单独成行、放大、加粗、勃艮第红；每封信都有 logo 和配图）。
//   ② 红线：期限提醒信的 subject / text 必须**逐字**等于 copy.ts 出的那一份。
//      套版式是允许的，改文案不是。这里比对的是整串相等，不是"包含"——
//      "包含"会让在正文后面偷偷缀一句话的改动照样绿。
import { describe, expect, test } from 'vitest';

import { deadlineReminder, emailVerifyCode } from '../copy';
import { BURGUNDY, escapeHtml, renderMail } from '../mail-template';
import { LOGO, MASCOT } from '../brand-assets';

/**
 * 取出包住验证码的那个 <span…>码</span>，连同它的行内样式。
 *
 * 报错写全三段（缺什么 / 为什么缺 / 怎么办）：这个 span 消失最可能的原因是
 * copy 那边没给 blocks，于是走了 text 兜底、码留在句子里——
 * 光说"找不到 span"会让下一个人从版式开始重查一遍，而问题根本不在版式。
 */
function codeSpan(html: string, code: string): string {
  const m = html.match(new RegExp(`<span[^>]*>${code}</span>`));
  if (!m) {
    throw new Error(
      `HTML 里没有包住验证码 ${code} 的 <span>。\n` +
        '多半是这份文案没给 blocks（copy.ts 的 emailVerifyCode），renderMail 于是走了 text 兜底，' +
        '码还嵌在正文那句话里，没被拎成单独一行。\n' +
        `请检查 copy.emailVerifyCode 是否仍返回 { kind: 'code' } 那一块。实际正文段落：` +
        JSON.stringify(paragraphs(html)),
    );
  }
  return m[0];
}

/** html 里所有 cid: 引用 */
function citedCids(html: string): string[] {
  return [...html.matchAll(/src="cid:([^"]+)"/g)].map((m) => m[1]);
}

/**
 * 正文里的所有段落（<p>…</p>）。
 *
 * 【为什么按段落数，而不是数全篇出现了几次】验证码本来就还会出现在 <title>（主题里带码）
 * 和预览行里——那两处是既有设计，不是重复渲染。要钉的是**正文里没留第二份**，
 * 所以判据必须落在段落上。第一版我图省事写成全篇计数，跑出来 3≠1，
 * 是测试先把我这条判据的量程问题指出来的。
 *
 * 【为什么是 [\s\S] 而不是 .】`.` 不跨行。用 `.` 的话，**一个内部残留了换行的 <p> 会整个匹配不上**，
 * 于是"段落里不许有换行"这条断言永远看不见它要找的那个缺陷——量具本身瞎了。
 * 这不是洁癖：换行折成空格正是目视样例里抓到的那个真 bug。
 */
function paragraphs(html: string): string[] {
  return [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
}

describe('验证码那一行（用户 2026-08-31 原话：单独成行、放大、加粗、勃艮第红）', () => {
  // 【为什么在每个 test 里现算，而不是提到 describe 顶上】
  // describe 体在收集阶段就执行：一旦 codeSpan 抛错，整个文件会变成"收集失败、0 个测试"，
  // 而不是某一条断言变红。变异核里就撞到过这一幕——报出来的是 `Tests no tests`，
  // 既看不出坏了哪一条，也看不出为什么。判据要能指名道姓，就不能在收集期爆炸。
  const html = () => renderMail(emailVerifyCode('123456', 5)).html;

  test('勃艮第红 #8b2942', () => {
    expect(BURGUNDY).toBe('#8b2942');
    expect(codeSpan(html(), '123456')).toContain(`color:${BURGUNDY}`);
  });

  test('放大到 32px，且加粗到 700', () => {
    // font 简写里字重在字号前：`font:700 32px/1.25 …`
    expect(codeSpan(html(), '123456')).toMatch(/font:\s*700\s+32px/);
  });

  test('单独成行 —— 码不许还嵌在正文那句话里', () => {
    // 【为什么这条比"有个大号 span"更要紧】把码放大了、却仍留一份在句子中间，
    // 正文里就会出现两个码。判据是**正文段落里只有一段带码，且那段除了码没有别的字**。
    const withCode = paragraphs(html()).filter((p) => p.includes('123456'));
    expect(withCode, '正文里带验证码的段落不是恰好一段').toHaveLength(1);
    expect(withCode[0].replace(/<[^>]+>/g, '').trim()).toBe('123456');
    // 且这一段是居中独占的
    const para = html().match(new RegExp(`<p[^>]*>(?:(?!</p>).)*123456(?:(?!</p>).)*</p>`));
    expect(para, '验证码没有独占一个 <p>').not.toBeNull();
    expect(para![0]).toContain('text-align:center');
  });

  test('正文首段不再把码嵌在句子中间（中性版原句是「您的验证码是 123456，…」）', () => {
    // 直接钉住拆分点：第一段到"是"为止，码另起一段。
    expect(paragraphs(html())[0].replace(/<[^>]+>/g, '')).toBe('您的验证码是');
  });

  test('detailed 模式同样是这一行待遇', () => {
    const d = renderMail(emailVerifyCode('987654', 10, { detailed: true }));
    const s = codeSpan(d.html, '987654');
    expect(s).toContain(`color:${BURGUNDY}`);
    expect(s).toMatch(/font:\s*700\s+32px/);
    const withCode = paragraphs(d.html).filter((p) => p.includes('987654'));
    expect(withCode).toHaveLength(1);
    expect(withCode[0].replace(/<[^>]+>/g, '').trim()).toBe('987654');
  });
});

describe('品牌壳：每封信都带 logo 与土八鼠配图', () => {
  const cases = [
    ['验证码（中性）', emailVerifyCode('123456', 5)],
    ['验证码（detailed）', emailVerifyCode('123456', 5, { detailed: true })],
    ['期限提醒（中性）', deadlineReminder(3, '仲裁时效')],
    ['期限提醒（detailed）', deadlineReminder(0, '开庭', { detailed: true })],
  ] as const;

  for (const [name, copy] of cases) {
    test(`${name}：logo + 配图 + 品牌名齐全`, () => {
      const m = renderMail(copy);
      expect(m.html).toContain(`src="cid:${LOGO.cid}"`);
      expect(m.html).toContain(`src="cid:${MASCOT.cid}"`);
      expect(m.html).toContain('土八鼠');
      expect(m.attachments).toHaveLength(2);
    });
  }

  test('🔑 html 引到的每个 cid 都真的挂了附件 —— 少挂一个就是收件端一个红叉', () => {
    // 【为什么要有这条结构闸】漏挂附件不会抛错、不会进日志，
    // 只在收件人那边显示成裂图。它必须在这里被点名，而不是等人来报。
    for (const [, copy] of cases) {
      const m = renderMail(copy);
      const attached = new Set(m.attachments.map((a) => a.cid));
      for (const cid of citedCids(m.html)) {
        expect(attached.has(cid), `html 引用了 cid:${cid} 但附件里没有`).toBe(true);
      }
      expect(citedCids(m.html).length).toBeGreaterThan(0);
    }
  });

  test('附件是真 PNG（不是 webp 改了个名）—— Outlook 不认 webp', () => {
    for (const a of [LOGO, MASCOT]) {
      expect(a.contentType).toBe('image/png');
      expect(a.filename.endsWith('.png')).toBe(true);
      // PNG magic：89 50 4E 47 0D 0A 1A 0A
      expect([...a.content.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      // webp 的 magic 是 'RIFF'….'WEBP'
      expect(a.content.subarray(0, 4).toString('ascii')).not.toBe('RIFF');
      expect(a.content.length).toBeGreaterThan(1024);
    }
  });

  test('附件名是中性的 —— 附件名在收件箱里露出来', () => {
    for (const a of [LOGO, MASCOT]) {
      expect(a.filename).toMatch(/^[a-z-]+\.png$/);
      expect(a.filename).not.toContain('土八鼠');
    }
  });
});

describe('🔴 红线：期限提醒信的文案层一字不动', () => {
  test('subject 与 text 逐字等于 copy.ts 出的那一份（整串相等，不是包含）', () => {
    for (const kind of ['仲裁时效', '起诉15日', '申请执行2年', '开庭', '答辩期']) {
      for (const d of [30, 7, 3, 1, 0]) {
        for (const detailed of [false, true]) {
          const copy = deadlineReminder(d, kind, { detailed });
          const m = renderMail(copy);
          expect(m.subject, `${kind}/${d}/detailed=${detailed}`).toBe(copy.subject);
          expect(m.text, `${kind}/${d}/detailed=${detailed}`).toBe(copy.text);
        }
      }
    }
  });

  test('中性提醒信的 text 部件里不含品牌名 —— 品牌只进 HTML 壳', () => {
    // 【为什么单挑纯文本部件】只读纯文本的客户端、以及横幅预览，取的都是这一份。
    // 壳套在 HTML 上是 manager 批过的；漏进纯文本就等于把中性承诺整个撤掉了。
    const m = renderMail(deadlineReminder(3, '仲裁时效'));
    expect(m.text).not.toContain('土八鼠');
    expect(m.text).toBe('您登记的一项重要事项还剩 3 天到期。\n请登录查看详情。\n若已处理完毕，可在应用内标记后不再收到提醒。');
  });

  test('中性提醒信不含敏感词 —— 连套了壳的 HTML 也不含', () => {
    for (const w of ['裁员', '仲裁', '开庭', '劳动', '律师', '赔偿', '解除', '离职', '维权']) {
      const m = renderMail(deadlineReminder(3, '开庭'));
      expect(m.subject).not.toContain(w);
      expect(m.text).not.toContain(w);
      expect(m.html, `HTML 壳漏出了敏感词「${w}」`).not.toContain(w);
    }
  });

  test('中性提醒信的 HTML 里没有平台域名 —— 图走内联，不外链', () => {
    // 外链会把域名写进邮件源码；这封信正文本来一个链接都没有。
    const { html } = renderMail(deadlineReminder(3, '仲裁时效'));
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/src="data:/); // Gmail / Outlook 会把 data: 图整个剥掉
    expect(html).not.toContain('lawer');
  });

  test('预览行抢在品牌头前面 —— 手机横幅上不该先冒出品牌名', () => {
    // copy.ts 顶部那条约束防的就是"手机在工位上亮起来的那一眼"。
    const { html, text } = renderMail(deadlineReminder(3, '仲裁时效'));
    const firstLine = text.split('\n')[0];
    const iPre = html.indexOf(firstLine);
    const iBrand = html.indexOf('土八鼠');
    expect(iPre, '预览行没找到').toBeGreaterThan(-1);
    expect(iPre, '品牌名排在了预览文字前面').toBeLessThan(iBrand);
  });
});

describe('没给 blocks 的文案走 text 兜底拆段', () => {
  test('提醒信三行 → 三个 <p>，逐行原样', () => {
    const copy = deadlineReminder(3, '仲裁时效');
    expect(paragraphs(renderMail(copy).html)).toEqual(copy.text.split('\n'));
  });

  test('🔑 换行不许被折成空格 —— 每个 <p> 只装一行', () => {
    // 【怎么发现的】目视样例：提醒信三行分明，验证码信尾段的「若非本人操作…」
    // 却和上一句挤在同一行。原因是 blocks 里那一段自带 \n，而 HTML 会把换行折成空格。
    //
    // 【判据为什么不是"段落数 == 纯文本行数"】我第一版就是这么写的，是错的：
    // 中性验证码信的纯文本把码嵌在句子里（2 行），HTML 却要把码拎成单独一行（4 段）——
    // 那个差是**设计要的**，不是 bug。两者一律相等的规则会把正确实现判成错的。
    // 真正要钉的规则只有一条：**任何一段里都不许再残留换行**。
    for (const copy of [
      emailVerifyCode('123456', 5),
      emailVerifyCode('123456', 5, { detailed: true }),
      deadlineReminder(3, '仲裁时效'),
      deadlineReminder(0, '开庭', { detailed: true }),
    ]) {
      for (const p of paragraphs(renderMail(copy).html)) {
        expect(p, `「${copy.subject}」有段落残留了换行`).not.toContain('\n');
        expect(p.replace(/<[^>]+>/g, '').trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('验证码信尾段的两句各占一行', () => {
    const paras = paragraphs(renderMail(emailVerifyCode('123456', 5)).html).map((p) =>
      p.replace(/<[^>]+>/g, '').trim(),
    );
    expect(paras).toEqual([
      '您的验证码是',
      '123456',
      '5 分钟内有效，请勿转发他人。',
      '若非本人操作，忽略本邮件即可。',
    ]);
  });
});

describe('转义', () => {
  test('库里来的 kind 会进 detailed 正文，必须转义', () => {
    // kind 是用户可写的字段；不转义就是把用户输入直接拼进 HTML。
    const { html } = renderMail(deadlineReminder(3, '<img src=x onerror=alert(1)>', { detailed: true }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('escapeHtml 覆盖五个字符', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    // & 必须先转，否则 &lt; 会被二次转义成 &amp;lt;
    expect(escapeHtml('<')).toBe('&lt;');
  });
});
