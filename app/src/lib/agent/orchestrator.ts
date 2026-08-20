// app/src/lib/agent/orchestrator.ts
// 一轮对话的编排：装上下文 → 选模型 → tool-loop → 结构化落库 → 收口检查。
//
// 【为什么是「一个函数跑完一轮」而不是一个长期存活的 agent 对象】
// 陪跑是长期关系，但**每一轮都是独立的**：用户可能隔三天回来，服务可能中途重启，
// 状态只能活在库里。把状态放进内存对象意味着重启即失忆，而失忆的法律陪跑比没有更危险
// （它会把上次说过的话再说一遍，用户以为案子没进展）。所以每轮从库里重建全部上下文。
import type { Database } from 'better-sqlite3';

import * as cases from '@/lib/cases';
import * as store from '@/lib/db/agent';
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
  compactCrisisCard,
  CRISIS_CARD_MARKER,
  responseGaveCrisisCard,
  shouldInjectCrisisCard,
} from './crisis';
import { CitationGuard } from './citation-guard';
import { MAX_INJECTED_PACKS, type KnowledgePack, type KnowledgeSearcher } from './retrieval';
import { loadCaseSnapshot } from './snapshot';
import { classifyTask } from './task-class';
import { AGENT_TOOLS, executeTool, newTurnState, type AgentToolContext } from './tools';

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

  const system = buildSystemPrompt({
    snapshot,
    mode,
    stage,
    packs,
    now,
    // 危机指令每次都下发（危机轮的行为纪律逐轮都要生效）；
    // 一次性的是**资源卡本身**，不是「认真对待自伤表述」这件事。
    crisis: crisis.triggered,
    crisisCardAlreadyGiven: alreadyGiven,
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

  let text = '';
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

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { text: chunk, toolCalls } = await runOnce(true);
    text += chunk;
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

  if (state.searches > 0 && state.retrieved.length === 0) {
    emit({ event: 'notice', data: { code: 'KNOWLEDGE_MISS', message: '本轮没有检索到可引用的依据，相关结论已按保守做法给出' } });
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
