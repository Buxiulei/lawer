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

import { loadedPackCount } from '@/lib/knowledge';

/**
 * 本进程手里有多少张知识卡。**运行时取，不是构建期烙的**——
 * 要反映的是"这个正在跑的进程手上有多少张"，构建期的数回答不了"部署时被掏空了没有"。
 *
 * 【三态：数字 / 0 / null，含义完全不同，不许合并】
 *  · 数字   正常，哨兵按 218±预期 核
 *  · 0      索引加载成功但里面是空的（只有显式开了 KNOWLEDGE_ALLOW_EMPTY 才可能走到）
 *  · null   **索引压根加载不出来**（空库拒启、id 重复、路径越界…）
 * 0 与 null 是两种不同的故障，诊断路径也不同；合成一个数就等于把"坏了"和"空了"混为一谈。
 *
 * 【必须与检索同源】取的是 loadIndex() 那个缓存数组的长度，**不为这个端点另读一次 index.json**：
 * packs/ 丢了而 index.json 还在时，另读的那份会报 218 而 agent 手里是空的——
 * 两个真源在故障时各说各话，报出来的是好看的那个。**同源才有分辨力，同值不算。**
 *
 * 【为什么吞掉异常而不是让端点 500】这个端点是哨兵唯一的外部可读面。
 * 索引坏掉时若整个端点 500，**它连 sha 都读不到了**——
 * 一个在故障时自己也失灵的探针，正是这次要消灭的东西。
 * 所以：sha 照常给，kb_cards 给 null，让"哪一层坏了"仍然可分辨。
 */
function kbCards(): number | null {
  try {
    return loadedPackCount();
  } catch {
    return null;
  }
}

export async function GET() {
  const sha = process.env.BUILD_SHA || null;
  return NextResponse.json(
    { ok: true, sha, built_at: process.env.BUILD_AT || null, kb_cards: kbCards() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
