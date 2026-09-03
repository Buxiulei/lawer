/**
 * 对话 SSE 的九帧契约（WS2 定稿 2026-08-19，manager 已批）。
 * 字段一律照抄后端的 snake_case，**不在这一层改形状**——改名会让前后端对不上账。
 *
 * 帧序：meta → (ping|delta|record|action|draft|notice)* → usage → done
 *       任何一步都可能被 error 顶替。
 *       ping 不只在首字前：正文一停流（模型转去跑 tool 轮）满一个间隔就再现，
 *       所以它和正文帧是交替出现的，不是流开头一段独占的前缀。
 *
 * 危机场景多一段：meta 之后毫秒级先到 deterministic=true 的 delta（接住式安抚+求助热线），
 * 模型正文可能还要 2-4 分钟，这期间 ping 照常。
 */

import type { ActionItem } from '@/app/_mock/types';

export interface MetaFrame {
  type: 'meta';
  thread_id: string;
  message_id: string;
  mode: string;
  intake_stage: string | null;
  task_class: string;
  model: string;
  /** true = 主力模型不可用，本轮由备用模型完成 */
  degraded: boolean;
}

/** meta 之后**正文没在流的每一段静默期**每 15s 一帧：**非 deterministic** delta 一到即停，
 *  正文再停流（tool 轮）满一个间隔又接上，done 终止。
 *  推理模型首字前可思考 3-4 分钟，首字之后每一轮 tool 往返又是几十秒零帧（产线实测 88.6 秒），
 *  这都不是错误。
 *  `waited_seconds` 恒为本轮开跑至今的总秒数，跨 tool 轮不复位——别拿它当「本段静默多久」。 */
export interface PingFrame {
  type: 'ping';
  waited_seconds: number;
}

export interface DeltaFrame {
  type: 'delta';
  text: string;
  /** true = 危机场景的确定性首段（服务端调模型前毫秒级下发），不代表模型已开口 */
  deterministic?: boolean;
}

export type RecordTool =
  | 'timeline_add'
  | 'claims_upsert'
  | 'emotion_log'
  | 'company_profile_upsert'
  | 'intake_done'
  | 'deadline_set';

export interface RecordFrame {
  type: 'record';
  tool: RecordTool;
  id: string;
  summary: string;
}

export interface ActionFrame {
  type: 'action';
  id: string;
  title: string;
  detail: string;
  due_at: string | null;
  priority: 1 | 2 | 3;
  index: number;
}

export interface DraftFrame {
  type: 'draft';
  id: string;
  kind: string;
  title: string;
  version: number;
  /** 恒 true：草稿一律经确认流，UI 不提供「直接发出」 */
  requires_confirmation: boolean;
}

export type NoticeCode =
  | 'KNOWLEDGE_MISS'
  | 'KNOWLEDGE_UNAVAILABLE'
  | 'ACTION_CARD_CAPPED'
  | 'ACTION_CARD_MISSING'
  | 'REFERRAL_ALREADY_USED'
  | 'TOOL_INPUT_REJECTED'
  | 'CITATION_BLOCKED'
  | 'CITATION_INCOMPLETE'
  | 'PRECEDENT_CONTAMINATED'
  | 'CALC_FAILED'
  | 'EMOTIONAL_LEVERAGE_DETECTED'
  | 'NBDPSY_PITCH_BLOCKED';

export interface NoticeFrame {
  type: 'notice';
  code: NoticeCode;
  message: string;
}

/** 流末计量。**null = 该桶无数据，不是 0**，展示时必须区分。 */
export interface UsageFrame {
  type: 'usage';
  model: string;
  prompt: number | null;
  completion: number | null;
  cached_read: number | null;
  cached_write: number | null;
}

/**
 * 收尾帧。型号三件套在这一帧而不是 meta：meta 在开跑前就发了，那时只知道我们**请求**了谁，
 * 厂商实际派谁来服务要到流末才回显。三个字段都可选——旧服务端（或演示替身）不带它们时
 * 前端照旧工作，标注不出现而已；**绝不拿 meta.model 顶替**，那是请求值不是实际值。
 */
export interface DoneFrame {
  type: 'done';
  message_id: string;
  finish_reason: string;
  /** 我们请求的型号（API 别名） */
  model?: string;
  /** 厂商回显的**实际**服务型号；null = 这一轮没回显过 */
  served_model?: string | null;
  /** 实际与请求不是同一个型号 */
  served_mismatch?: boolean;
}

