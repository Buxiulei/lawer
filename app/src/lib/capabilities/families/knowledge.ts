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
 *
 * 【为什么导出】crisis_check 的首段与热线表也要过同一道名单（设计稿 §4.4「forbidden 号码
 * 在任何回包中不得出现」）。在那边再拼一份名单，就会出现「知识库这条路拦住了、
 * 危机这条路没拦」——而危机那条正是号码错了代价最大的一条。
 */
let bannedCache: string[] | null = null;
export function bannedPhones(): string[] {
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
export function redactBanned(text: string): string {
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
  rest: { method: 'GET', path: '/api/v1/knowledge/search' },
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

// ─────────────────────────── citation_check（设计稿 §2 C 第三条）───────────────────────────
//
// 【它解决的是什么】模型手上没有原文时，条号与案号是它**最容易凭记忆写出来**的两样东西，
// 而写出来的形态与真条号完全一样：读的人看不出差别，直到当庭被对方拿全文反驳。
// 所以给一个**只回「库里有/没有」**的核验口——它不生成任何依据，只做存在性裁决与逐字回抄。

/**
 * 「判例核验四步法」方法卡的 id。下面四步的**名字与顺序照抄这张卡**，
 * 出参里带上卡 id：要读方法本身，用 knowledge_get 取这张卡。
 */
const PRECEDENT_METHOD_CARD = 'method-panli-heyan-sibufa';

/** 一次最多核几条。超了让对方分批，而不是回一坨吃掉它这一轮的上下文。 */
const MAX_CITATIONS = 20;
const MAX_PRECEDENTS = 10;
/** 判例要旨（holding）摘要上限；要全文用 knowledge_get 取整张卡 */
const HOLDING_MAX = 600;

/** 找不到时统一给这句话——「查不到」必须长成一条指令，而不是一个空字段。 */
const DO_NOT_CITE =
  '库里没有这一条，**不要引用**：不要凭记忆补条号或原文。改用 knowledge_search 找真正的依据；' +
  '找不到就如实告诉用户查不到，按保守做法给建议。';

/** 判决里「法院独立认定」的措辞信号（方法卡第二步给的识别信号） */
const COURT_FINDING_SIGNALS = [
  '本院认为', '本院查明', '本院采信', '本院经审理', '经查明', '经审理查明',
  '裁决', '判决', '应予支持', '不予支持', '予以支持', '未予支持',
];
/** 「当事人主张/自认」的措辞信号——这一类对第三案没有先例价值 */
const PARTY_CLAIM_SIGNALS = [
  '原告主张', '原告称', '被告答辩', '被告辩称', '被告称', '上诉人认为', '上诉人主张',
  '申请人主张', '被申请人辩称', '自认', '答辩状',
];

type StepStatus = 'pass' | 'fail' | 'manual';
interface CheckStep {
  step: number;
  name: string;
  status: StepStatus;
  detail: string;
}

/** 入参里的字符串数组：非数组、空串、非字符串项一律丢掉（宁可少核，不要拿垃圾去匹配） */
function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
}

/** 命中某条逐字原文的卡与那段原文；库里没有收录这一条时返回 undefined。 */
function findQuote(law: string, article: string) {
  const key = agent.articleKey(law, article);
  const packs = agent.createKnowledgeSearcher().findByArticleKeys?.([key]) ?? [];
  for (const p of packs) {
    for (const q of p.facts?.statute_quotes ?? []) {
      // 卡侧与引用侧走**同一个归一函数**取键：卡里存法名全称 + 汉字条号（「中华人民共和国某某法 / 第四十六条」），
      // 对方惯写简称 + 阿拉伯数字 + 项（「《某某法》第46条第2项」）。不归一就对不上键，而对不上键的表现是
      // 「库里明明有原文，却回 found:false」，读起来像修法生效。
      if (agent.articleKey(q.law, q.article) !== key) continue;
      return { quote: q, pack: p };
    }
  }
  return undefined;
}

/** 判例卡可供「否定性核验」搜索的文本范围：结构化案情 + 卡正文 */
function precedentSearchText(pack: agent.KnowledgePack): string {
  const cf = pack.facts?.case_facts;
  return [cf?.gist, cf?.issue, cf?.holding, cf?.reasoning, pack.body].filter(Boolean).join('\n');
}

/** 方法卡四步落成代码：能定的定死，定不了的如实标 manual 并说清要你补什么。 */
function fourStepChecklist(pack: agent.KnowledgePack, terms: string[]): CheckStep[] {
  const cf = pack.facts?.case_facts;
  const reasoning = cf?.reasoning?.trim() ?? '';

  // 第一步：读全文，不靠案号+摘要。
  // 代码能定的那一半：这张卡本身是照原文录的（confidence=原文核实）还是二手转述，
  // 以及卡里到底有没有裁判理由。两者缺一，这条判例按方法卡只能标「仅内部参考」。
  const verbatim = pack.confidence === '原文核实';
  const step1: CheckStep = {
    step: 1,
    name: '读全文，不靠案号+摘要',
    status: verbatim && reasoning ? 'pass' : 'fail',
    detail:
      verbatim && reasoning
        ? `本卡 confidence=原文核实，且录有裁判理由（${reasoning.length} 字）。仍需注意：卡是节录，要逐字引某句判词请回原始出处核对。`
        : `本卡 confidence=${pack.confidence}${reasoning ? '' : '，且卡内没有裁判理由（reasoning 为空）'}——` +
          '只有案号与摘要不足以支撑引用。本条判例只能标「仅内部参考，不得写入对外文书」。',
  };

  // 第二步：区分「当事人自认的事实前提」与「法院独立认定的裁判结论」。
  // 代码只报**措辞信号**，不下结论：卡里的要旨常是转述，没有信号不等于不是裁判认定。
  const scanned = [cf?.holding, reasoning].filter(Boolean).join('\n');
  const courtHits = COURT_FINDING_SIGNALS.filter((s) => scanned.includes(s));
  const partyHits = PARTY_CLAIM_SIGNALS.filter((s) => scanned.includes(s));
  const step2: CheckStep = {
    step: 2,
    name: '区分当事人自认 vs 法院独立认定',
    status: partyHits.length && !courtHits.length ? 'fail' : courtHits.length ? 'pass' : 'manual',
    detail:
      `法院认定措辞：${courtHits.length ? courtHits.join('、') : '未检出'}；` +
      `当事人陈述措辞：${partyHits.length ? partyHits.join('、') : '未检出'}。` +
      (partyHits.length && !courtHits.length
        ? '卡内只检出当事人陈述措辞——你要引的那句很可能是自认而非裁判认定，先例价值为零甚至反向。'
        : courtHits.length
          ? '你打算引的**那一句**属于哪一类，仍要回卡内原文自己判：卡里同时有这两类话。'
          : '卡内两类措辞都没检出（要旨是转述形态），代码分不出来——请取全文自行判断。'),
  };

  // 第三步：否定性核验——不只看它支持了什么，还看你要的那个词它有没有出现过。
  const step3: CheckStep = terms.length
    ? (() => {
        const counts = terms.map((t) => ({ term: t, hits: precedentSearchText(pack).split(t).length - 1 }));
        const missing = counts.filter((c) => c.hits === 0).map((c) => c.term);
        return {
          step: 3,
          name: '否定性核验（你要的那个词，全文出现过吗）',
          status: missing.length ? ('fail' as const) : ('pass' as const),
          detail:
            `${counts.map((c) => `「${c.term}」${c.hits} 次`).join('，')}。` +
            (missing.length
              ? `零出现的词：${missing.join('、')}——说明本案根本没走到这一步，不能作该论点的先例。`
              : '检索范围是**本卡**（结构化案情 + 卡正文），不是判决书原件；卡是节录，零出现更硬、有出现只说明值得去原件核。'),
        };
      })()
    : {
        step: 3,
        name: '否定性核验（你要的那个词，全文出现过吗）',
        status: 'manual',
        detail:
          '先说清你打算用这条判例支持哪个主张，把主张里的关键词（如「连带」「二倍」）放进 assert_terms 再调一次，' +
          '我会在本卡内逐词数出现次数。零出现即不能作该论点的先例。',
      };

  // 第四步：给出【可用 / 不可用 / 反向】结论字段。
  // 代码只能定**下限**：前三步有硬伤就是不可用；没有硬伤不等于可用——「反向」只有读全文才看得出来。
  const failed = [step1, step2, step3].filter((s) => s.status === 'fail');
  const step4: CheckStep = {
    step: 4,
    name: '给出【可用 / 不可用 / 反向】结论',
    status: failed.length ? 'fail' : 'manual',
    detail: failed.length
      ? `第 ${failed.map((s) => s.step).join('、')} 步不通过 ⇒ 结论：**不可用**（仅内部参考，不得写入对外文书）。`
      : '前三步没有硬伤，但「可用 / 不可用 / 反向」是读全文才能下的结论，代码不替你选：' +
        '请在三者中选一个并附一句依据（引哪段判词、用在哪个场景）。**没填这个字段的判例不进对外文书**。',
  };

  return [step1, step2, step3, step4];
}

export const citationCheck: Capability = {
  name: 'citation_check',
  family: 'knowledge',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  title: LABOR_CAPABILITY_COPY.citationCheckTitle,
  description:
    '核验条号与判例：写进任何对外文书或确定结论之前，把你打算引的每一条法条（法名+条号）与每一个判例卡 id 交给它。' +
    '法条回「库里有没有收录这一条」与逐字原文（法名全称、简称、带《》都认同一条）；' +
    '判例回审理机构、案号、要旨，以及判例核验四步法的逐条结论。' +
    '任何一条回 found:false 就是**不要引用**——不要凭记忆补条号、原文或案号。' +
    '它只做核验，不产出依据：要找依据用 knowledge_search。',
  inputSchema: {
    type: 'object',
    properties: {
      citations: {
        type: 'array',
        description: `要核的条文，一次最多 ${MAX_CITATIONS} 条`,
        items: {
          type: 'object',
          properties: {
            law: { type: 'string', description: '法名，全称/简称/带不带《》都行' },
            article: { type: 'string', description: '条号，如「第四十六条」「第46条」「第46条第2项」「第55问」' },
          },
          required: ['law', 'article'],
        },
      },
      precedent_ids: {
        type: 'array',
        description: `要核的判例卡 id（从 knowledge_search 结果里取），一次最多 ${MAX_PRECEDENTS} 个`,
        items: { type: 'string' },
      },
      assert_terms: {
        type: 'array',
        description:
          '你打算用这些判例支持的主张里的关键词（如「连带」）。给了才能做四步法第三步的否定性核验：' +
          '在卡内数这些词的出现次数，零出现即不能作该论点的先例。',
        items: { type: 'string' },
      },
    },
    required: [],
  },
  run: (_db, _identity, args) => {
    const rawCitations = Array.isArray(args.citations) ? args.citations : [];
    const precedentIds = textList(args.precedent_ids);
    const terms = textList(args.assert_terms);

    // 两个数组都空 = 这次调用什么都没要核。回一份空结果会被读成「全都没问题」，
    // 所以走 isError 让对方看见它漏了入参。
    if (!rawCitations.length && !precedentIds.length) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'NOTHING_TO_CHECK',
        message: 'citations 与 precedent_ids 至少给一个：citations 传 [{law, article}]，precedent_ids 传卡 id 数组',
      };
    }
    if (rawCitations.length > MAX_CITATIONS || precedentIds.length > MAX_PRECEDENTS) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'TOO_MANY',
        message: `一次最多核 ${MAX_CITATIONS} 条条文与 ${MAX_PRECEDENTS} 个判例，分批调用`,
      };
    }

    const citations = rawCitations.map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      const law = optionalText(item.law);
      const article = optionalText(item.article);
      if (!law || !article) {
        return {
          law: law ?? null,
          article: article ?? null,
          found: false,
          exact_text: null,
          card_id: null,
          note: 'law 与 article 都必须给（如 law="某某法", article="第四十六条"）；缺一条就无法核验，这一条按未核验处理，不要引用。',
        };
      }
      const hit = findQuote(law, article);
      if (!hit) {
        return {
          law,
          article,
          key: agent.articleKey(law, article),
          found: false,
          exact_text: null,
          card_id: null,
          note: DO_NOT_CITE,
        };
      }
      const text = clip(redactBanned(hit.quote.text), KNOWLEDGE_FULL_TEXT_MAX);
      return {
        law,
        article,
        key: agent.articleKey(law, article),
        found: true,
        exact_text: text.text,
        truncated: text.truncated,
        card_id: hit.pack.id,
        card_title: hit.pack.title,
        card_confidence: hit.pack.confidence,
        law_in_card: hit.quote.law,
        article_in_card: hit.quote.article,
        note:
          '照抄 exact_text，不要改写、不要节选到变味；给条号时用卡里的写法（article_in_card）。' +
          (hit.pack.confidence === '原文核实' ? '' : `本卡 confidence=${hit.pack.confidence}，引用时必须如实带上这个状态。`),
      };
    });

    const searcher = agent.createKnowledgeSearcher();
    const precedents = precedentIds.map((id) => {
      const pack = searcher.get?.(id);
      if (!pack) {
        return { id, found: false, note: DO_NOT_CITE };
      }
      if (pack.type !== '判例卡') {
        return {
          id,
          found: false,
          note: `${id} 是「${pack.type}」，不是判例卡——判例四步法核不了它。要读这张卡用 knowledge_get。`,
        };
      }
      const cf = pack.facts?.case_facts;
      const holding = cf?.holding ? clip(redactBanned(cf.holding), HOLDING_MAX) : null;
      return {
        id,
        found: true,
        title: pack.title,
        court: cf?.court ?? null,
        case_no: cf?.case_no ?? null,
        holding: holding?.text ?? null,
        holding_truncated: holding?.truncated ?? false,
        confidence: pack.confidence,
        checklist: fourStepChecklist(pack, terms),
        method_card: PRECEDENT_METHOD_CARD,
        note:
          (cf?.court ? '' : '本卡没有记录审理机构（court 为空），跨法院援引前请回原始出处核。') +
          (cf?.case_no ? '' : '本卡没有公开案号，写进书状时不要编一个。'),
      };
    });

    return {
      citations,
      precedents,
      assert_terms: terms,
      note:
        'found:false 的一律不要引用，也不要凭记忆补条号、原文或案号——如实说查不到。' +
        `判例四步法的原卡是 ${PRECEDENT_METHOD_CARD}（knowledge_get 可取全文）：四步缺一，判例不进对外文书。`,
    };
  },
};
