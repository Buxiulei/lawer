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
import type { KnowledgePack, KnowledgeSearcher } from './retrieval';

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
        .search(query, { limit: options.limit, type: options.type })
        .map(toPack);
    },
    get(id) {
      try {
        return toPack(knowledge.get(id));
      } catch {
        // 只有「这张卡不存在」会走到这里（get 的唯一失败原因），属于正常的未命中
        return undefined;
      }
    },
  };
}
