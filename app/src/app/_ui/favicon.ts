/**
 * 低调模式下的标签页图标。
 *
 * 【为什么单开一处】`document.title` 早就中性化了，favicon 却一直是土八鼠徽章——
 * 它穿过了两条已有纪律的缝：08-28「应用内持久标记用头部紧裁」管的是**页面里**，
 * `Mascot` 返回 null 管的是**React 渲染的组件**。favicon 既不在页面里、也不由 React
 * 渲染，两条都没盖到。PC 上标签栏常驻、会被截图投屏，所以这是 PC 独有的一处泄密面。
 *
 * 【为什么不删而是改 rel】删掉之后没法还原：Next 的 metadata 只在首屏和路由切换时
 * 往 head 里写，我们关掉低调模式的那一刻它不会再写一遍。改 rel 是可逆的，
 * 原节点还在，还原就是把 rel 改回去。
 *
 * 【为什么还要观察器】跟 discreet.tsx 里压标题那处同一个原因：路由切换时 Next 会
 * 把 metadata 的 icon 重新写进 head。只在开着低调模式时装，关掉即断开。
 */

/** 我们塞进去的那一个的记号。 */
const NEUTRAL_ATTR = 'data-neutral-icon';
/** 原节点被改掉的 rel 存在这里，还原时读回。 */
const ORIG_ATTR = 'data-icon-rel';
/** 一个浏览器不认识的 rel：节点还在，但不再当图标用。 */
const PARKED_REL = 'x-parked-icon';

const ICON_SELECTOR = 'link[rel~="icon"], link[rel~="apple-touch-icon"]';

/**
 * 中性图标：灰底 + 三条白横线，像任何一个记事应用。
 * 单色、无品牌、深浅两种标签栏底色下都看得清。
 */
export const NEUTRAL_ICON_HREF =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%236b7280'/%3E%3Cg fill='%23ffffff'%3E%3Crect x='8' y='10' width='16' height='2.6' rx='1.3'/%3E%3Crect x='8' y='15' width='16' height='2.6' rx='1.3'/%3E%3Crect x='8' y='20' width='10' height='2.6' rx='1.3'/%3E%3C/g%3E%3C/svg%3E";

/**
 * 把当前 head 里的真图标停用，并确保中性图标在位。
 *
 * 【为什么要去重】改了 rel 之后 Next 的客户端 head 管理认不出自己那几个节点，
 * 会**再插一份**，观察器又把新的这份停用——一次路由切换多三个死节点，切几次就攒一堆。
 * 实测（scripts/perf/ws-grid.mjs ⑥）水合后就已经是 6 个。同 (rel, href) 只留一个。
 */
function neutralize(): void {
  const seen = new Set<string>();
  for (const el of document.querySelectorAll<HTMLLinkElement>(
    `link[${ORIG_ATTR}], ${ICON_SELECTOR}`,
  )) {
    if (el.hasAttribute(NEUTRAL_ATTR)) continue;
    const rel = el.getAttribute(ORIG_ATTR) ?? el.getAttribute('rel') ?? 'icon';
    const id = `${rel}|${el.getAttribute('href') ?? ''}`;
    if (seen.has(id)) {
      el.remove();
      continue;
    }
    seen.add(id);
    el.setAttribute(ORIG_ATTR, rel);
    el.setAttribute('rel', PARKED_REL);
  }
  if (!document.querySelector(`link[${NEUTRAL_ATTR}]`)) {
    const link = document.createElement('link');
    link.setAttribute(NEUTRAL_ATTR, '');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = NEUTRAL_ICON_HREF;
    document.head.appendChild(link);
  }
}

/** 还原：摘掉中性图标，把停用的真图标 rel 改回去。 */
function restore(): void {
  document.querySelectorAll(`link[${NEUTRAL_ATTR}]`).forEach((el) => el.remove());
  for (const el of document.querySelectorAll<HTMLLinkElement>(`link[${ORIG_ATTR}]`)) {
    el.setAttribute('rel', el.getAttribute(ORIG_ATTR) as string);
    el.removeAttribute(ORIG_ATTR);
  }
}

/**
 * 低调模式的标签页图标唯一入口。开着时顺带盯住 head——
 * 路由切换时 Next 会把真图标写回来。返回值是解绑函数。
 */
export function applyFavicon(discreet: boolean): () => void {
  if (typeof document === 'undefined') return () => {};
  if (!discreet) {
    restore();
    return () => {};
  }
  neutralize();
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node instanceof HTMLLinkElement && node.matches(ICON_SELECTOR)) {
          neutralize();
          return;
        }
      }
    }
  });
  observer.observe(document.head, { childList: true });
  return () => observer.disconnect();
}

/**
 * 首屏脚本用的那一段（拼进 `discreetBootstrapScript`）。
 *
 * 【为什么首屏也要做一遍】React 的副作用要等水合，那之前标签页已经把真图标画出来了。
 * 焦虑的人第一眼看的就是那一排标签——闪一下等于没修。
 * 这段跑在 `<head>` 里，多数情况下抢在解析器读到 icon 链接之前，请求都不会发出去。
 */
export const faviconBootstrapSnippet =
  `var ls=document.querySelectorAll('${ICON_SELECTOR.replace(/'/g, "\\'")}');` +
  `for(var i=0;i<ls.length;i++){ls[i].setAttribute('${ORIG_ATTR}',ls[i].getAttribute('rel')||'icon');ls[i].setAttribute('rel','${PARKED_REL}')}` +
  `var l=document.createElement('link');l.setAttribute('${NEUTRAL_ATTR}','');l.rel='icon';l.type='image/svg+xml';l.href="${NEUTRAL_ICON_HREF}";document.head.appendChild(l);`;
