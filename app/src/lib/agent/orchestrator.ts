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
import { reconcileServedModel } from '@/lib/billing/served-model';
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
  applyLeverageGate,
  assessNbdpsyEligibility,
  CRISIS_SAFE_FALLBACK,
  detectCrisisPaidContent,
  detectNbdpsyPitch,
  leverageSubject,
  splitCrisisOpener,
  stripCrisisPaidContent,
  stripDuplicateHotlineList,
  extractHotlines,
  stripNbdpsyPitch,
  responseGaveCrisisCard,
  shouldInjectCrisisCard,
} from './crisis';
import { decideOffer, looksLikeDecline, referralScenesOf, renderReferral } from './referral';
import * as referralOffers from '@/lib/db/referral-offers';
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
 * 【临时处置 · manager 2026-08-25 裁定，修好后撤回】危机轮暂停热线去重。
 *
 * **它解决的是「悬空」，不是「重复」。** 实测：`stripDuplicateHotlineList` 判"重复"只看
 * **含号码的行数 ≥2**，命中后把**所有**含号码的行全删。于是危机轮里
 * 「开头给号码（不用等看完就能打）+ 结尾再给并附照读话术」这种形态被剥成两处悬空句——
 * 「先把号码放这儿：」后面是空的，「接通了可以照这样说：」后面也是空的（号码与照读句同行，一并删）。
 *
 * 四条理由（manager）：
 *  ① **危机轮悬空的代价不可逆**——用户在最坏的那一刻读到一句失效的承诺，
 *     他会以为系统坏了，而他此刻**没有力气再试第二次**；
 *  ② **危机轮刷屏的代价接近零**——多给两遍救命电话不是问题，啰嗦在这一轮根本不算缺点；
 *  ③ **触发形态恰恰是好的干预设计**（开头给 + 结尾给）——**模型越做对越容易触发**；
 *  ④ 范围小、可立即滚更、修好后撤回。
 *
 * ⚠️ **别把它读成「危机轮本就不该去重」**——该去重，只是不能用「见号码就全删」这种去重。
 * 撤回条件：四处修法（「整卡」的定义／`cardShapeAgrees` 的产线真实输入域／悬空指代／
 * **保留第一处、只剥后续重复**）落地后删掉本开关。其中「保留第一处」一条天然连悬空一起解决——
 * 悬空之所以出现，正是因为它把被指代物整个删光了：**一个判断"有重复"的检查，
 * 不该有"全部删除"的处置权。**
 *
 * 注：`stripDuplicateHotlineList` 全仓**只有这一处产线调用点**，且整块在 `crisis.triggered` 内，
 * 所以**本开关关闭 = 它在产线上不再被调用**——**不是"只关掉危机轮那一种情形、别处照旧"**：
 * 别处根本没有调用它的地方。（这句写死，是因为"还有别的路径在去重"这个误解会让后人
 * 以为去重仍在生效，从而不去修真正的问题。）纯函数本身一字未动（四处修法要在它上面做）。
 */
const CRISIS_HOTLINE_DEDUP_ENABLED = false;

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
  /**
   * 本轮在哪个位点推荐了心理咨询（spec D14 的五个可推位点之一）；null = 本轮没推。
   * **manager 明令"推了要在返回里报 scene"**：调用方（SSE 路由、评测、日后的管理端）
   * 不必去翻台账就知道这一轮推没推、推在哪。
   */
  referralScene: string | null;
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
  /** 厂商回显的实际服务型号（本轮最后一次回显者）；null=没回显过 */
  servedModel: string | null;
  emit: AgentEventSink;
}): void {
  const { db, userId, mode, messageId, usage, provider, servedModel, emit } = args;
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

  // ── 型号对账：按**真实服务的**型号计价，不按我们请求的（评测遗留②）──
  // 中转按渠道分组路由，请求 opus 不等于拿到 opus（providers/relay.ts 文件头实测）。
  // 照请求型号收钱就是让用户为没拿到的高档买单——2.5 倍的错账，方向朝着用户吃亏。
  const served = reconcileServedModel(provider.billingModel, servedModel, (m) => getRatesForModel(db, m));
  const cost = costOfUsage(tokens, getRatesForModel(db, served.billingModel));
  if (served.trace) {
    // 告警要当场可见：ledger 的 meta 是给对账脚本看的，notice 是给正在盯这条流的人看的。
    emit({
      event: 'notice',
      data: {
        code: 'SERVED_MODEL_MISMATCH',
        message:
          served.trace.verdict === 'substituted'
            ? `上游实际由 ${served.trace.served} 服务（我们请求的是 ${provider.model}），本轮按两者较低价计价（${served.trace.billed}）。`
            : `上游回显了未登记的型号 ${served.trace.served}（我们请求的是 ${provider.model}），本轮仍按请求型号计价，已留痕待核。`,
      },
    });
  }
  // 两笔写入同事务：只落其一正是对账器判的「漏账」（用量无消耗流水），不能自己造出来。
  db.transaction(() => {
    // model=实际计价键（决定扣多少），apiModel=**厂商回显串**（决定真跑了哪个快照）。
    // apiModel 曾经填的是 provider.model——那是我们自己发出去的常量，
    // 拿它喂对账探针等于比较一个常量和它自己，漂移永远查不出来。回显不到就留 NULL。
    recordTokenUsage(userId, feature, served.billingModel, tokens, refId, servedModel, db);
    gongdaoSettle(userId, cost, refId, feature, served.trace, db);
  })();
}

