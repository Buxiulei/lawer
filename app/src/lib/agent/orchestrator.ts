// app/src/lib/agent/orchestrator.ts
// 一轮对话的编排：装上下文 → 选模型 → tool-loop → 结构化落库 → 收口检查。
//
// 【为什么是「一个函数跑完一轮」而不是一个长期存活的 agent 对象】
// 陪跑是长期关系，但**每一轮都是独立的**：用户可能隔三天回来，服务可能中途重启，
// 状态只能活在库里。把状态放进内存对象意味着重启即失忆，而失忆的法律陪跑比没有更危险
// （它会把上次说过的话再说一遍，用户以为案子没进展）。所以每轮从库里重建全部上下文。
import type { Database } from 'better-sqlite3';

import * as cases from '@/lib/cases';
import { gongdaoSettle, recordTokenUsage, turnRefId } from '@/lib/billing';
import { featureOfMode } from '@/lib/billing/features';
import { costOfUsage, type UsageTokens } from '@/lib/billing/pricing';
import { countSubstantiveHits } from '@/lib/knowledge';
import * as store from '@/lib/db/agent';
import { getRatesForModel } from '@/lib/db/modelRates';
import { fromSql } from '@/lib/db/time';
import {
  getProvider,
  type ChatMessage,
  type Plan,
  type Provider,
  type TaskClass,
  type TokenUsage,
  type UsageReport,
} from '@/lib/llm';
import type { AgentEventSink } from './events';
import { intakeStage, type IntakeStage } from './intake';
import { buildSystemPrompt } from './prompt';
import {
  assessCrisis,
  buildCrisisOpener,
  compactCrisisCard,
  CRISIS_CARD_MARKER,
  CRISIS_SAFE_FALLBACK,
  detectEmotionalLeverage,
  assessNbdpsyEligibility,
  detectNbdpsyPitch,
  stripLeverageSentences,
  stripDuplicateHotlineList,
  extractHotlines,
  stripNbdpsyPitch,
  responseGaveCrisisCard,
  shouldInjectCrisisCard,
} from './crisis';
import { CitationGuard } from './citation-guard';
import {
  articleKey,
  coreArticleKeys,
  coreBlockRenderedKeys,
  CORE_ARTICLE_MAP_PACK_ID,
  renderCoreArticleFallback,
  sceneCoreArticles,
  stripUnsupportedQuotes,
  type CoreArticleSources,
} from './citation-block';
import { bareArticleCitations, precedentContamination } from './citation-block';
import { MAX_INJECTED_PACKS, type KnowledgePack, type KnowledgeSearcher } from './retrieval';
import { loadCaseSnapshot } from './snapshot';
import { classifyTask } from './task-class';
import { AGENT_TOOLS, emitCalcFailureNotice, executeTool, newTurnState, type AgentToolContext } from './tools';

/** 喂进模型的历史消息条数上限。再多不如让档案摘要说话——摘要是结构化的、消息是散的。 */
const HISTORY_LIMIT = 20;

/**
 * tool-loop 最多跑几轮。
 * 8 轮足够「检索 → 落 3 条时间线 → 开 3 张卡 → 收口」这种最重的一轮；
 * 再多基本就是模型在原地打转，与其烧钱不如切断并如实告诉用户。
 */
const MAX_TOOL_ROUNDS = 8;

/**
 * 单次流的空闲超时。
 *
 * lib/llm 的默认值是 90 秒，对**推理模型**不够：实测 C04 S08（危机轮，deepseek-v4-pro）
 * 因为首字前思考超过 90 秒被 abort，整轮回复丢失——而那一轮正是用户说出自伤念头的那一轮。
 * 空闲超时要挡的是「连接挂死」，不是「模型在想」，所以放宽到 240 秒；
 * 真正的挂起仍会在 4 分钟内被切断，总时长上限（lib/llm 默认 900 秒）也还在。
 */
const IDLE_TIMEOUT_MS = 240_000;

/** 与 migrate.ts threads.mode 注释逐字对齐。mode 来自请求体，必须校验——
 *  不校验的话用户传什么就写什么，threads 里会长出一堆枚举外的模式，
 *  而 mode 决定人格与工具集，脏值等于让 agent 在一个没定义过的模式里跑。 */
export const THREAD_MODES = ['问诊', '陪跑', '文书', '录音分析'] as const;

export interface RunTurnInput {
  db: Database;
  caseId: number;
  userId: number;
  /** 用户本轮原话 */
  message: string;
  /** threads.mode。不传则按问诊是否走完自动选「问诊」或「陪跑」 */
  mode?: string;
  /** 套餐档，决定路由到哪个模型。默认 entry */
  plan?: Plan;
  /** lib/knowledge 的检索器（WS4）。不传则走「无依据、保守做法」路径 */
  searcher?: KnowledgeSearcher;
  /** 注入供测试；不传则按 task_class × plan 路由 */
  provider?: Provider;
  now?: Date;
  emit: AgentEventSink;
}

