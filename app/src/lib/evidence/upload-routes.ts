// app/src/lib/evidence/upload-routes.ts
// 上传路由集合的**唯一真源**。
//
// 【为什么要有这个文件】这个集合原来同时写在三处：deploy/Caddyfile 的 @uploads 行、
// 同文件 @non_uploads 的 not path 行、以及改动者的脑子。独立写三次就会忘一次——
// 首轮加体积闸时 /api/v1/realname/passport* 就是这么漏掉的，落进默认 2MB，
// 每一次护照实名提交都被静默掐断。
// 更糟的是 `caddy adapt` / `caddy validate` 对"少写一条路径"退出码是 0：语法完全合法，
// 只是语义上把一条路封了，工具看不出来。所以真源收在这里，由测试去咬 Caddyfile。
//
// ⚠️ **新增上传路由必须加进本清单**——Caddy 守卫测试（__tests__/caddy-upload-routes.test.ts）
// 会点名漏掉的那一条：清单里有而 Caddyfile 缺 → 红；Caddyfile 有而清单缺 → 一样红。
// 两个方向都咬，就是为了不让"只改一处"再次成立。
//
// 【路由的判定标准】只要该路由会 `req.formData()` 把整个请求体读进内存（典型是 multipart
// 文件上传），它就属于这里——那正是内存放大 4~6 倍、需要 30MB 而非 2MB 请求体上限的一类。
// 纯 JSON 的 REST/聊天路由不属于，它们留在 2MB 里。

/**
 * 会把整个请求体读进内存的路由前缀（不带通配符）。**全集**，两档合起来就是它。
 *
 * Caddyfile 里以 `${前缀}*` 的通配形态出现：每条各自出现在它那一档的匹配器行里，
 * 且全集必须原样出现在 `@non_uploads { not path ... }` 那一行——三个匹配器写成互斥的，
 * 少加一处就等于该路由落回默认 2MB 被静默掐死。
 */
export const UPLOAD_ROUTE_PREFIXES = ['/api/v1/evidence', '/api/v1/realname/passport'] as const;

/**
 * 请求体上限分档。**这份常量是 Caddyfile 那几行的真源**，守卫测试对着它咬原文。
 *
 * 【为什么要分两档，不能一档到底】证据路径要收视频（应用侧 100 MiB 档），
 * 护照实名一次两份材料合计 16 MiB 出头。把两条并成一档 100MB，等于给护照那条
 * 也开了 100MB 的口子——那条路的应用侧上限是 8 MiB/份，多出来的 90 多 MB
 * 纯粹是白白让人往进程内存里灌字节的余地。
 *
 * 【为什么不靠"更具体的匹配器覆盖更宽的"】Caddy 同名指令叠加时以**更严的**为准，
 * 靠重叠+顺序会把证据路由也收回 30MB，而配置语法完全合法、adapt 退出码是 0。
 * 所以三个匹配器必须互斥，每条路由只落进一档。
 *
 * 上限都比应用侧对应的上限略宽：留给 multipart 边界与字段头，
 * 好让「超限」由应用回一条说得清原因的 413，而不是 Caddy 直接掐断连接。
 */
export const CADDY_BODY_TIERS = [
  {
    matcher: '@media_uploads',
    prefixes: ['/api/v1/evidence'] as const,
    maxSize: '100MB',
    why: '证据路径要收录音与视频（应用侧各 100 MiB）',
  },
  {
    matcher: '@uploads',
    prefixes: ['/api/v1/realname/passport'] as const,
    maxSize: '30MB',
    why: '护照实名一次两份材料，各 8 MiB 上限，合计 16 MiB 出头',
  },
] as const;