/**
 * 历史消息 → ChatMessage。
 * 只取 user/assistant 的正文，**不重放工具调用**：工具的结果早已落进档案，
 * 而事实卡就在 system prompt 里。把上一轮的 tool_calls 重放给模型，
 * 它会以为那些动作还没做完，于是再做一遍——重复的时间线事件比缺失更难收拾。
 *
 * 【模式前缀只给异模式的 user 轮】历史现在跨线程取（listCaseMessages），一个案子的
 * "问诊"与"陪跑"并在同一条时间轴上，不标的话模型读到的是一段突然改变语气的连续对话。
 * 但标签**只解决"这句话是在哪个模式下说的"**，所以：
 *   - assistant 轮一律不加。连着几十条 assistant 都以 `[陪跑] ` 开头是最强的 few-shot 信号，
 *     模型会照着在自己的输出开头复写一个 `[陪跑] `——那串字会原样流到用户屏幕上。
 *   - 与本轮同模式的轮次一律不加。同模式没有歧义，加了只是每条多耗 token、多一份噪声。
 * 事实卡里那句"方括号标记是系统加的"仍在，用户原话被前缀改写这件事必须让模型知道。
 */
function toHistory(rows: store.CaseMessageRow[], currentMode: string): ChatMessage[] {
  return rows
    .filter((r) => (r.role === 'user' || r.role === 'assistant') && r.content)
    .map((r) => ({
      role: r.role as 'user' | 'assistant',
      content:
        r.role === 'user' && r.thread_mode !== currentMode ? `[${r.thread_mode}] ${r.content!}` : r.content!,
    }));
}

/**
 * 承诺短语表：**纯字面**，逐条比对，不做任何句法泛化。
 *
 * 【为什么退回字面表（manager 2026-09-02 终局裁决）】上一版是「完成标记 + 动作词 + 对象词」
 * 的语义判定。它确实多抓了几条同义谎话，但四轮收窄，每一轮都把误伤搬到**另一族如实句**上：
 *   第一轮「建议你把材料清单准备好了再去社保中心。」
 *   第二轮「你可以自己建一份待办清单，把这三件事列进去就好了。」
 *   第三轮「你把工资流水传进档案了吗？」
 *   第四轮「你刚才把解除通知存进档案了，我已经看到。」
 * 每一次都是**同一个病**：泛化出来的规则不认施事、不认语气，中文里「已 / 进 / 了」这三个字
 * 本身没有承诺的意思，靠它们组合去猜一句话是不是断言，猜错的方向永远朝着误伤。
 *
 * 【口径：宁可漏判一次谎，也不凭空自我指控一次】
 * 误伤（如实句被判承诺）= 阻断级缺陷；漏判（谎话没抓到）= 可接受。
 * 漏判的代价是"这一轮少了一句纠正"，误伤的代价是**系统对着一句老实话追加一段自我指控**——
 * 用户读到的是一条自相矛盾的回复（真机第 4 行那一轮正是这个形状）。两者不对称，所以判据不对称。
 *
 * 【表的两截】
 *  ① prompt.ts 输出纪律那 12 条禁令字面形：**提示词禁什么，这里就认什么**。
 *    两边各写各的，就会出现"提示词禁了、纠正认不出"，或反过来"纠正在纠正一句我们从没禁过的话"。
 *  ② 复核历次核实的谎话里提炼出的**完整短语**：每条都必须同时带
 *    **施事 + 完成态 + 行动卡/待办**三要素的字面。三要素缺一不收——缺了就会去命中如实句。
 *
 * 【第二截为什么从 14 条砍到 7 条（复核 RV6，manager 2026-09-02 裁决）】
 * 上一版第二截收了 14 条，其中 7 条其实不满足三要素，复核在 c2c1983 上当场抓到 9 条误伤：
 *   · 缺施事（短语本身没说是谁干的，用户干的同样命中）——
 *     「落进档案了」→「你刚才传的三份材料都落进档案了」
 *     「记到档案里了」→「这几个日期你已经记到档案里了吗？」
 *     「写进你的档案了」→「你把三条底线写进你的档案了」
 *     「已经进你的待办了」→「面谈时间已经进你的待办了吗？」
 *     「安排进你的待办了」→「HR 约谈的时间你安排进你的待办了吗？」
 *   · 对象不是行动卡（时间线录入、文书草稿都是**真实发生的工具事件**，说出来不是谎）——
 *     「我已经录入档案」→「你说的两个日期我已经录入档案的时间线，行动卡这轮还没挂」
 *     「为你创建了」→「我已经为你创建了一份异议邮件草稿，在文书页」
 * 这 7 条一并删除。**不许用泛化补回**——泛化正是前四轮的病根。
 *
 * 【故意不收的形】裸的「挂进」「记进档案」「存进档案」「进你的档案」：
 * 「我没能把行动卡挂进档案」是如实报告，「你刚才把解除通知存进档案了」是在说用户，
 * 收进来就把老实话判成谎话。同理不收裸「了」——中文里最没有信息量的那个字。
 *
 * 【已知漏判形态】(本轮实测，见 action-card-promise.test.ts 的谎话组)
 * 字面表天然追不上模型的措辞变体。当前已知会漏的形态：
 *  · 施事词与完成态被数量词/内容词隔开且不成固定串的，如「已为你创建了两张行动卡」之外的同族改写；
 *  · 完全新造的同义动词（如「录进」「归进」「入了档」）；
 *  · 把承诺拆成两句说（「行动卡我处理好了。都在档案里。」）；
 *  · **RV6 删表带来的 7 条**（测试里「已知漏判」组逐条断言 MISS，防止有人日后靠泛化"修"回来）：
 *    「这三件事我已经写进你的档案了」「已为你创建了两张行动卡」「我把上面三件事记到档案里了」
 *    「这几项我已经录入档案」「这几件事已经进你的待办了」「已经把这两件事安排进你的待办了」
 *    「三件事都落进档案了」——它们的字面与如实句完全同形，收了就必然误伤，只能漏。
 * 漏掉的这些**不补进来靠泛化解决**——泛化就是上面那四轮的病根。要补只能补字面：
 * 真机抓到一条新说法，就往表里加一条完整短语，并在判据表的如实组跑一遍确认不误伤。
 */