/** error 帧只有 code/message；retry_after 来自非流错误体 {ok:false,error_code,message,retry_after?}，
 *  两者在这一层归一成同一个形状给 UI 用。 */
export interface ErrorFrame {
  type: 'error';
  code: string;
  message: string;
  retry_after?: number;
  /**
   * 这一轮的失败已经落成的那条 assistant 行的 id（服务端发的是 number，
   * `toFrame` 统一转成串，见下方 message_id 那段注释）。
   * 点「重试」时把它发回去当 retry_of：服务端据此重发**同一句**问话，且不再插一条新的用户消息。
   */
  message_id?: string;
  /**
   * 公道值余额（只有 `code === 'GONGDAO_EXHAUSTED'` 的那一帧带）。
   * 横幅要照它渲染，**不从 message 里抠数字**：低调模式下横幅换的是整句说法
   * （见 StreamParts 的 GongdaoExhaustedBanner），抠字符串那条路在换词的那一刻就断了。
   */
  balance?: number;
}

/**
 * 余额闸拦下这一轮时服务端给的错误码（HTTP 402）。
 * 前端据它换整块 UI（横幅 + 禁输入框），不是当成又一种「这一轮没说完」。
 * 与服务端 route.ts 里写的那个串必须一致——那边由路由用例按行为钉住（402 + 这个码）。
 */
export const GONGDAO_EXHAUSTED = 'GONGDAO_EXHAUSTED';

/**
 * 在飞占位拦下这一轮时服务端给的错误码（HTTP 409）。
 * **不与 402 归成一个码**：一个等一等就好，一个等多久都没用（得先兑换/充值）。
 * 归一了会把「等一会儿」的人指去兑换页白跑一趟。
 */
export const TURN_IN_FLIGHT = 'TURN_IN_FLIGHT';

/**
 * 服务端**在 runTurn 之前**就拒答的那些码：一个字都没落库——不调模型、不插用户消息、
 * 不记一行账。于是页面上那条本地回显是一条**孤儿**：屏幕上写着「发出去了」，
 * F5 之后它就没了。这些码一律要撤掉回显、把原文还回输入框。
 *
 * 【这是一份登记表，不是两三个特例】route.ts 里 runTurn 之前的**每一个** error_code
 * 都在这里，由那侧的结构守卫按源码逐个核对（见 chat/__tests__/route.test.ts）。
 * 下一个前置 4xx 加进路由却忘了登记，守卫当场点名——而漏掉的后果是静默的：
 * 那一档的回显留在屏幕上，刷新后消失，页面看不出任何异样。
 *
 * 【登记 ≠ 画法相同】「撤回显」是这些码的共同处置。画成什么（横幅 / 提示条 / 失败卡）、
 * 输入框禁不禁用，仍由 Workbench 逐码决定：402 要禁输入框（充值之前打什么都白打），
 * 409 不禁（上一轮答完就能接着问，禁掉等于把唯一的出路也关了）。
 */
export const REFUSED_BEFORE_WRITE: ReadonlySet<string> = new Set([
  GONGDAO_EXHAUSTED,
  TURN_IN_FLIGHT,
  // 以下同为「开流之前就返回、一字未落库」的前置校验（route.ts 里挨着写的那几条）
  'CASE_NOT_FOUND',
  'INVALID_BODY',
  'INVALID_RETRY_OF',
  'EMPTY_MESSAGE',
  'INVALID_MODE',
]);

/** 这个错误码是不是「服务端一字未落库」的那一档（见 REFUSED_BEFORE_WRITE）。 */
export function isRefusedBeforeWrite(code: string | null | undefined): boolean {
  return typeof code === 'string' && REFUSED_BEFORE_WRITE.has(code);
}

export type StreamFrame =
  | MetaFrame
  | PingFrame
  | DeltaFrame
  | RecordFrame
  | ActionFrame
  | DraftFrame
  | NoticeFrame
  | UsageFrame
  | DoneFrame
  | ErrorFrame;

const FRAME_TYPES = new Set([
  'meta',
  'ping',
  'delta',
  'record',
  'action',
  'draft',
  'notice',
  'usage',
  'done',
  'error',
]);

