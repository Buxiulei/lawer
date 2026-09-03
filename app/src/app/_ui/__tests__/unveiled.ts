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

/**
 * 取文字，但把 `isSkip` 认下的那些开标签**连同整棵子树**剔掉。
 * 两个取字器（糊层、CSS 显隐）共用这一趟遍历——上面那段说明讲的正是
 * 「这段解析不许再抄第二遍」。
 */
function textExcluding(html: string, isSkip: (openTag: string) => boolean): string {
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
    if (skipDepth === 0 && isSkip(tok)) skipDepth = stack.length;
  }
  return out.join('').replace(/\s+/g, '');
}

export function unveiledText(html: string): string {
  return textExcluding(html, (tag) => /\sdata-veil\b/.test(tag));
}

/**
 * 这一刻**眼睛真能看到**的字：把 CSS 会 `display:none` 掉的那一半剔掉。
 *
 * 那两个类的规则写在 globals.css（`.discreet-only` 默认收起、
 * `html[data-discreet='1']` 下换成收起 `.discreet-hide`）。测试跑不了真 CSS，
 * 所以这里照着它的语义走，而 welcome-discreet.test 另有一条守卫钉住
 * globals.css 里那三条规则还在——只剩一半的话，看得见的就成了另一句。
 */
export function visibleText(html: string, opts: { discreet: boolean }): string {
  const hidden = opts.discreet ? 'discreet-hide' : 'discreet-only';
  const re = new RegExp(`class="[^"]*\\b${hidden}\\b`);
  return textExcluding(html, (tag) => re.test(tag));
}

/** 整屏文字（不剔除任何东西）——反向对照用：糊住不等于删掉。 */
export function allText(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
}