const ACTION_CARD_PROMISE_PHRASES = [
  // ── ① prompt.ts 输出纪律的 12 条禁令字面形 ──
  '已挂上',
  '已经挂上',
  '已挂进',
  '已经挂进',
  '已挂到',
  '已产出行动卡',
  '已生成行动卡',
  '已记进档案',
  '已经记进档案',
  '帮你记进档案',
  '记进了档案',
  '按截止时间提醒',
  // ── ② 谎话提炼的完整短语：每条**字面**上必须三要素齐全（施事 / 完成态 / 行动卡·待办）──
  // 施事「我」｜完成态「已经…好了」｜对象「行动卡」
  '行动卡我已经建好了',
  // 施事：对象即行动卡，只有系统能产出（用户无从"生成行动卡"）｜完成态「已经…好了」｜对象「行动卡」
  '行动卡已经生成好了',
  // 施事「我给你」｜完成态「好了」｜对象「行动卡」
  '行动卡我给你建好了',
  // 【第七轮删掉的 4 条（复核 RV7，manager 2026-09-02 裁决：三要素必须是字面，不认"隐含施事"）】
  //   「帮你挂上」——缺完成态字面，如实跟踪句「上一轮帮你挂上的两张行动卡，做到哪一步了？」命中；
  //   「我已经替你安排妥当」——短语自身无行动卡/待办；
  //   「加到你的待办清单里了」「落进你的档案了」——无施事，「你把面试加到你的待办清单里了吗」
  //   「你刚才传的三份材料都落进你的档案了」这类用户施事的如实句命中，e2e 实跑已追加自我指控。
  //   四条对应的谎话进「已知漏判」组断言 MISS。**不许改成正则、不许靠泛化补回。**
] as const;

/**
 * 否定：这一句是**如实报告**或在**引述**，不是承诺。
 *
 * 【为什么字面表还需要这一条】纠正段自己那一段里逐字写着「已挂上」「已记进档案」——
 * 它在**引用**模型可能说过的话，好让用户知道以哪一行为准。没有这条排除，
 * 纠正段会命中自己，于是给自己再追加一段纠正。那一句里带着「档案里现在没有这几张卡」，
 * 靠否定认得出来。同族的还有「我没能把行动卡挂进你的档案」「我无法直接生成行动卡」。
 */
const CLAIM_NEGATED = /没能|没有|未能|无法|不能|没法|不了/;

/**
 * 这段正文里有没有**声称行动卡已经存在**的句子。没有就不该有纠正段。
 *
 * 【为什么按句切分，而不是整段找短语】否定排除是**逐句**成立的：
 * 「档案里现在没有这几张卡」否定的是它自己那一句，不该赦免同一段里别处的一句谎话。
 * 断言在一句话里做出，排除也就在一句话里做。
 */
export function claimsActionCardExists(body: string): boolean {
  return body
    .split(/[。！？!?；;\n]+/)
    .some((sentence) =>
      !CLAIM_NEGATED.test(sentence) && ACTION_CARD_PROMISE_PHRASES.some((p) => sentence.includes(p)),
    );
}

/**
 * 【尽力而为的记录性写库：只此一个入口】失败就当这件事没做成，**绝不许拖着落库与记账一起死**。
 *
 * 【分层口径】`store.finalizeMessage` + `chargeTurn` 是一等公民——正文与账丢了是永久损失；
 * 推荐占位 / 危机卡留痕 / 杠杆闸留痕是**记录性**的，丢了只影响下一轮的去重与统计。
 * 这两类排在同一段收尾代码里，却不该同生共死。
 *
 * 【为什么是一个函数，而不是各包各的 try】(复审 2026-09-02 RV2-①)
 * 上一轮给 `referralOffers.tryOffer` 与 `store.recordCrisisCardGiven` 各包了一层 try/catch，
 * **漏掉了排在它们前面的杠杆闸留痕**（`cases.addTimelineEvent`）。故障注入实测：
 * `BEFORE INSERT ON timeline_events WHEN NEW.title='危机轮杠杆闸拦截' RAISE(ABORT)`
 * ⇒ 危机轮 content 停在 NULL、token_usage 0、gongdao_ledger 0——**F-02 原样复发**。
 *
 * 独立写 N 次就会忘第 N 次，那是**默认形态而不是疏忽**：所以收成唯一入口，
 * 再加一条结构守卫钉住「`finalizeMessage` 之前不许有裸的记录性写库调用」
 *（best-effort-writes.test.ts，改回裸调用即红）。新增一个同类写库时，
 * 守卫会点名，而不是等下一次故障注入才发现。
 *
 * 【吞但不静音】错误进 `console.error('[chat] …')`：事后要能从服务端日志查到是哪一步断的。
 */
