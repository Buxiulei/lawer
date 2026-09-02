/**
 * 低调模式页面级泄漏守卫共用的取字器：从一段静态 HTML 里取出**没有** data-veil 的文字，
 * 即「不按住也读得到的那些字」。
 *
 * 【为什么收成一个模块】这段解析有一个静默的错误形态：配对标签必须整棵子树剔除，
 * 正则一把梭会停在第一个闭合标签上，遇到嵌套少剔一截——于是守卫看起来在守、其实漏，
 * 而漏了的那一版**和守住的那一版长得一模一样**。它已经被独立抄了两份
 * （dashboard / settings-agent），第三份守卫要抄的那天就是抄漏的那天。
 * 新页面的守卫一律 `import { unveiledText }`，不许再各写一份。
 */
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link']);

export function unveiledText(html: string): string {
  const tokens = html.split(/(<[^>]+>)/);
  const out: string[] = [];
  let skipDepth = 0; // >0 表示正在一棵被剔除的子树里
  const stack: string[] = [];

  for (const tok of tokens) {
    if (!tok) continue;
    if (!tok.startsWith('<')) {
      if (skipDepth === 0) out.push(tok);
      continue;
    }
    const closing = tok.startsWith('</');
    const name = (tok.match(/^<\/?([a-zA-Z0-9]+)/)?.[1] ?? '').toLowerCase();
    const selfClosing = tok.endsWith('/>') || VOID_TAGS.has(name);

    if (closing) {
      stack.pop();
      if (skipDepth > 0 && stack.length < skipDepth) skipDepth = 0;
      continue;
    }
    if (selfClosing) continue;
    stack.push(name);
    if (skipDepth === 0 && /\sdata-veil\b/.test(tok)) skipDepth = stack.length;
  }
  return out.join('').replace(/\s+/g, '');
}

/** 整屏文字（不剔除任何东西）——反向对照用：糊住不等于删掉。 */
export function allText(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
}
