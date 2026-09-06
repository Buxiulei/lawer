'use client';

/**
 * 「登录完请把我送回原来那一页」的暂存位。
 *
 * 目前只有一个来路：授权页（/oauth/authorize）发现没登录态时，把自己记下来再去登录。
 * 登录成功那一处（LoginFlow 的唯一出口）读一次、读完就擦。
 *
 * 【为什么走 sessionStorage 而不是 /login?next=】URL 上的 next 参数是个开放的跳转口：
 * 任何人都能造一条 /login?next=<别处> 的链接发给用户。存在同源的 sessionStorage 里，
 * 只有本站页面写得进去，天然没有这个面。
 *
 * 【为什么仍然要校验一遍再用】sessionStorage 是本站页面能写的，将来多一个写入方，
 * 「只写自家路径」这条约束就得靠人记性维持。这里当场校：必须是单斜杠开头的站内路径，
 * `//evil.example` 与 `https://…` 一律不认——它们会被浏览器当成外站地址跳出去。
 */

const KEY = 'tubashu.login.next';

/** 记下"登录完回这儿"。传进来的应当是 pathname + search。 */
export function rememberLoginRedirect(href: string): void {
  try {
    sessionStorage.setItem(KEY, href);
  } catch {
    // 隐私模式下写不进去：那就退回默认落点，登录本身不受影响
  }
}

/** 读一次并擦掉。没有记录、或记录不是合法站内路径时返回 null。 */
export function takeLoginRedirect(): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  return /^\/(?!\/)/.test(raw) ? raw : null;
}