function bestEffort<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.error(`[chat] ${label}`, err);
    return fallback;
  }
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnOutcome> {
  const { db, caseId, userId } = input;
  const now = input.now ?? new Date();

  /**
   * 【下发失败不许掀翻这一轮】——**"给用户看"是一条链，"记进档案 / 记账"是另一条，
   * 前者断了不该传染后者。**
   *
   * 实测事故（2026-09-02 真机）：用户读完回答后离开或刷新，SSE 的 controller 随之关闭，
   * 此后每一次 `controller.enqueue` 都抛 `TypeError: Invalid state: Controller is already closed`。
   * 那个异常是从 `timeline_add` 里的 `ctx.emit` 抛出来的，于是一路掀翻整个 tool-loop：
   *   · 排在它后面的 `action_card` / `deadline_set` **再也不会执行**
   *     → 时间线写进去了，`action_items`／`deadlines` 恒空（这就是"承诺了行动卡却没有卡"）；
   *   · `store.finalizeMessage` 与 `chargeTurn` 永远走不到
   *     → assistant 行的 content 停在 NULL（刷新后那一轮**永久消失**）、账本一行不落。
   * 三个症状一个病因。而用户走开与我们该不该记账无关——**模型的钱已经花掉了**。
   *
   * 【为什么包在 runTurn 而不是各调用点】与 `chargeTurn` 同一条理由：runTurn 是**收敛点**，
   * SSE 路由、评测脚本、日后任何入口调的都是它；包在调用点上就是"漏接一个入口即失效"。
   *
   * 【为什么断一次就彻底停发】连接已经没了，后面每一帧都会再抛一次——
   * 继续试只是把同一个异常重复吞 20 遍，还会掩盖真正第一现场的那条日志。
   */
  let sinkBroken = false;
  const emit: AgentEventSink = (e) => {
    if (sinkBroken) return;
    try {
      input.emit(e);
    } catch (err) {
      sinkBroken = true;
      // 吞掉但不静音：这一轮之后的帧用户都收不到了，这件事必须能在服务端日志里查到。
      console.error('[chat] SSE 下发中断，本轮改为静默跑完（落库与记账照常）', err);
    }
  };

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
  // 先取历史再落本轮 user 行，免得本轮消息在历史里出现两次。
  //
  // 【按 case 取而不是按 thread 取】线程是按 mode 分的（ensureThread），而 mode 由服务端按
  // 首诊进度自己切（问诊 → 陪跑）。按 thread 取的话，首诊走完的那一刻历史清零——
  // 用户在同一个输入框里连续说话，模型却突然什么都不记得了。取数范围从 thread 扩到 case，
  // 条数上限不变（HISTORY_LIMIT），所以每轮 input token 不增加。
  const history = toHistory(store.listCaseMessages(db, caseId, HISTORY_LIMIT), mode);
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
  // ── D14 品牌推荐（spec D14/D15，2026-08-25 用户拍板）──
  // 判定与写库分三步，顺序不能换：**先认拒绝 → 再判位点 → 开口前占位**。
  //
  // 【第一步：先认拒绝】必须在判位点之前。倒过来的话，用户这一轮说的"不需要"要到下一轮才生效，
  // 而这一轮我们可能正好又推了一次——**用户会觉得自己的拒绝没被听见，那比没推过更糟。**
  //
  // 【拒绝只在"我们刚问过"的那一轮认】判据落在**上一条 assistant 消息是不是那次推荐**上：
  // 台账 note 里记着推荐时的 messageId，与本 thread 最后一条 assistant 消息比对。
  // 不这么钉的话，用户在任何时候说"不需要"（不需要这份证据、不需要开庭…）都会被读成拒绝推荐。
  const lastOffer = referralOffers
    .listByUser(db, userId, 20)
    .find((r) => r.outcome === 'offered' && r.thread_id === thread.id);
  if (lastOffer && looksLikeDecline(message)) {
    const lastAssistant = store.lastAssistantMessageId(db, thread.id);
    if (lastAssistant !== null && lastOffer.note === `message #${lastAssistant}`) {
      referralOffers.recordDecline(db, {
        userId,
        caseId,
        scene: lastOffer.scene,
        threadId: thread.id,
        note: `用户原话：${message.slice(0, 60)}`,
      });
      emit({
        event: 'notice',
        data: {
          code: 'REFERRAL_DECLINED',
          message: '已记下你不需要心理咨询的推荐，此后不会再主动提。你随时想问都可以直接问我。',
        },
      });
    }
  }

  // 【第二步：判位点】纯函数只读档案，不看本轮说了什么——见 referral.ts 该段注释。
  const referralDecision = decideOffer({
    scenes: referralScenesOf({ snapshot, distressEntries: distress.entries, distressDistinctDays: distress.distinctDays }),
    crisisTurn: crisis.triggered,
    stopOffering: referralOffers.shouldStopOffering(db, userId),
    intakeStage: stage,
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
  const emptyPackDetected = substantiveHits === 0;

  // 【危机轮豁免空包告知（manager 2026-08-25，先修不等实测）】
  //
  // 【冲突】S08 危机场景实测 **92/92 轮全尘埃** → 危机轮会 **100%** 触发空包告知。
  // 而空包告知要求模型"问清 1–3 个关键事实""明说我先去核实依据"——
  // 用户刚说完"三十五岁不到就已经废了"，系统回他"这一问我要先核实依据"，
  // **那是把人推开**。危机轮要给的是热线和陪伴，不是问诊流程。
  //
  // 【为什么不等实测再改】实测只能说"这次没带偏"，而**模型有随机性、危机轮的伤害不可逆**；
  // 且这一轮里空包告知要解决的问题**本就不存在**——危机轮模型本来就不该给条号和数字。
  // **收益为零、风险为正，这是设计题不是实证题。**
  //
  // 【为什么必须是豁免，而不是改措辞（manager 定性）】
  // **空手感知的逻辑是"没把握就别给"，危机轮的逻辑是"必须给"；
  // 两者不是措辞冲突，是原则冲突。而原则冲突不会被措辞调整解决，只能靠场景豁免。**
  //
  // 风险有**两条独立路径**，本豁免同时挡住两条（验收要分别验）：
  //  · 路径一·措辞层面：流程性回应（"我先核实"）把人推开；
  //  · 路径二·行为层面：空手感知教模型"没料时更谨慎地开口"，
  //    可能**压抑危机轮该有的果断给号**——危机资源卡是**必须给**的，不是"手上没料就别说"。
  //
  // 【为什么不做"危机版措辞"】危机轮已经有确定性热线段 + CRISIS_DIRECTIVE，
  // 再叠一段"你手上没有依据"只会**稀释危机指令**——与"5 个位子会把库里几乎所有情绪卡
  // 倒进去、反而稀释危机指令"同族。**在危机轮，少说比多说安全。**
  //
  // 【检测与注入分开】豁免的只是**给模型的指令**；EMPTY_PACK 指标照常记——
  // 危机轮 92/92 全尘埃正是召回质量最该被看见的那一块，
  // 豁免了指令还把指标一起关掉，等于把问题连同告警一起藏起来。
  const emptyPack = emptyPackDetected && !crisis.triggered;

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
    // 【D14 之后恒为 false，不再看资格 —— 与出口闸对齐】
    // 出口侧现在**一律剥除模型自己的推销**（推荐只走产品的确定性推荐段，须占位并落台账）。
    // 那么提示词就不该再留一个"够格时可以提"的口子：**允许模型做一件我们随后必剥的事，
    // 只会制造一堆没有意义的剥除通知，并让模型的合规行为看起来像违规。**
    // 指令与闸必须说同一句话。（`nbdpsy` 的资格计算仍保留：它还在给 notice 提供理由文本。）
    nbdpsyEligible: false,
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
  // 本轮实际服务我们的型号（厂商回显）。tool-loop 每次往返都可能落到不同上游渠道，
  // 这里取**最后一次回显**：一轮只记一笔账，也就只能挂一个计费键。
  // 若某轮没回显（null），保留此前见过的值——「这一段没说」不等于「换回请求的型号了」。
  let servedModel: string | null = null;

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
        servedModel = step.value.usage.servedModel ?? servedModel;
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
  /** 闸剥掉的原句留痕——归档正文是闸后产物，不写下来就永远查不到它剥了什么 */
  let strippedSentences: string[] = [];
  if (crisis.triggered) {
    // 【来源判别的比对面：用户自己说过的话】本轮原话 + 本 thread 的历史用户消息。
    // 复述用户原话是 charter §5「先接住」/§6「引用他说过的细节」的产物，不是杠杆——
    // **复述是把他自己的话还给他，杠杆是把别人的痛苦加给他。**
    //
    // 【为什么经 leverageSubject 而不是直接调检测器】(2026-08-26) 检测器不再导出：
    // 产线与评测**只能**通过这个构造函数交出「判什么文本 + 用户语料」两件输入，
    // 于是"两边传不同输入"从"不该写"变成了"写不出来"。缘由见 crisis.ts 该段注释。
    const gate = applyLeverageGate(
      leverageSubject({
        modelBody,
        userTurns: [message, ...history.filter((h) => h.role === 'user').map((h) => h.content)],
      }),
    );
    let body = gate.text;
    leverageOutcome = gate.outcome;
    strippedSentences = gate.stripped;
    // 首段已经把号码摆在用户眼前了，模型段就不该再整张列一遍（定版批两次 L2 失败的病灶）。
    // 守卫：**只有首段确实发出过号码**才允许剥——openerPhones 为空时一个字都不动，
    // 否则会把唯一一处号码剥掉，L1「危机轮号码必须在场」优先于「别啰嗦」。
    if (CRISIS_HOTLINE_DEDUP_ENABLED && openerPhones.length > 0 && leverageOutcome !== 'fallback') {
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

  // 【D14 之后这道闸守的是什么，变了，写清楚】
  // 旧口径：不够格提付费咨询就剥（`nbdpsy.allowed`）。
  // 新口径：**模型段一律不许自己推销**——推荐只有一条合法通道，就是下面那段确定性推荐段。
  //
  // 【为什么收得更死而不是更松】D14 把推荐变成了产品动作，于是"推没推过"要**可审计**：
  // 台账 `referral_offers` 将来要用来证明"我们没有反复骚扰用户"。
  // 模型自己在正文里提一句，**不占位、不落行、不受频控** ——
  // 那样这张台账就不再是证据，而是一份**看起来完整的**残缺记录。
  // 所以：模型说的一律剥，我们说的一律落账。**唯一通道 = 唯一真源。**
  if (detectNbdpsyPitch(text)) {
    text = stripNbdpsyPitch(text);
    emit({
      event: 'notice',
      data: {
        code: 'NBDPSY_PITCH_BLOCKED',
        message: '模型段自行提及付费心理咨询，已剥除（spec D14：推荐只走产品的推荐段，须占位并落台账）。',
      },
    });
  }

  // 【D15 兜底 · L1】危机轮：付费入口 / 价格 / 预约链接一个都不许留。
  // 它一旦开火就是事故信号——推荐段在危机轮根本不生成，只可能是模型绕过工具直接在正文里说。
  if (crisis.triggered) {
    const paid = detectCrisisPaidContent(text);
    if (paid) {
      // 【只剥模型段，且必须有剥空兜底】(评测官 2026-08-26 指出：这道闸原本剥完就走)
      // 杠杆闸早就有兜底（剥空 → CRISIS_SAFE_FALLBACK），这道没有——于是危机轮里
      // **正文可能被整段掏空，用户只剩确定性首段**，而那正是级联放大器最坏的形态。
      // 确定性首段不参与剥除：它是我们自己的固定文本，且是危机轮里唯一保证在场的号码来源。
      const { opener, body } = splitCrisisOpener(text);
      const kept = stripCrisisPaidContent(body);
      const emptied = !kept.trim();
      text = opener ? `${opener}\n\n${emptied ? CRISIS_SAFE_FALLBACK : kept}` : (emptied ? CRISIS_SAFE_FALLBACK : kept);
      emit({
        event: 'notice',
        data: {
          code: 'CRISIS_PAID_CONTENT_BLOCKED',
          // 【措辞要说准，因为这条挂着 L1 的否决权】(评测官 2026-08-26)
          // 「出现付费内容」与「模型在算赔偿」是两件性质完全不同的事，后者属 L2
          //「危机轮继续推进案情」。判据侧已按同句法律钱款语境把赔偿数字排除在本闸之外，
          // 所以走到这里的命中**确实是商业内容**——但把片段原样写进 notice，
          // 让人一眼能自己复核，而不是只能相信这条 L1。
          message:
            `危机轮出现付费/预约内容「${paid}」，已整句剥除（spec D15，L1 红线：此刻只给免费公益热线）。` +
            (emptied ? '剥后模型段为空，已回落确定性安全回复。' : ''),
        },
      });
    }
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
        message:
          `本轮模型输出含情感杠杆劝阻，${action}（charter §5）。杠杆内容未下发给用户。` +
          (strippedSentences.length ? `被剥 ${strippedSentences.length} 句。` : ''),
        stripped_sentences: strippedSentences,
        leverage_outcome: leverageOutcome === 'fallback' ? 'fallback' : 'stripped',
        // 闸前原文：fallback 时归档正文里一个字都不剩，不留它就永远重建不出模型说了什么
        model_body_raw: modelBody,
      },
    });
    // 【同为"尽力而为"那一类】这条留痕排在 `finalizeMessage` 之前，抛出去就是危机轮的
    // 正文停在 NULL、这一轮不记账——用户刚说完"要是人没了"，那一轮反而是最不能丢的。
    // 拦截统计丢一条只影响人工复核的计数。分层与入口见 bestEffort。
    bestEffort('危机轮杠杆闸留痕失败（本轮落库与记账照常，这次拦截不进时间线）', () =>
      cases.addTimelineEvent(db, {
        caseId,
        userId,
        happenedAt: now.toISOString(),
        kind: '系统动作',
        title: '危机轮杠杆闸拦截',
        detail: `处置：${action}｜消息 #${messageId}`,
      }), undefined);
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
  // 【KNOWLEDGE_MISS 挂"是否注入"，不挂"是否检出"（lead 裁定 2026-08-25）】
  //
  // **用户刚说完"要是人没了"，屏幕上弹一句"本轮没有检索到可引用的依据"——
  // 那是系统在谈论自己的能力，而不是在回应这个人。** 危机轮里"系统有没有依据"
  // 对用户毫无意义：他需要的是热线和"我在这儿"，不需要知道我们的检索状态。
  // 这与豁免指令是同一个理由的两面——**指令是让模型别谈依据，通知是让系统自己也别谈**。
  //
  // 【与 manager"挂同一判据"的关系：同源没破，是同源被理解窄了】
  // 同源要求的是**两者不矛盾**（防"指令说没依据、通知说有依据"），不是"两者都必须触发"。
  // 正确的归位是三个量各归其位：
  //   是否**检出**空包 → EMPTY_PACK 指标（**内部，必须记**）
  //   是否**注入**告知 → 指令 + 本通知（**外部，危机轮一起静默**）
  // 更一般的一条：**内部指标要看见，外部通知要克制**——同一个事实，
  // 对我们是必须记录的信号，对用户可能是噪音甚至伤害，两者不该共用一个开关。
  //
  // 【`input.searcher` 这个条件不能少】没有检索器时本轮**根本没去找**，
  // 而这句通知说的是"找了没找到"。把"没去找"说成"找了没找到"是又一次
  // 把"我没拿到这个输入"读成"这件事没发生"——无检索器另有 KNOWLEDGE_UNAVAILABLE 管。
  if (emptyPack && input.searcher) {
    emit({ event: 'notice', data: { code: 'KNOWLEDGE_MISS', message: '本轮没有检索到可引用的依据，相关结论已按保守做法给出' } });
  }

  // 【EMPTY_PACK 留痕：这是运营指标，不只是排障留痕】**空包率就是召回质量的直接度量。**
  // 按场景分层、按日聚合；上线后若维持在实测的 71% 量级，产品实际上大部分时候在说
  // "我要先核实"——那是必须触发召回攻坚的信号，**不能靠人偶尔想起来去查**。
  // 另一半理由：没有留痕就无法从归档判断"这一轮是没料还是有料没用"，而两者修法完全不同。
  if (emptyPackDetected) {
    emit({
      event: 'notice',
      data: {
        code: 'EMPTY_PACK',
        message:
          `本轮注入 ${packs.length} 张卡但**无一实质命中**（keyword/applies_to 全不沾边）` +
          `${crisis.triggered ? '；本轮为危机轮，**已豁免空包告知指令**（指标照记）' : '，已按空包轮降级应对'}`,
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

  // ── 行动卡承诺纠正段（F-09）：**承诺了却没落库，必须当场说清，且说进档案** ──
  //
  // 【实测事故】真机 staging 库：某一轮正文写着「两张行动卡已挂上，系统会按截止时间提醒你」，
  // 而该案 `action_items` 一张都没有。补救轮已经跑过（`actionCardMissing` 即"补救之后仍然没有"），
  // 唯一的信号是 `ACTION_CARD_MISSING` 这条 notice——而它在前端映射表里是 `null`，
  // **屏幕上一个字都不出**。于是用户读到一句承诺、点开档案空的、没有任何地方说过它失败了。
  //
  // 【为什么写进正文而不是把那条 notice 改成可见】notice 是**流帧**，刷新即消失；
  // 而那句骗人的承诺是**归档正文**的一部分，永久留在历史里。纠正必须和它同寿命，
  // 否则 F5 之后又回到「正文承诺了、档案空的、没人解释」——F-02 修的正是这条刷新链路。
  //
  // 【为什么不去正文里把那句话剥掉】它已经逐字流给用户了。事后从归档里抹掉，
  // 就成了「用户看见过、档案里没有」——推荐段注释里那句"审计上最坏的一种不一致"，方向相反而已。
  // 所以是**追加纠正**，不是删除。
  //
  // 【位置】与推荐段同理：放在所有出口闸之后（它是我们自己的确定性文案，不该被闸剥），
  // 且必须在 `finalizeMessage` 之前进 `text`。排在推荐段之前，让推荐段稳居末尾。
  //
  // ── 两个前提，缺一不许追加（复审 2026-09-02 定）──
  //
  // 【① 正文里确有承诺句】纠正的对象是**一句具体的谎**，不是"这一轮没有卡"这件事。
  // 只判 `actionCardMissing` 就是无条件触发：真机第 4 行「按上面那张行动卡先做第一件」
  // 这一轮一个字的承诺都没有，却会被永久追加一段"我没能把行动卡挂进你的档案"——
  // **系统凭空自我指控**，而"这一轮没产出卡"该由 ACTION_CARD_MISSING 那条 notice 记，
  // 那是运维信号，不是给用户看的忏悔。判据表见 claimsActionCardExists（语义判定 ∪ 提示词禁令原文）。
  //
  // 【② 不是危机轮】这是 KNOWLEDGE_MISS 那条注释**亲手写过的反面**：
  // 用户刚说完"要是人没了"，归档正文里多出一段「补一句实话：这一轮我没能把行动卡
  // 挂进你的档案」——那是系统在谈论自己的能力，而不是在回应这个人。
  // 危机轮一律静默：notice 照发（内部指标要看见），归档正文一个字都不加（外部通知要克制）。
  //
  // 【为什么那句加粗后面必须换行】(复审 2026-09-02 RV2-②) 真机 DOM 实测这一段渲染成
  // `<p>**补一句实话：……。**上面正文里…</p>`——**strong 计数 0，星号原样摊在屏幕上**。
  // 根因是 CommonMark 的 right-flanking 规则：闭合的 `**` 前面是「。」（标点）、
  // 后面是「上」（既非空白也非标点），两条都不满足，于是它**不成其为闭合定界符**。
  // 这不是渲染器的毛病，中文标点紧跟加粗收尾就是这个下场。
  // 修法是让这一句**自成一段**：闭合 `**` 后面跟空行，右侧是空白就能闭合。
  // 判据钉在 action-card-correction-render.test.tsx（真渲染器出 AST，去掉换行即红）。
  if (actionCardMissing && !crisis.triggered && claimsActionCardExists(text)) {
    const correction =
      '\n\n---\n\n' +
      '**补一句实话：这一轮我没能把行动卡挂进你的档案。**\n\n' +
      '上面正文里如果出现了「已挂上」「已记进档案」这类说法，以这一行为准——档案里现在没有这几张卡。' +
      '你回我一句「把上面几件事记进档案」，我就补上。';
    emit({ event: 'delta', data: { text: correction } });
    text += correction;
  }

  // ── D14 推荐段：**独立段落追加在正文之后，绝不插进正文中间** ──
  //
  // 【为什么放在所有出口闸之后】它是我们自己的确定性文案，不该被判「模型在推销」的那道闸剥掉；
  // 而它又必须在 `store.finalizeMessage` 之前进 `text`，否则归档里没有它——
  // **用户看见了、档案里没有，是审计上最坏的一种不一致。**
  //（这一段此前排在 finalizeMessage 之后，注释与代码正好说反了：推荐段下发给了用户，
  //  归档正文里却没有它。同批修的还有帧序——它插在 usage 与 done 之间，
  //  把「usage / done 是最后两帧」这条契约在推荐轮里撞坏。）
  //
  // 【先占位再开口】`tryOffer` 返回 true 才拼文案。倒过来（先说后记）一旦记录那步失败，
  // 下一轮会再推一遍——**反复骚扰就是这么来的**（referral-offers.ts 的原话）。
  // **一轮最多成一次**：按序试，第一个占位成功的就是本轮的推荐，其余不再试。
  //
  // 【为什么这里走 bestEffort】(复审 2026-09-02) 推荐段被挪到 `finalizeMessage` **之前**
  // 是对的（否则用户看见了、档案里没有），但代价是它成了收尾链上的一环：
  // `referral_offers` 的 INSERT 一抛（撞约束、库被锁、磁盘满），异常就穿出 runTurn，
  // 正文停在 NULL、这一轮不记账——**F-02 原样复发，只是换了个病灶**。
  // 分层与唯一入口见 `bestEffort` 的注释：一等公民照抛，记录性写库一律尽力而为。
  //
  // 【失败一律当"没占到位"】方向与「先占位再开口」一致：占位这步没成功就不开口。
  // 反过来（占不到也照说）会在写库恢复之后变成"台账里没有、用户已经被推过"——
  // 下一轮再推一遍，正是这段注释开头要防的那种反复骚扰。
  let referralScene: string | null = null;
  for (const scene of referralDecision.scenes) {
    const claimed = bestEffort(`推荐位点「${scene}」占位失败（本轮不推，落库与记账照常）`, () =>
      referralOffers.tryOffer(db, {
        userId,
        caseId,
        scene,
        threadId: thread.id,
        note: `message #${messageId}`,
      }), false);
    if (claimed) {
      referralScene = scene;
      const block = `\n\n---\n\n${renderReferral(scene)}`;
      emit({ event: 'delta', data: { text: block } });
      text += block;
      emit({
        event: 'notice',
        data: {
          code: 'REFERRAL_OFFERED',
          message: `本轮在「${scene}」位点推荐了一次心理咨询，同一位点不再推第二次。`,
          referral_scene: scene,
        },
      });
      break;
    }
  }

  // tokens_json 存 {model, usage, servedModel}：billing 对账要的是「按哪个计费键、四桶各多少、
  // 上游实际回显了谁」，只存四桶会在换模型后对不上账（token_usage.model 与这里必须能互验）；
  // servedModel 是回填那条路唯一的方向裁决依据（历史行缺它即按「未回显」原价补记）。
  // 资源卡落痕按**实际输出**判，而不是按「我们注入了没有」：
  // 模型完全可能自己调 knowledge_search 找到这张卡并给出去（实测发生过），
  // 那一次同样要计入 24 小时窗口，否则用户会连着两轮看见同一张卡。
  //
  // 【同为"尽力而为"那一类】它也是排在 finalizeMessage 之前的写库调用（写 timeline_events）。
  // 抛出去的下场与推荐段一模一样：正文停在 NULL、这一轮不记账。留痕丢了只影响下一轮
  // 会不会重印一张资源卡；正文与账丢了是永久损失。两者不该同生共死（入口见 bestEffort）。
  if (responseGaveCrisisCard(text)) {
    bestEffort('危机资源卡留痕失败（本轮落库与记账照常，下一轮可能重印一次卡）', () =>
      store.recordCrisisCardGiven(db, caseId, CRISIS_CARD_MARKER, crisis.triggered ? `命中：${crisis.matched.join('、')}` : '模型主动给出'), undefined);
  }

  const usageReport: UsageReport = { model: routed.client.billingModel, usage, servedModel };
  store.finalizeMessage(db, messageId, { content: text, tokensJson: JSON.stringify(usageReport) });
  store.touchThread(db, thread.id);
  chargeTurn({ db, userId, mode, messageId, usage, provider: routed.client, servedModel, emit });

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

  // 型号三件套随收尾帧下发（events.ts done 的注释）：meta 那时只知道我们请求了谁。
  // 判「换没换」不在这儿自己写 `!==`：前缀 relay/ 与变体后缀 :think 都不是换型号，
  // 逐字比较会把它们判成换了。口径只认记账那一处（reconcileServedModel），
  // 这里不传 rateOf——只要身份结论，计价方向裁决在 chargeTurn 里已经做过。
  emit({
    event: 'done',
    data: {
      message_id: messageId,
      finish_reason: finishReason,
      model: routed.client.model,
      served_model: servedModel,
      served_mismatch: reconcileServedModel(routed.client.billingModel, servedModel).trace !== null,
    },
  });

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
    referralScene,
  };
}
