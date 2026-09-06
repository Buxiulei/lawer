// app/src/lib/agent/knowledge-adapter.ts
// lib/knowledge（WS4）→ lib/agent 的 KnowledgeSearcher 适配层。
//
// 【为什么要这一层，而不是让 lib/agent 直接调 lib/knowledge】
// 两边的形状本来就不该一样：lib/knowledge 是检索器，它关心 score、filter、缓存；
// lib/agent 关心的只有「给我几张卡的逐字原文」。中间隔一层适配，
// 换检索实现（日后真上向量库）不用动 agent 一行，测试也能注入假搜索器。
// 这一层只做字段对齐，不做任何过滤、排序或摘要——那样会悄悄改变检索语义。
//
// 字段映射：PackHit.content（剥掉 frontmatter 的正文）→ KnowledgePack.body。
// score 不透传：agent 侧对「第 3 名比第 4 名相关多少」没有任何用法，
// 传了只会诱使日后有人拿它做阈值截断，而截断阈值是该由检索器负责的事。
import * as knowledge from '@/lib/knowledge';
import { DEFAULT_DOMAIN } from '@/lib/domains/registry';
import type { KnowledgePack, KnowledgeSearcher } from './retrieval';
import { articleKey } from './citation-block';

function toPack(hit: knowledge.PackHit): KnowledgePack {
  return {
    id: hit.id,
    type: hit.type,
    title: hit.title,
    keywords: hit.keywords,
    applies_to: hit.applies_to,
    region: hit.region,
    confidence: hit.confidence,
    updated: hit.updated,
    body: hit.content,
    // 结构化事实透传：代码消费事实的**唯一读取面**（manager 2026-08-20 根治方向）。
    // 正文散文服务人与模型，facts 服务代码，一卡两面。
    facts: hit.facts,
  };
}

/**
 * 生产用的检索器。
 *
 * 【失败语义】lib/knowledge 对空 query 与不存在的 id 都是抛错（它的「宁可炸也不静默返回空」）。
 * 但对 agent 来说，「检索不到」是一种**必须能正常走下去**的结果——charter §3 为它专门定了
 * 「先按保守做法」的路径。所以这里把「查不到」这一类错误压成空结果，让 charter 的降级路径接管；
 * 而目录缺失、index 与 packs 不一致这类**部署/数据故障**必须继续往上抛：
 * 那不是「这个案子没有对应法条」，那是知识库根本没装好，静默降级等于让全站用户
 * 在没有任何依据的情况下拿到「我需要核实」，而没人会发现。
 */
export function createKnowledgeSearcher(): KnowledgeSearcher {
  return {
    search(query, options = {}) {
      if (!query.trim()) return [];
      return knowledge
        .search(query, { limit: options.limit, type: options.type, court: options.court })
        .map(toPack);
    },
    get(id) {
      try {
        const hit = knowledge.get(id);
        // 【按 id 取也走领域闸】search 这一面已经不会把别的领域的卡的 id 交出去，
        // 但 get 面本身没有守卫，而 id 是可猜的（`<域单数>-<slug>`）、knowledge_get 又是
        // 暴露给 MCP 的只读能力。不闸的形态是：缺省域的会话取回另一个领域的整张卡
        //（含 facts 里的口径），与本域同类卡的口径并排出现在同一个回包里，且一切正常。
        // 【域为什么写死缺省】同 articleIndex：本层拿不到"这轮是哪个领域的案子"。
        if (knowledge.packDomain(hit) !== DEFAULT_DOMAIN) return undefined;
        return toPack(hit);
      } catch {
        // 只有「这张卡不存在」会走到这里（get 的唯一失败原因），属于正常的未命中
        return undefined;
      }
    },
    findByArticleKeys(keys) {
      const want = new Set(keys);
      const out: KnowledgePack[] = [];
      for (const [key, id] of articleIndex()) {
        if (!want.has(key)) continue;
        const pack = this.get?.(id);
        if (pack && !out.some((p) => p.id === pack.id)) out.push(pack);
      }
      return out;
    },
  };
}

/**
 * `法名|条号` → 收录该条逐字原文的卡 id。进程级建一次——
 * 每轮重扫全库是纯浪费，而库是只读的（同 lib/knowledge 的 index 缓存口径）。
 *
 * 【只收缺省领域的卡】这张表是**第二条召回通路**（search 是第一条）：条号对上就把整张卡
 * 拉进上下文。跨域检索默认关闭（设计稿 §13）说的是召回，两条通路都算——只闸住 search
 * 的形态是：检索面干干净净，而模型引一条通用法（如民法典诉讼时效）时，注入回来的是
 * 另一个领域的卡，且回包一切正常、没有一处会报错。
 *
 * 【这一道与 get 面那一道是**冗余的两道**，谁单独在都够】findByArticleKeys 取卡走的是
 * `this.get`，而 get 面自己也有领域闸。实测（P4-W2 三轮变异）：单删这一道 0 红、
 * 单删 get 面那一道 0 红（红的是别的判据），两道同删才红。
 * 所以**别照着"判据没红"去删其中任何一道**——那不代表它没在守，只代表另一道也在守。
 * 真正只钉在 get 面上的判据是 knowledge-adapter.test.ts 里
 *「这条通路的域闸来自 get」那一条：它盯的是"取卡必须经 this.get"这条结构。
 *
 * 【已知未完】这里写死缺省领域，是因为本层拿不到"这轮是哪个领域的案子"。
 * 第二个领域真正接上工具面时，要把域从案件传到这里，不要在这里再加一个默认值。
 */
let articleIndexCache: Map<string, string> | null = null;
function articleIndex(): Map<string, string> {
  if (articleIndexCache) return articleIndexCache;
  const out = new Map<string, string>();
  for (const meta of knowledge.listPacks()) {
    if (knowledge.packDomain(meta) !== DEFAULT_DOMAIN) continue;
    for (const q of meta.facts?.statute_quotes ?? []) {
      if (!q?.article || !q.text?.trim()) continue;
      const key = articleKey(q.law, q.article);
      // 同一条被多张卡收录时取第一张（index 顺序稳定），不做取舍——注入一张就够
      if (!out.has(key)) out.set(key, meta.id);
    }
  }
  articleIndexCache = out;
  return out;
}
