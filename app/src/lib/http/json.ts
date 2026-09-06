// app/src/lib/http/json.ts
// **全站 HTTP 面回 JSON 的唯一出口。** 路由一律用 apiJson，不直接用 NextResponse.json。
//
// 【为什么要收这个口】对外的时间字段必须带 +08:00（见 lib/time 文件头）。让六十个路由
// 各自记得转一次的形态是：忘掉的那一处照常返回 200，串看起来也完全正常，只是收到它的
// agent 会按自己的本地时区解析，跨日那一段整整错一天。所以转换收在出口上，路由一个字不用改。
// 这条由 app/api/__tests__/api-json-entrance.test.ts 机检：route.ts 里出现 NextResponse.json 即红。
import { NextResponse } from 'next/server';

import { withDisplayTimes } from '@/lib/time';

/** 与 NextResponse.json 同签名同行为，另外把回包里的时间字段统一成带 +08:00 的 ISO。 */
export function apiJson(body: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(withDisplayTimes(body), init);
}
