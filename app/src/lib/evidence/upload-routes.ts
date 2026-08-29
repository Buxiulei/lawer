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
 * 会收 multipart 上传的路由前缀（不带通配符）。
 *
 * Caddyfile 里以 `${前缀}*` 的通配形态出现，且必须**同时**出现在两行：
 *   @uploads path <前缀*...>          → request_body max_size 30MB
 *   @non_uploads { not path <同一组> } → request_body max_size 2MB
 * 两个匹配器写成互斥的，所以少加一处就等于该路由被 2MB 掐死。
 */
export const UPLOAD_ROUTE_PREFIXES = ['/api/v1/evidence', '/api/v1/realname/passport'] as const;
