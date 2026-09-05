// app/src/lib/capabilities/families/knowledge.ts
// C 族：法律依据（设计稿 §2 C）。
import * as agent from '@/lib/agent';
import { LABOR_CAPABILITY_COPY } from '@/lib/domains/labor';

import type { Capability } from '../registry';

/**
 * knowledge_search 返回的正文摘要上限。
 *
 * 【为什么摘不是全文】站内 agent 那条通路给的是**逐字全文**（retrieval.ts 讲了为什么：
 * 转述过的法条与编造的法条在用户眼里没有区别）。这里不同：MCP 一次 tools/call 的返回
 * 要整段进对方模型的上下文，而 534 号那张卡单卡就一万两千字，六张卡能把对方一轮的
 * 上下文占满。所以这里给摘要 + citation_guide——**要逐字引用的那几句在 citation_guide 里
 * 是全的**（它拼的是 facts.statute_quotes 的原文），摘要只是让对方知道这张卡讲什么。
 */
const KNOWLEDGE_EXCERPT_MAX = 1200;

/** 知识卡类型枚举，与 lib/agent 的 AGENT_TOOLS.knowledge_search 同一份取值 */
const KNOWLEDGE_TYPES = [
  '法条卡',
  '判例卡',
  '计算规则',
  '流程SOP',
  '文书模板',
  '话术卡',
  '情绪指南',
  '数据卡',
] as const;

export const knowledgeSearch: Capability = {
  name: 'knowledge_search',
  family: 'knowledge',
  // 沿用现有 case:read / case:write 两档权限模型，不为这一个能力新开一个维度：
  // 知识库是公共资料，能读自己案子的 key 读它不多拿到任何东西。
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  // 知识库名字是领域内容，正本在 lib/domains/labor.ts（共用层不写领域字面量）
  title: LABOR_CAPABILITY_COPY.knowledgeSearchTitle,
  description:
    '按自然语言检索法条卡/判例卡/计算规则/流程SOP/文书模板/话术卡/情绪指南/数据卡。' +
    '任何涉法断言、任何数字、任何文书起草之前都先调它——你记忆里的条号和数字一律不可用。' +
    '每张卡带 citation_guide（可直接照抄的引用块）与 confidence；confidence 是「待核实」的' +
    '必须如实转达给用户。检索不到就说查不到，不要编条号和案号。',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '检索词，用案情关键词而非整句话，如「客观情况重大变化 北京口径」',
      },
      type: {
        type: 'string',
        enum: [...KNOWLEDGE_TYPES],
        description: '只要某一类卡时传，一般不传',
      },
      limit: {
        type: 'integer',
        description: `最多几张，默认与上限都是 ${agent.MAX_INJECTED_PACKS}；超出这个范围会被夹回 1~${agent.MAX_INJECTED_PACKS}`,
      },
    },
    required: ['query'],
  },
  run: (_db, _identity, args) => {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    // 先拦空 query 再进检索器：lib/knowledge 对空 query 的约定是抛错
    //（它的「宁可炸也不静默返回空」），而对 MCP 调用方来说这是一个可以自己改正的
    // 入参错误，该走 isError 让模型看见原因，不该长成一个 500。
    if (!query) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'INVALID_QUERY',
        message: 'query 不能为空：给一组案情关键词，比如「经济补偿 计算 北京」',
      };
    }
    // limit 归一到 [1, MAX]，越界一律夹回来而**不报错**：这是对面模型自己填的数，
    // 负数/0/小数/一万都属于它一眼看不出错在哪的填法，为此回一条 isError 只让它白跑一轮。
    // 【夹不住的后果是实测出来的，不是推理】原来的 `Number(x) || MAX` 下：
    //   limit=-5 → 检索器回 **30 张卡**，每张最长 1200 字摘要，一次调用填满对方一轮上下文；
    //   limit=0  → 落回 MAX 看似无害，但 0 本身该被读成「他填错了」而不是「不限」。
    // 两种都返回 200、格式完全正常，没有任何一处会报错。
    // 只有数字（或数字串，有些客户端把入参一律序列化成字符串）才算「他真的给了个数」；
    // true / {} / 'abc' / 没给，都落回默认满额，而不是 Number(true)=1 这种巧合值。
    const asked =
      typeof args.limit === 'number' || (typeof args.limit === 'string' && args.limit.trim())
        ? Math.floor(Number(args.limit))
        : NaN;
    const limit = Number.isFinite(asked)
      ? Math.min(Math.max(asked, 1), agent.MAX_INJECTED_PACKS)
      : agent.MAX_INJECTED_PACKS;
    const type = typeof args.type === 'string' ? args.type : undefined;
    const packs = agent.createKnowledgeSearcher().search(query, { limit, type });
    return {
      query,
      packs: packs.map((p) => ({
        id: p.id,
        title: p.title,
        type: p.type,
        region: p.region,
        confidence: p.confidence,
        updated: p.updated,
        // 与站内 agent 那条通路**同一个函数**产出，两边引用格式逐字一致。
        // 手写第二份的形态是：同一条法条在网页里和在用户自己的助手里长得不一样。
        citation_guide: agent.packCitationGuide(p),
        excerpt:
          p.body.length > KNOWLEDGE_EXCERPT_MAX
            ? `${p.body.slice(0, KNOWLEDGE_EXCERPT_MAX)}……（正文已截断；要逐字引用请照抄 citation_guide）`
            : p.body,
      })),
      note:
        '引用时：法条给条号 + 逐字原文，判例给案号 + 来源，数字给值与生效期间；' +
        'confidence 为「待核实」的必须如实带上这个状态。检索不到就说查不到，不要编。',
    };
  },
};
