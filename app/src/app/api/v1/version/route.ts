// app/src/app/api/v1/version/route.ts
// GET 当前产物的构建信息。**免鉴权**：SHA 指向公开仓，无泄密面。
//
// 存在的理由：滚更后「服务器 HEAD=X」这句此前只有执行者本人说了算，
// 外部无任何核验面（version / build / healthz 全 404）。有了它，哨兵能自己去核。
//
// 【sha 可能是 null】构建时取不到 HEAD 就如实给 null——见 next.config.ts 的说明：
// 一个假的 SHA 会让坏滚更看起来已核验，比没有这个端点更坏。
// 核验方读到 null 应当判「无法核验」，**不是**判「通过」。
import { NextResponse } from 'next/server';

export async function GET() {
  const sha = process.env.BUILD_SHA || null;
  return NextResponse.json(
    { ok: true, sha, built_at: process.env.BUILD_AT || null },
    { headers: { 'cache-control': 'no-store' } },
  );
}
