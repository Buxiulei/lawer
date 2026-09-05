// app/src/lib/capabilities/families/knowledge.ts
// C 族：法律依据（设计稿 §2 C）。
import * as agent from '@/lib/agent';
import { listPacks } from '@/lib/knowledge';
import { KNOWLEDGE_TYPES } from '@/lib/knowledge/types';
import { LABOR_CAPABILITY_COPY } from '@/lib/domains/labor';

import type { Capability } from '../registry';

/**
 * knowledge_search 默认返回的正文摘要上限。
 *
 * 【为什么默认不是全文】站内 agent 那条通路给的是**逐字全文**（retrieval.ts 讲了为什么：
 * 转述过的法条与编造的法条在用户眼里没有区别）。这里不同：MCP 一次 tools/call 的返回
 * 要整段进对方模型的上下文，而 534 号那张卡单卡就一万两千字，六张卡能把对方一轮的
 * 上下文占满。所以默认给摘要 + citation_guide——**要逐字引用的那几句在 citation_guide 里
 * 是全的**（它拼的是 facts.statute_quotes 的原文），摘要只是让对方知道这张卡讲什么。
 */
const KNOWLEDGE_EXCERPT_MAX = 1200;

/**
 * 单卡全文的硬上限（full_text / knowledge_get 共用）。
 *
 * 【为什么全文也要有上限】"全文"是对方主动要的，但对方要的是这张卡，不是"用这张卡
 * 换掉自己这一轮的全部上下文"。最长的卡一万二千字，`limit=6` 时六张全文一次返回
 * 七万字——返回 200、格式完全正常，只是对方模型那一轮什么都干不了了。
 * 所以给一个够用的上限并**明确标记截断**：截而不标才是真的坑（对方会把半句话当全文引用）。
 */
const KNOWLEDGE_FULL_TEXT_MAX = 8000;

/** 正文按上限截断，并如实回一个 truncated 标记（截了不标 = 对方拿半句话当全文引用） */
function clip(body: string, max: number): { text: string; truncated: boolean } {
  if (body.length <= max) return { text: body, truncated: false };
  return {
    text: `${body.slice(0, max)}……（正文已截断；要逐字引用请照抄 citation_guide）`,
    truncated: true,
  };
}

/**
 * 全库声明为禁用的号码（`facts.hotlines[].status === 'forbidden'`）。
 *
 * 【为什么禁用名单要跨全库取，而不是只看当前这张卡】禁用是**号码的属性**，不是
 * 某张卡的属性：一个被官方否掉的号码出现在哪张卡的正文里都同样不能给用户。
 * 只看当前卡的形态是——号码所在的那张卡拦住了，别处引用到它的卡照常输出。
 *
 * 判据同源：名单本身来自 agent.bannedHotlines（危机首段用的是同一个函数），
 * 这里不另写一套"哪些号码算禁用"的规则。
 */
let bannedCache: string[] | null = null;
function bannedPhones(): string[] {
  if (bannedCache) return bannedCache;
  const all = new Set<string>();
  for (const meta of listPacks()) {
    for (const p of agent.bannedHotlines(meta.facts)) all.add(p);
  }
  bannedCache = [...all];
  return bannedCache;
}

/**
 * 把禁用号码从一段将要交给对方模型的文本里抹掉。
 *
 * 【为什么正文也要抹，而不只是过滤 facts】资源卡的正文里有一行
 * 「⛔ 禁用号码（agent 绝不输出）：<号码>、<号码>」——那行是写给**人**看的说明，
 * 而 MCP 这一侧的读者是**另一个模型**：它拿到的是一段文本，⛔ 与「绝不输出」是散文，
 * 不是约束。号码只要出现在上下文里，就有被转述给用户的那条路径，
 * 而用户拨过去接的是公证处。所以在出口处按号码抹，不指望对方读懂那行字。
 */
function redactBanned(text: string): string {
  let out = text;
  for (const phone of bannedPhones()) {
    if (out.includes(phone)) out = out.split(phone).join('（该号码已被官方核实为无效，不得输出）');
  }
  return out;
}

/** facts 里去掉禁用条目后的热线（禁用号码连同它的名字一起不出现） */
function usableHotlines(facts?: { hotlines?: agent.HotlineFact[] }) {
  const banned = new Set(bannedPhones());
  return (facts?.hotlines ?? []).filter((h) => h?.status !== 'forbidden' && !banned.has(h?.phone));
}