export interface RunTurnResult {
  ok: true;
  threadId: number;
  messageId: number;
  mode: string;
  stage: IntakeStage;
  /** 实际调用的模型（API 串）。评测与日志靠它自证「这轮到底跑在谁身上」 */
  model: string;
  /** 首选模型缺 key 而降级时为 true */
  degraded: boolean;
  taskClass: TaskClass;
  /** 拼好的正文（已入库） */
  text: string;
  actionCards: number;
  drafts: number;
  retrieved: KnowledgePack[];
  finishReason: string | null;
  usage: UsageReport;
  /** 补救后仍未产出行动卡（charter §2 违规），已发 notice 并记录 */
  actionCardMissing: boolean;
}

export type RunTurnOutcome = RunTurnResult | { ok: false; status: number; errorCode: string; message: string };

/** 四桶累加：有一轮报了数就参与求和，从头到尾没报过才留 null（绝不用 0 冒充，见 types.ts） */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const add = (x: number | null, y: number | null) => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
  return {
    prompt: add(a.prompt, b.prompt),
    completion: add(a.completion, b.completion),
    cachedRead: add(a.cachedRead, b.cachedRead),
    cachedWrite: add(a.cachedWrite, b.cachedWrite),
  };
}

/**
 * 本轮记账：token 用量流水 + 公道值结算。
 *
 * 【为什么接在 runTurn 内部而不是 route 层（lead 2026-08-25 定点）】runTurn 是**收敛点**：
 * SSE 路由、评测脚本、日后任何新入口调的都是它，接在这里全都自动记账；
 * 而 route 层是**分叉点**，漏接一个入口就又是一个空账本——那正是本次事故的形状
 *（设施全写好了，只是没人调，三表 0 行而对账报绿）。
 *
 * 【ref_id 约定】`turn-<messageId>`：一轮对话一笔账，与模型往返次数无关。
 * 用量行与消耗流水共用它，对账靠这个键把两侧对起来；重放同一 messageId 由
 * gongdao_ledger 的 (type, ref_id) 唯一索引挡下，不会双扣。
 */
function chargeTurn(args: {
  db: Database;
  userId: number;
  mode: string;
  messageId: number;
  usage: TokenUsage;
  provider: Provider;
  emit: AgentEventSink;
}): void {
  const { db, userId, mode, messageId, usage, provider, emit } = args;
  // 四桶全 null = 本次流根本没回报计量。**不许拿 0 冒充**（llm/types.ts 铁律：
  // null 表示未回报，不可当 0 结算）——记一行 0 成本的用量等于宣称"这轮不要钱"，
  // 而真相是"这轮花了多少我们不知道"。不知道就要让人看见，不是悄悄记成免费。
  if (usage.prompt === null && usage.completion === null && usage.cachedRead === null && usage.cachedWrite === null) {
    emit({
      event: 'notice',
      data: {
        code: 'USAGE_UNREPORTED',
        message: `本轮未收到模型计量回报（${provider.billingModel}），已跳过记账——这一轮的成本未知，不是零。`,
      },
    });
    return;
  }
  // 单桶 null 的常态是「厂商无此档」（如 DeepSeek 无缓存写），按 0 计入即可：
  // 上面已确认本轮**确实回报过**计量，缺的那桶是结构性不存在，不是未知。
  const tokens: UsageTokens = {
    promptTokens: usage.prompt ?? 0,
    completionTokens: usage.completion ?? 0,
    cacheReadTokens: usage.cachedRead ?? 0,
    cacheWriteTokens: usage.cachedWrite ?? 0,
  };
  const refId = turnRefId(messageId);
  const feature = featureOfMode(mode);
  const cost = costOfUsage(tokens, getRatesForModel(db, provider.billingModel));
  // 两笔写入同事务：只落其一正是对账器判的「漏账」（用量无消耗流水），不能自己造出来。
  db.transaction(() => {
    // model=priced 计费键（决定扣多少），apiModel=厂商回显串（决定真跑了哪个快照）——
    // 两串不同是设计如此（厂商 API 不收 dated 串），真漂移是同一 priced 键下 api_model 变化。
    recordTokenUsage(userId, feature, provider.billingModel, tokens, refId, provider.model, db);
    gongdaoSettle(userId, cost, refId, feature, db);
  })();
}

/**
 * 历史消息 → ChatMessage。
 * 只取 user/assistant 的正文，**不重放工具调用**：工具的结果早已落进档案，
 * 而档案摘要就在 system prompt 里。把上一轮的 tool_calls 重放给模型，
 * 它会以为那些动作还没做完，于是再做一遍——重复的时间线事件比缺失更难收拾。
 */