/**
 * 把一条 SSE 事件收成帧。未知帧类型返回 null（调用方忽略并 warn）——
 * 后端加帧不该让老前端崩掉。
 *
 * 【为什么这里要动 message_id】(2026-09-02 真机)
 * 服务端 `events.ts` 里 meta / done 的 `message_id` 是**数据库主键，number**；
 * 这一层的 `MetaFrame`／`DoneFrame` 却把它写成 `string`。两边从来没对过账，
 * 因为末行那个 `as StreamFrame` 是**无校验断言**——TS 于是一路默许，编译全绿。
 *
 * 真机后果：演示替身发的是 `m_<剧本id>_<时间戳>`（真字符串），所以演示页一切正常；
 * 而真对话每一轮收尾时 `mockLawRefs(turn.messageId)` 会对着一个 number 调
 * `.startsWith`，抛 `TypeError: r.startsWith is not a function`。它抛在 React 渲染里，
 * 整棵树垮掉 → **每一轮回答刚渲染完，页面就变成 "This page couldn't load"**。
 * （这正是此前被记在服务端 uncaughtException 名下的那个症状——同一句话，两个病因。）
 *
 * 【为什么修在这里】这是所有帧进入前端的**唯一入口**。在消费点上各自 `String(...)`
 * 是"漏接一个即失效"，而漏掉的那个恰恰只在真对话里走到——演示页永远测不出来。
 */