/** 入参里的可选字符串：只有非空串才算"他真的给了"，其余（true / {} / 空串）一律当没给 */
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

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
    `按自然语言检索${KNOWLEDGE_TYPES.join('/')}。` +
    '任何涉法断言、任何数字、任何文书起草之前都先调它——你记忆里的条号和数字一律不可用。' +
    '每张卡带 citation_guide（可直接照抄的引用块）与 confidence；confidence 是「待核实」的' +
    '必须如实转达给用户。默认给摘要，要整张正文时传 full_text=true，或用 knowledge_get 单取一张。' +
    '检索不到就说查不到，不要编条号和案号。',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '检索词，用案情关键词而非整句话，如「客观情况重大变化 北京口径」',
      },
      type: {
        type: 'string',
        // 与站内 AGENT_TOOLS.knowledge_search **同一个数组本身**（不是副本），
        // 唯一真源在 lib/knowledge/types.ts；判据按 `toBe` 断言两处是同一引用。
        enum: KNOWLEDGE_TYPES,
        description: '只要某一类卡时传，一般不传',
      },
      court: {
        type: 'string',
        description:
          '只要某个法院的判例时传，子串即可（如「朝阳」）。传了就只回判例卡——没有审理机构的卡会被滤掉',
      },
      full_text: {
        type: 'boolean',
        description: `传 true 回整张正文（单卡上限 ${KNOWLEDGE_FULL_TEXT_MAX} 字，超出截断并标 truncated）；默认只回 ${KNOWLEDGE_EXCERPT_MAX} 字摘要`,
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
    const type = optionalText(args.type);
    const court = optionalText(args.court);
    // full_text 只认真正的布尔 true 与字符串 'true'：别的值（1 / 'yes' / {}）落回摘要。
    // 往省 token 的方向落回是安全方向——猜错时对方少拿到正文，还能再调一次 knowledge_get；
    // 猜错成全文则是直接吃掉对方一轮上下文，而它当时看不出发生了什么。
    const fullText = args.full_text === true || args.full_text === 'true';
    const max = fullText ? KNOWLEDGE_FULL_TEXT_MAX : KNOWLEDGE_EXCERPT_MAX;
    const packs = agent.createKnowledgeSearcher().search(query, { limit, type, court });
    return {
      query,
      full_text: fullText,
      packs: packs.map((p) => {
        const body = clip(redactBanned(p.body), max);
        return {
          id: p.id,
          title: p.title,
          type: p.type,
          region: p.region,
          confidence: p.confidence,
          updated: p.updated,
          // 与站内 agent 那条通路**同一个函数**产出，两边引用格式逐字一致。
          // 手写第二份的形态是：同一条法条在网页里和在用户自己的助手里长得不一样。
          citation_guide: agent.packCitationGuide(p),
          excerpt: body.text,
          truncated: body.truncated,
        };
      }),
      note:
        '引用时：法条给条号 + 逐字原文，判例给案号 + 来源，数字给值与生效期间；' +
        'confidence 为「待核实」的必须如实带上这个状态。检索不到就说查不到，不要编。',
    };
  },
};

export const knowledgeGet: Capability = {
  name: 'knowledge_get',
  family: 'knowledge',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  title: LABOR_CAPABILITY_COPY.knowledgeGetTitle,
  description:
    '按 id 取一张知识卡的正文与结构化事实（facts）。id 从 knowledge_search 的结果里拿。' +
    '要逐字引用条文、要取一个数、要照着审查规则逐条核对时用它——' +
    'facts 里的 statute_quotes / values / review_rules 是**结构化原文**，比正文散文更该被照抄；' +
    `正文上限 ${KNOWLEDGE_FULL_TEXT_MAX} 字，超出会截断并标 truncated。`,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '知识卡 id，形如 `<域单数>-<slug>`，从 knowledge_search 结果里取' },
    },
    required: ['id'],
  },
  run: (_db, _identity, args) => {
    const id = optionalText(args.id);
    if (!id) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'INVALID_ID',
        message: 'id 不能为空：先调 knowledge_search，从结果里取一张卡的 id',
      };
    }
    const pack = agent.createKnowledgeSearcher().get?.(id);
    // 「这张卡不存在」是对方可以自己改正的入参错误（多半是它自己编了个 id），
    // 走 isError 让它看见原因；不回一个空壳，空壳会被当成"这张卡是空的"。
    if (!pack) {
      return {
        ok: false as const,
        status: 404,
        errorCode: 'PACK_NOT_FOUND',
        message: `没有 id 为 ${id} 的知识卡；id 只能从 knowledge_search 的结果里取，不要自己拼`,
      };
    }
    const body = clip(redactBanned(pack.body), KNOWLEDGE_FULL_TEXT_MAX);
    return {
      id: pack.id,
      title: pack.title,
      type: pack.type,
      region: pack.region,
      confidence: pack.confidence,
      updated: pack.updated,
      citation_guide: agent.packCitationGuide(pack),
      body: body.text,
      truncated: body.truncated,
      // 结构化事实是**代码与模型都该读的那一面**（正文散文只服务人）。
      // 四个字段按需给：没有的不写成空数组，免得对方把「这张卡没有条文」读成「这条法没有原文」。
      facts: {
        statute_quotes: pack.facts?.statute_quotes,
        values: pack.facts?.values,
        // 热线**只给可用的**：禁用号码在这一层就不存在，不指望对方读懂 status 字段
        hotlines: pack.facts?.hotlines ? usableHotlines(pack.facts) : undefined,
        review_rules: pack.facts?.review_rules,
      },
      note:
        '引用时：法条给条号 + 逐字原文，判例给案号 + 来源，数字给值与生效期间；' +
        'confidence 为「待核实」的必须如实带上这个状态。',
    };
  },
};