function toHistory(rows: store.MessageRow[]): ChatMessage[] {
  return rows
    .filter((r) => (r.role === 'user' || r.role === 'assistant') && r.content)
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content! }));
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnOutcome> {
  const { db, caseId, userId, emit } = input;
  const now = input.now ?? new Date();

  // 归属校验先行（lib/cases 红线：不是自己的案件与不存在的案件返回同一个错误）
  const owned = cases.getCase(db, { caseId, userId, timelineLimit: 1 });
  if (!owned.ok) return { ok: false, status: owned.status, errorCode: owned.errorCode, message: owned.message };

  const message = input.message.trim();
  if (!message) return { ok: false, status: 400, errorCode: 'EMPTY_MESSAGE', message: '消息不能为空' };

  const snapshot = loadCaseSnapshot(db, caseId);
  const stage = intakeStage(snapshot);
  // 首诊清单没走完就还在问诊，走完了就是日常陪跑——用户不需要自己选模式
  const mode = input.mode ?? (stage === 'done' ? '陪跑' : '问诊');
  if (!(THREAD_MODES as readonly string[]).includes(mode)) {
    return { ok: false, status: 400, errorCode: 'INVALID_MODE', message: `mode 只能是 ${THREAD_MODES.join(' / ')}` };
  }

  const thread = store.ensureThread(db, caseId, mode);
  // 先取历史再落本轮 user 行，免得本轮消息在历史里出现两次
  const history = toHistory(store.listRecentMessages(db, thread.id, HISTORY_LIMIT));
  store.insertMessage(db, { threadId: thread.id, role: 'user', content: message });

  const taskClass = classifyTask({ message, mode });
  const routed = input.provider
    ? { client: input.provider, route: { degraded: false } as const }
    : getProvider(taskClass, input.plan ?? 'entry');

  // 预检索：用用户原话当查询，把命中的 pack 逐字放进 system prompt。
  // 与工具里的 knowledge_search 并存而不是二选一——预检索省掉最常见那一次往返，
  // 工具则让模型在发现自己需要别的卡时能自己去拿。
  const packs = input.searcher ? input.searcher.search(message, { limit: MAX_INJECTED_PACKS }) : [];

  // 危机轮：判据来自 lib/agent/crisis 那一层的纯函数，注入内容也由它给定；
  // 本处只负责把它说的那张卡取回来（IO）并插到最前——它是本轮唯一真正要紧的那张卡。
  // 不经检索排序：危机表述与资源卡用词天然没有词面交集，靠调权重治不好（见 crisis.ts 文件头）。
  const crisis = assessCrisis(message);
  /** 危机资源卡的结构化事实，供确定性首段取号码与描述（只读 facts，不解析正文） */
  let crisisCardFacts: KnowledgePack['facts'];

  // NBDpsy 推介资格：四条件一次算清（manager 2026-08-20 定版），前置禁令与事后兜底共用同一结论
  const distress = store.distressEvidence(db, caseId);
  const nbdpsy = assessNbdpsyEligibility({
    distressEntries: distress.entries,
    distressDistinctDays: distress.distinctDays,
    alreadyReferred: snapshot.referredNbdpsy,
    crisisTurn: crisis.triggered,
  });
  // 24 小时窗口（manager 裁决）只决定**怎么给**，不决定**给不给**。
  //
  // 【实测教训，C04 S08 2026-08-19】起初把窗口做成「窗内不注入」，结果：模型在轮1（用户只是
  // 自我否定）主动给了热线卡，轮2 用户真正说出「要是人没了」时反而因为在窗内而拿不到卡——
  // 那一轮回复里一个号码都没有。用户在最坏的那个时刻要往上翻聊天记录找号码，这不可接受。
  // 所以：**只要本轮触发危机，卡一定进上下文**；窗口只用来切换指令
  // （窗外=给整张卡，窗内=用一句话把号码重述一遍、不重印整张卡）。
  // 这样既守住 manager「永远不存在号码被烧掉的状态」的设计目标，也仍然防住刷屏。
  const lastCardAt = store.lastCrisisCardAt(db, caseId, CRISIS_CARD_MARKER);
  const withinCooldown = !shouldInjectCrisisCard(lastCardAt ? fromSql(lastCardAt) : null, now);
  const alreadyGiven = crisis.triggered && withinCooldown;
  if (crisis.triggered) {
    const card = input.searcher?.get?.(crisis.resourcePackId!);
    if (card) {
      // 窗内只给号码（模型印不出它没见过的整张卡）；窗外首次仍给整张卡。
      const toInject = alreadyGiven ? compactCrisisCard(card) : card;
      const at = packs.findIndex((p) => p.id === card.id);
      if (at >= 0) packs.splice(at, 1); // 预检索可能也捞到了整张卡，换成该给的那版
      packs.unshift(toInject);
      crisisCardFacts = card.facts;
    } else {
      // 取不到不是「这个案子没有对应法条」，是安全关键资料缺失/知识库没装好，必须让人看见。
      emit({
        event: 'notice',
        data: {
          code: 'KNOWLEDGE_UNAVAILABLE',
          message: `危机响应所需的资源卡 ${crisis.resourcePackId} 取不到，本轮无法给出热线号码，请立即检查知识库`,
        },
      });
    }
  }

  // ⭐核心条的取料（S1 档案三来源 / S3 场景映射 / S4 用户原话）一处算清，
  // 注入侧与工具侧共用同一份——两处各算一份就是"同一个问题两个答案"的老形态。
  const coreSources: CoreArticleSources = {
    claims: snapshot.claims,
    openActions: snapshot.openActions,
    deadlines: snapshot.deadlines,
    userMessage: message,
    // 映射表是知识库里的一张方法卡，按 id 硬取（不经检索：它与用户措辞天然没有词面交集）
    sceneArticles: sceneCoreArticles(
      input.searcher?.get?.(CORE_ARTICLE_MAP_PACK_ID),
      snapshot.case.stage,
      snapshot.claims.map((c) => c.kind),
    ),
  };

  /** S3b 本轮定向补入的核心法条卡 id（留痕用，帧序要求它必须在 meta 之后才发） */
  let injectedCoreCards: string[] = [];
  // ── S3b 映射驱动的定向注入（manager 2026-08-25）──
  //
  // 【解的是什么】4e10b7c 批实测：三跑的**预检索注入包全是话术/SOP/判例卡，
  // 一张带 statute_quotes 的法条卡都没有**，⭐ 只能等模型自己调 knowledge_search 时才产生。
  // 于是 #3 那跑模型没调工具 → 取料面 6 张全无原文 → ⭐ 整轮不存在。
  // **把核心条送到模型面前这件事，不能挂在模型自愿调工具上。**
  //
  // 映射表既然已经声明了"这个场景的核心条是哪几条"，系统就该**主动送料**——
  // 这才是陪跑者的产品本意：用户请不起律师，我们不能等他先问对问题才给依据。
  //
  // 【边界】只在 S1 空（首诊形态）且映射命中、且取料面里确实没有该条时补；
  // 补进来的卡去重；总数不超 MAX_INJECTED_PACKS，超了从尾部挤掉**非法条卡**
  //（尾部得分最低，且法条卡是本轮要引全的那种料，不能被自己挤掉）。
  // **只动注入组成，不动检索打分**。
  if (coreSources.sceneArticles?.length && coreArticleKeys({ ...coreSources, retrieved: packs }).size === 0) {
    const have = new Set(packs.flatMap((p) => (p.facts?.statute_quotes ?? []).map((q) => articleKey(q.law, q.article))));
    const want = coreSources.sceneArticles.filter((k) => !have.has(k));
    const extra = (input.searcher?.findByArticleKeys?.(want) ?? []).filter((p) => !packs.some((x) => x.id === p.id));
    for (const card of extra) {
      if (packs.length >= MAX_INJECTED_PACKS) {
        // 从尾部找一张非法条卡挤掉；全是法条卡就不再补（宁可少补，不挤掉原文）
        const victim = [...packs].reverse().find((p) => !(p.facts?.statute_quotes ?? []).length);
        if (!victim) break;
        packs.splice(packs.indexOf(victim), 1);
      }
      packs.push(card);
    }
    // 【为什么记账而不当场 emit】meta 必须是**第一帧**（前端靠它渲染等待态，
    // orchestrator.test 有专门的帧序断言）。这里离 meta 还有几十行，当场发就把 notice 顶到了前面。
    injectedCoreCards = extra.map((p) => p.id);
  }

  // 【空手感知·一处判定】本轮注入包里有几张**够格被引用**的卡。
  //
  // 【为什么不是 packs.length === 0】旧的 KNOWLEDGE_MISS 判的是"有没有卡"，
  // 而尘埃形态的本质是**"总能捞到 6 张，只是全无关"**——length 是 6 不是 0，判据永远不触发。
  // 实测：query「上海高温津贴标准」命中 6 张（北京失业保险金/最低工资/生育津贴判例…），
  // 没有一张与上海或高温津贴有关，而 notice 帧数 = 0。所以判据从"有没有卡"改成**"卡够不够格"**。
  //
  // 【必须写明的区分】**触发空手感知 ≠ 库里没有这张卡**——它只意味着**检索没把料给到手**。
  // 两者修法完全不同：前者是**降级应对**（本指令），后者是**召回改进**（标注/别名/地名税）。
  // 混为一谈会让人以为"空手感知上线了，召回就不用修了"。
  const substantiveHits = countSubstantiveHits(packs, message);
  const emptyPack = substantiveHits === 0;

  const system = buildSystemPrompt({
    snapshot,
    mode,
    stage,
    packs,
    emptyPack,
    coreSources,
    now,
    // 危机指令每次都下发（危机轮的行为纪律逐轮都要生效）；
    // 一次性的是**资源卡本身**，不是「认真对待自伤表述」这件事。
    crisis: crisis.triggered,
    crisisCardAlreadyGiven: alreadyGiven,
    // 生成前就决定够不够格提付费咨询——普通轮是流式的，事后剥句救不回用户已经看到的
    nbdpsyEligible: nbdpsy.allowed,
  });
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: message },
  ];

  // assistant 行先落空壳：行动卡要按 source_message_id 回指它（「这条为什么要做」），
  // 而卡是在流跑到一半时产生的，所以 id 必须先有。content 留 NULL = 生成中（migrate.ts）。
  const messageId = store.insertMessage(db, { threadId: thread.id, role: 'assistant', content: null, model: routed.client.model });

  const state = newTurnState();
  state.retrieved.push(...packs);

  // 案号运行时闸门：白名单来自本轮检索到的 pack 原文，随 knowledge_search 的结果增长。
  // 正文在流上过滤，文书在落库前拒收——两条出口都堵住（见 citation-guard.ts 文件头）。
  const citations = new CitationGuard();
  citations.allowFrom(packs);
  const toolCtx: AgentToolContext = {
    db,
    caseId,
    userId,
    threadId: thread.id,
    sourceMessageId: messageId,
    searcher: input.searcher,
    citations,
    // 工具通道也要执行同一套呈现规则（见 tools.knowledge_search 内注释）
    crisisCardAlreadyGiven: alreadyGiven,
    // 工具通道拿回来的卡也要标⭐（S2 取料面 = state.retrieved，现取）
    coreSources,
    state,
    emit,
  };

  emit({
    event: 'meta',
    data: {
      thread_id: thread.id,
      message_id: messageId,
      mode,
      intake_stage: stage,
      task_class: taskClass,
      model: routed.client.model,
      degraded: routed.route.degraded,
    },
  });

  if (injectedCoreCards.length > 0) {
    emit({
      event: 'notice',
      data: {
        code: 'CORE_ARTICLE_INJECTED',
        message:
          `本轮档案为空且检索未命中核心条，已按场景映射（${snapshot.case.stage}）定向补入 ${injectedCoreCards.join('、')}`,
      },
    });
  }

  // ── 危机轮混合形态（manager 2026-08-20 裁决）──
  // ① 确定性首段：毫秒级下发，不经模型——用户从第一秒起就有人接住、号码立刻到手；
  // ② 模型段整体非流式：全生成完 → 过杠杆闸 → 才下发（杠杆句绝不到达危机中的用户）。
  // 非流式的等待由 ① 消解，且危机轮本身稀少，代价可控。
  let text = '';
  // 首段实际发出的号码。空数组 = 首段没给出号码（卡取不到），此时出口闸**不许剥**模型段
  let openerPhones: string[] = [];
  if (crisis.triggered) {
    // 两态：窗外首次带机构名与时段（描述有安抚价值），窗内复现只给号码行
    const opener = buildCrisisOpener(crisisCardFacts, { compact: alreadyGiven });
    openerPhones = extractHotlines(crisisCardFacts).filter((p) => opener.includes(p));
    // deterministic:true —— 心跳不因它停（模型还没开始出字，那 2-4 分钟正是心跳的主场）
    emit({ event: 'delta', data: { text: opener, deterministic: true } });
    text = `${opener}\n\n`;
  }
  let usage: TokenUsage = { prompt: null, completion: null, cachedRead: null, cachedWrite: null };
  let finishReason: string | null = null;

  /** 跑一次流。emitText=false 时正文不下发给用户（补救轮用，见下方） */
  const runOnce = async (emitText: boolean) => {
    // 每轮开跑前把新检索到的 pack 并进案号白名单：模型「先检索再引用」是正常顺序，
    // 白名单必须能中途扩充，否则它引用刚查到的真案号反而会被拦。
    citations.allowFrom(state.retrieved);
    const gen = await routed.client.chatStream(messages, { tools: AGENT_TOOLS, idleTimeoutMs: IDLE_TIMEOUT_MS });
    let round = '';
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        finishReason = step.value.finishReason;
        // 计量取 generator 的 return 值而不是 onUsage 回调：两者内容一致（types.ts），
        // 但 return 值一定会到，回调只在流里真的出现 usage 帧时才触发。
        // 一轮里跑了几次流就累加几次——tool-loop 的每一次往返都是要付钱的。
        usage = addUsage(usage, step.value.usage.usage);
        const tail = citations.flush();
        if (tail) {
          round += tail;
          if (emitText) emit({ event: 'delta', data: { text: tail } });
        }
        return { text: round, toolCalls: step.value.toolCalls };
      }
      // 过闸门：查无此号的案号在这里就被换成【案号待核实】，用户永远看不到假号
      const safe = citations.push(step.value);
      if (safe) {
        round += safe;
        if (emitText) emit({ event: 'delta', data: { text: safe } });
      }
    }
  };

  // 危机轮把正文攒着不发（emitText=false），等过完闸再一次性下发
  const streamProse = !crisis.triggered;
  let modelBody = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { text: chunk, toolCalls } = await runOnce(streamProse);
    if (crisis.triggered) modelBody += chunk;
    else text += chunk;
    if (toolCalls.length === 0) break;

    // assistant 轮（含工具调用）与逐条 tool 结果回喂，形成下一轮的上下文
    messages.push({ role: 'assistant', content: chunk, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const outcome = executeTool(tc.function.name, tc.function.arguments, toolCtx);
      messages.push({ role: 'tool', content: outcome.content, tool_call_id: tc.id });
    }
  }

  // charter §2 收口检查：一轮回复没有行动卡就不算完成。
  // 补救一次，且**只让它调工具、不下发正文**——用户已经读完了上面那段话，
  // 再流一段重复的解释只会让人以为出了 bug。补救仍失败就如实报，不自己编一张卡凑数。
  let actionCardMissing = false;
  if (state.actionCards === 0) {
    messages.push({
      role: 'system',
      content:
        '【收口检查未通过】本轮回复没有产出任何行动卡，违反 charter §2「每次回复必须以现在做什么收口」。' +
        '现在**只调用 action_card**补 1-3 张（用户情绪危机时补 1 张即可），不要再输出正文。',
    });
    const repair = await runOnce(false);
    for (const tc of repair.toolCalls) {
      const outcome = executeTool(tc.function.name, tc.function.arguments, toolCtx);
      messages.push({ role: 'tool', content: outcome.content, tool_call_id: tc.id });
    }
    if (state.actionCards === 0) {
      actionCardMissing = true;
      emit({
        event: 'notice',
        data: { code: 'ACTION_CARD_MISSING', message: '本轮未能产出行动卡，已记录。请直接问我「现在该做什么」。' },
      });
    }
  }

  // 算钱收口：本轮 claim_calc 试过但一次都没成 → 留一条信号（重试成功则安静）。
  // 必须放在补救轮**之后**：补救轮也可能调 claim_calc，提前收口会把它算成失败。
  emitCalcFailureNotice(toolCtx);

  // 危机轮：模型段过杠杆闸后才下发（manager 2026-08-20 混合形态裁决）。
  // 剥除而不是重生成：重生成要再等 2-4 分钟，而危机轮最不该等；剥句是毫秒级的。
  // 剥完仍命中 → 回落确定性安全回复，模型的话一个字都不下发。
  let leverageOutcome: 'clean' | 'stripped' | 'fallback' = 'clean';
  if (crisis.triggered) {
    let body = modelBody;
    if (detectEmotionalLeverage(body)) {
      body = stripLeverageSentences(body);
      leverageOutcome = 'stripped';
      if (detectEmotionalLeverage(body) || !body.trim()) {
        body = CRISIS_SAFE_FALLBACK;
        leverageOutcome = 'fallback';
      }
    }
    // 首段已经把号码摆在用户眼前了，模型段就不该再整张列一遍（定版批两次 L2 失败的病灶）。
    // 守卫：**只有首段确实发出过号码**才允许剥——openerPhones 为空时一个字都不动，
    // 否则会把唯一一处号码剥掉，L1「危机轮号码必须在场」优先于「别啰嗦」。
    if (openerPhones.length > 0 && leverageOutcome !== 'fallback') {
      body = stripDuplicateHotlineList(body, openerPhones);
    }
    if (body.trim()) {
      emit({ event: 'delta', data: { text: body } });
      text += body;
    }
  }

  // NBDpsy 推介闸：不满足 charter §5「持续焦虑抑郁表现」门槛就剥掉那句。
  // 门槛**不含「本轮是危机轮」**——spec D9 禁止趁人之危观感，而急性危机轮正是提付费咨询
  // 最像趁人之危的时刻；那一刻该给的是免费公益热线，不是我们的付费服务。
  // 挂在输出侧而不是 emotion_log 工具上：模型可以完全不调工具、直接在正文里提（实测如此），
  // 输出侧才是所有通道的共同出口——同一模式的第三次绕过，教训见 crisis.ts。
  // G4 依据纪律的出口侧留痕：只给了条号、附近没有逐字原文的引用。
  // **只发信号不动正文**——引用不完整是「给少了」，剥掉只会让用户连条号都拿不到；
  // 与案号闸门（编造 → 必须拦）分属两类，统计口径分开（教训 6 的同一条纪律）。
  const bareCitations = bareArticleCitations(text);
  if (bareCitations.length > 0) {
    emit({
      event: 'notice',
      data: {
        code: 'CITATION_INCOMPLETE',
        message:
          `本轮有 ${bareCitations.length} 处只给了条号、附近没有逐字原文的引用：${bareCitations.join('、')}。` +
          '用户要拿它去打印、标注、当庭念出来，光一个编号等于空手（charter §3 / G4）。',
      },
    });
  }

  // ISSUE-03 (c)：判例引用句里混进了卡里没有的本案事实。
  // 与光秃条号同一条纪律——**只留痕不改正文**：这是「多给了不属于它的」，
  // 剥掉会把整段判例分析弄得莫名其妙。真正的防线在注入侧（判例引用块）与提示词第 9 条。
  const contaminated = precedentContamination(
    text,
    state.retrieved.filter((p) => p.type === '判例卡'),
    [
      ...snapshot.timeline.map((e) => `${e.title} ${e.detail ?? ''}`),
      ...snapshot.companies.map((c) => c.name),
      message,
    ].join(' '),
  );
  if (contaminated.length > 0) {
    emit({
      event: 'notice',
      data: {
        code: 'PRECEDENT_CONTAMINATED',
        message:
          `判例引用句里混进了卡内不存在的本案事实：${contaminated.join('、')}。` +
          '案号是真的、细节是编的——用户当庭复述会被对方一查即穿（ISSUE-03）。',
      },
    });
  }

  if (detectNbdpsyPitch(text) && !nbdpsy.allowed) {
    text = stripNbdpsyPitch(text);
    emit({
      event: 'notice',
      data: { code: 'NBDPSY_PITCH_BLOCKED', message: `付费咨询推介已剥除：${nbdpsy.reason}。` },
    });
  }

  // 【第五道确定性闸】伪逐字引号引用：引号内被当作法条原文、却在**本轮注入块**里查无此文的，
  // 一律改口「我需要核实原文再引给你」。
  //
  // 为什么这属 G1 零编造而非 G4「给少了」：带引号的逐字引用是最高可信度表达，
  // 用户会原样搬进书状、当庭念出；编一个不存在的子项，后果与编案号完全等同，
  // **且比明显编造更危险——它有真实法条名做外衣**。
  //
  // 比对只对**本轮注入**：没检索却背出来的那次最危险，它没经过任何新鲜度与版本校验。
  const quoteGate = stripUnsupportedQuotes(text, state.retrieved);
  if (quoteGate.stripped.length > 0) {
    text = quoteGate.text;
    emit({
      event: 'notice',
      data: {
        code: 'CITATION_BLOCKED',
        message:
          `检出 ${quoteGate.stripped.length} 处「本轮未检索到、却以引号逐字引用」的法条文本，已改口为待核实：` +
          quoteGate.stripped.map((q: string) => `「${q.slice(0, 24)}…」`).join('、'),
        // 闸自己写下"我剥了哪一条"，下游只读不推断（态⑤分账的唯一依据）
        stripped_articles: quoteGate.strippedArticles,
      },
    });
  }

  // 【核心位保底渲染】⭐核心条在核心位仍然光秃 → 就地补上卡内逐字原文。
  // 放在第五闸**之后**：补的是本轮注入卡里的原文，天然过闸，且不给自己留被剥的机会。
  // 到这一步"哪几条是核心、原文是什么、这一处是不是核心位"系统全都已知，
  // 再把最后一步寄望于模型自觉，就是拿已知的确定性去换概率（见 renderCoreArticleFallback）。
  // 候选池**只算一次**：保底渲染与可观测留痕共用同一个集合。
  // 各算各的会得到两个"本轮候选池"，而留痕的全部意义就是复现渲染当时的依据——
  // 两份就有一份是**事后重新推导**的，那正是我们在 §27 那次吃过的亏（推导≠证据）。
  const coreCandidates = coreArticleKeys({ ...coreSources, retrieved: state.retrieved });
  const fallback = renderCoreArticleFallback(text, coreCandidates, state.retrieved);
  if (fallback.added.length > 0) {
    text = fallback.text;
    emit({
      event: 'notice',
      data: {
        code: 'CORE_ARTICLE_RENDERED',
        message: `核心位仍只给条号的核心依据条 ${fallback.added.join('、')} 已自动补上卡内逐字原文`,
      },
    });
  }

  // 【注入产物可观测】**这四个字段不改变系统做什么，只让我们知道系统做了什么。**
  //
  // 写在这里是因为这是**收敛点**：到这一步候选池算完了、prompt 组完了、保底渲染跑完了，
  // 四个量同时可得。散在各自的分叉点上写，就会变成"记录这件事有四处代码负责"，
  // 而记录只该有一处负责——否则改了一处忘了另一处，留痕自己先分叉。
  //
  // 【为什么无条件发，哪怕全是空】空值是**真信号**（⭐空/没渲染/无实质命中），
  // 只在非空时发就等于把"机制跑了但产出为空"和"这份产物根本不知道"合并成同一件事——
  // 而后者恰恰最该报警。三态语义见 events.ts 的 `injection` 字段注释。
  emit({
    event: 'notice',
    data: {
      code: 'INJECTION_OBSERVED',
      message:
        `本轮注入产物：⭐候选 ${coreCandidates.size} 条、⭐实际渲染 ${coreBlockRenderedKeys(state.retrieved, coreCandidates).length} 条、` +
        `保底补入 ${fallback.added.length} 条、实质命中卡 ${countSubstantiveHits(state.retrieved, message)}/${state.retrieved.length} 张`,
      injection: {
        coreCandidateKeys: [...coreCandidates],
        coreBlockRendered: coreBlockRenderedKeys(state.retrieved, coreCandidates),
        renderAdded: fallback.added,
        substantiveHitCount: countSubstantiveHits(state.retrieved, message),
      },
    },
  });

  // 危机轮情感杠杆：**闸门拦了几次**（运维指标），不再是「对用户说了几次」（事故记录）——
  // 混合形态落地后杠杆句已到不了用户，这里记的是闸门的工作量。
  //
  // 【为什么不重生成】与案号闸门的结构性差异：
  //   · 假案号是**短 token**，能在流上缓冲到闭合再判，用户根本看不到；
  //     情感杠杆是**整句话**，要拦就得缓冲整句——那等于给危机轮加延迟，
  //     而危机轮是全产品最不该加延迟的地方（推理模型首字已要 2-4 分钟）。
  //   · 假案号可原地换成占位符、语义损失可控；一句劝阻话换成占位符只会让回复变得莫名其妙。
  //   · 正文是流式的，检出时用户已经读到了——重生成不能撤回已发送的内容。
  // 所以产线动作是「看得见」而不是「拦得住」：发 notice + 落系统动作，
  // 供人工复核与统计「我们对真实用户说过几次这种话」。
  // 真正的防线仍是 CRISIS_DIRECTIVE 的具体禁令 + 评测侧机械断言（两者共用同一判据）。
  if (crisis.triggered && leverageOutcome !== 'clean') {
    const action = leverageOutcome === 'stripped' ? '已剥除相关语句' : '已回落确定性安全回复';
    emit({
      event: 'notice',
      data: {
        code: 'EMOTIONAL_LEVERAGE_DETECTED',
        message: `本轮模型输出含情感杠杆劝阻，${action}（charter §5）。杠杆内容未下发给用户。`,
      },
    });
    cases.addTimelineEvent(db, {
      caseId,
      userId,
      happenedAt: now.toISOString(),
      kind: '系统动作',
      title: '危机轮杠杆闸拦截',
      detail: `处置：${action}｜消息 #${messageId}`,
    });
  }

  if (citations.found.length > 0) {
    const cited = [...new Set(citations.found.map((v) => v.cited))];
    emit({
      event: 'notice',
      data: {
        code: 'CITATION_BLOCKED',
        message: `已拦下知识库中不存在的案号 ${cited.join('、')}（相应位置显示为「案号待核实」）。这类引用一律不作数。`,
      },
    });
  }

  // KNOWLEDGE_MISS 与空包指令**挂同一判据**（manager 令，不再各判各的）：
  // 两处各判各的，就会出现"指令说这轮没依据、通知说这轮有依据"，用户看到的是自相矛盾的产品。
  if (emptyPack) {
    emit({ event: 'notice', data: { code: 'KNOWLEDGE_MISS', message: '本轮没有检索到可引用的依据，相关结论已按保守做法给出' } });
  }

  // 【EMPTY_PACK 留痕：这是运营指标，不只是排障留痕】**空包率就是召回质量的直接度量。**
  // 按场景分层、按日聚合；上线后若维持在实测的 71% 量级，产品实际上大部分时候在说
  // "我要先核实"——那是必须触发召回攻坚的信号，**不能靠人偶尔想起来去查**。
  // 另一半理由：没有留痕就无法从归档判断"这一轮是没料还是有料没用"，而两者修法完全不同。
  if (emptyPack) {
    emit({
      event: 'notice',
      data: {
        code: 'EMPTY_PACK',
        message: `本轮注入 ${packs.length} 张卡但**无一实质命中**（keyword/applies_to 全不沾边），已按空包轮降级应对`,
        injection: {
          coreCandidateKeys: [],
          coreBlockRendered: [],
          renderAdded: [],
          // 决策口径：**注入前**算的那次（指令是照这个数下的）。
          // 与 INJECTION_OBSERVED 里的那个数可能不同——那个是**轮末**的，
          // tool-loop 里模型自己再检索会把它抬上去。两个数回答两个问题，故意分开留。
          substantiveHitCount: substantiveHits,
        },
      },
    });
  }

  // tokens_json 存 {model, usage}：billing 对账要的是「按哪个计费键、四桶各多少」，
  // 只存四桶会在换模型后对不上账（token_usage.model 与这里必须能互验）。
  // 资源卡落痕按**实际输出**判，而不是按「我们注入了没有」：
  // 模型完全可能自己调 knowledge_search 找到这张卡并给出去（实测发生过），
  // 那一次同样要计入 24 小时窗口，否则用户会连着两轮看见同一张卡。
  if (responseGaveCrisisCard(text)) {
    store.recordCrisisCardGiven(db, caseId, CRISIS_CARD_MARKER, crisis.triggered ? `命中：${crisis.matched.join('、')}` : '模型主动给出');
  }

  const usageReport: UsageReport = { model: routed.client.billingModel, usage };
  store.finalizeMessage(db, messageId, { content: text, tokensJson: JSON.stringify(usageReport) });
  store.touchThread(db, thread.id);
  chargeTurn({ db, userId, mode, messageId, usage, provider: routed.client, emit });

  emit({
    event: 'usage',
    data: {
      model: usageReport.model,
      prompt: usage.prompt,
      completion: usage.completion,
      cached_read: usage.cachedRead,
      cached_write: usage.cachedWrite,
    },
  });
  emit({ event: 'done', data: { message_id: messageId, finish_reason: finishReason } });

  return {
    ok: true,
    threadId: thread.id,
    messageId,
    mode,
    stage,
    model: routed.client.model,
    degraded: routed.route.degraded,
    taskClass,
    text,
    actionCards: state.actionCards,
    drafts: state.drafts,
    retrieved: state.retrieved,
    finishReason,
    usage: usageReport,
    actionCardMissing,
  };
}