export function toFrame(event: string | null, data: unknown): StreamFrame | null {
  if (!data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;
  const type = event ?? (typeof payload.type === 'string' ? payload.type : null);
  if (!type || !FRAME_TYPES.has(type)) return null;
  // 归一成本层声明的类型：数字主键照实转成串，其余原样（不存在就不要凭空造一个）
  const normalized =
    typeof payload.message_id === 'number'
      ? { ...payload, message_id: String(payload.message_id) }
      : payload;
  return { ...normalized, type } as StreamFrame;
}

/* ── 展示口径 ────────────────────────────────────────────────── */

/**
 * 型号 → 档位。**档位是型号的注解，不是型号的替身。**
 *
 * 这张表以前叫 MODEL_LABELS，值是「主力模型」这样的中文名，屏幕上只印这个名字。
 * 那等于把用户唯一能核对的事实（他这一轮到底拿到了 opus 还是 flash）换成了一个
 * 我们自己起的好听说法——**换了模型、换了厂商，这行字一个像素都不变**。
 * 用户按型号付费，落款就必须印**型号 id 本身**；档位只作小字跟在后面，帮他知道那是贵的还是快的。
 */
const MODEL_TIERS: Record<string, string> = {
  'claude-opus-5': '深度推理',
  'claude-sonnet-5': '主力',
  'deepseek-v4-pro': '深度推理',
  'deepseek-v4-flash': '快速',
  'qwen3.7-max': '备用主力',
  'qwen3.6-flash': '快速',
};

/** 等待卡的主语：认得出型号就点名，认不出就不硬编一个假名字。 */
export function waitingHeadline(model: string | null | undefined): string {
  const tier = model ? MODEL_TIERS[model] : undefined;
  return tier ? `正在用${tier}模型斟酌` : '正在斟酌';
}

/**
 * 每条回答底下那行「这一轮谁答的」。
 *
 * 【口径：实际优先，没有实际才退回请求】`served` 是厂商回显的**实际**服务型号，
 * `requested` 是我们发出去的。中转按渠道分组路由，请求 opus 完全可能由 sonnet 返回
 * （billing/served-model.ts 文件头的实测），所以拿请求值当"实际"标出去就是在撒谎——
 * 而这一行字的全部意义正是"实际"。两个都没有就一个字都不写：宁可不标，不猜。
 *
 * 【形状：型号 id 为主，档位为辅】`claude-opus-5 · 深度推理`。
 * 主语必须是**型号 id 本身**——用户按型号付费，他要核对的就是这串字；
 * 只印「深度推理模型」的话，把 opus 换成 flash 这行字也不会变，那就不叫核对。
 * 认不出的型号串原样显示（多半是厂商新加的日期快照），后面不缀档位，也不硬编一个好听的假名字。
 * `(替代)` 只在服务端判定换过型号时加——判据同源于记账那一处，前端不自己比字符串。
 */
export function servedModelLabel(input: {
  served?: string | null;
  requested?: string | null;
  mismatch?: boolean;
}): string | null {
  const model = input.served?.trim() || input.requested?.trim() || '';
  if (!model) return null;
  const tier = MODEL_TIERS[model];
  const label = tier ? `${model} · ${tier}` : model;
  return input.mismatch ? `${label}（替代）` : label;
}

/** 「已等待 3 分 12 秒」。不足一分钟只说秒。 */
export function formatWaited(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `已等待 ${min} 分 ${sec} 秒` : `已等待 ${sec} 秒`;
}

/** record 帧的档案落点，用于 chip 前缀。 */
const RECORD_LABELS: Record<RecordTool, string> = {
  timeline_add: '时间线',
  claims_upsert: '诉求金额',
  emotion_log: '状态记录',
  company_profile_upsert: '公司信息',
  intake_done: '首诊',
  deadline_set: '期限',
};

export function recordLabel(tool: RecordTool): string {
  return RECORD_LABELS[tool] ?? '档案';
}

/**
 * 后端 message 原文照搬。用于「每轮内容都不一样」的提示——前端写死一句
 * 固定话术只能说废话（例：CALC_FAILED 的「还差哪几项」逐轮不同）。
 */
const PASSTHROUGH = Symbol('notice-passthrough');

/**
 * notice 帧展示策略（WS2 词表定稿，manager 已入册）：
 * 只有三个 code 面向用户展示；其余是系统内部治理信号，UI 静默
 * （EMOTIONAL_LEVERAGE_DETECTED 等尤其不得出现「拦截」类字样）。
 * CITATION_BLOCKED 不出提示行——正文里的【案号待核实】占位由 RichText 淡色标注承载。
 * 未知 code：忽略 + console.warn（向前兼容）。
 *
 * 三种取值，**别用空字符串**：固定文案 / null=静默 / PASSTHROUGH=用后端原文。
 * `''` 会被渲染层的 `if (!copy)` 当成静默吞掉，看着像「配了文案」其实一个字都不显示。
 */
const NOTICE_COPY: Record<NoticeCode, string | null | typeof PASSTHROUGH> = {
  KNOWLEDGE_MISS:
    '这个点法条库暂无逐字依据，以上是通用口径，已标记待补。',
  KNOWLEDGE_UNAVAILABLE:
    '法条库这一轮没连上，以上按通用口径给你，过一会儿再问一次能拿到逐字原文。',
  ACTION_CARD_CAPPED: null,
  ACTION_CARD_MISSING: null,
  REFERRAL_ALREADY_USED: null,
  TOOL_INPUT_REJECTED: null,
  CITATION_BLOCKED: null,
  // 「只给条号没给逐字原文」是内部质量信号，不对用户出提示行——
  // 告诉用户「这条引用不完整」既帮不上忙，又会让他怀疑手里已有的内容
  CITATION_INCOMPLETE: null,
  PRECEDENT_CONTAMINATED: null,
  // 唯一一条「失败」类的用户可见提示。文案由后端按缺失项拼好直接下发
  // （tools.ts：「还差：入职日期、月工资。你把这几项告诉我，我立刻重算一遍」），
  // 这里不再套一层固定话术——「还差哪几项」每轮都不一样，写死就只能说废话。
  CALC_FAILED: PASSTHROUGH,
  EMOTIONAL_LEVERAGE_DETECTED: null,
  NBDPSY_PITCH_BLOCKED: null,
};

export function noticeCopy(frame: NoticeFrame): string | null {
  if (!(frame.code in NOTICE_COPY)) {
    console.warn('[stream] 未知 notice code，忽略：', frame.code);
    return null;
  }
  const copy = NOTICE_COPY[frame.code];
  // 后端原文缺失或全是空白时宁可静默：空提示行比不出提示更让人心慌。
  if (copy === PASSTHROUGH) return frame.message?.trim() || null;
  return copy;
}

/** action 帧 → 现有行动卡数据结构，让 ActionCard/档案面板照旧工作。 */
export function toActionItem(frame: ActionFrame, caseId: string): ActionItem {
  return {
    id: frame.id,
    caseId,
    title: frame.title,
    detail: frame.detail,
    dueAt: frame.due_at,
    priority: frame.priority,
    status: '待办',
    sourceMessageId: null,
    createdAt: new Date().toISOString(),
  };
}
