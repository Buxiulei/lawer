/**
 * 对话 SSE 的九帧契约（WS2 定稿 2026-08-19，manager 已批）。
 * 字段一律照抄后端的 snake_case，**不在这一层改形状**——改名会让前后端对不上账。
 *
 * 帧序：meta → (ping)* → (delta|record|action|draft|notice)* → usage → done
 *       任何一步都可能被 error 顶替。
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

/** meta 之后每 15s 一帧，首个 delta 到即停。推理模型首字前可思考 3-4 分钟，这不是错误。 */
export interface PingFrame {
  type: 'ping';
  waited_seconds: number;
}

export interface DeltaFrame {
  type: 'delta';
  text: string;
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
  | 'TOOL_INPUT_REJECTED';

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

export interface DoneFrame {
  type: 'done';
  message_id: string;
  finish_reason: string;
}

/** error 帧只有 code/message；retry_after 来自非流错误体 {ok:false,error_code,message,retry_after?}，
 *  两者在这一层归一成同一个形状给 UI 用。 */
export interface ErrorFrame {
  type: 'error';
  code: string;
  message: string;
  retry_after?: number;
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
 */
export function toFrame(event: string | null, data: unknown): StreamFrame | null {
  if (!data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;
  const type = event ?? (typeof payload.type === 'string' ? payload.type : null);
  if (!type || !FRAME_TYPES.has(type)) return null;
  return { ...payload, type } as StreamFrame;
}

/* ── 展示口径 ────────────────────────────────────────────────── */

/** 型号 → 给劳动者看的中文名。用户不认识 model id，只需要知道这一轮谁在算。 */
const MODEL_LABELS: Record<string, string> = {
  'claude-opus-5': '深度推理模型',
  'claude-sonnet-5': '主力模型',
  'deepseek-v4-pro': '深度推理模型',
  'deepseek-v4-flash': '快速模型',
  'qwen3.7-max': '备用主力模型',
  'qwen3.6-flash': '快速模型',
};

/** 等待卡的主语：认得出型号就点名，认不出就不硬编一个假名字。 */
export function waitingHeadline(model: string | null | undefined): string {
  const label = model ? MODEL_LABELS[model] : undefined;
  return label ? `正在用${label}斟酌` : '正在斟酌';
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
 * notice 帧文案：冷静、具体、说清「所以对你意味着什么」。
 * 六个 code 全覆盖；后端 message 只在未知 code 时兜底。
 */
const NOTICE_COPY: Record<NoticeCode, string> = {
  KNOWLEDGE_MISS:
    '这个点法条库暂无逐字依据，以上是通用口径，已标记待补。',
  KNOWLEDGE_UNAVAILABLE:
    '法条库这一轮没连上，以上按通用口径给你，过一会儿再问一次能拿到逐字原文。',
  ACTION_CARD_CAPPED:
    '这一轮要做的事不止 3 件，先给最要紧的 3 件，其余下一轮接着给。',
  ACTION_CARD_MISSING:
    '这一轮没有新增要做的事，按上面已有的行动卡走就行。',
  REFERRAL_ALREADY_USED:
    '情绪支持的转介一个案子只提一次，之前已经提过，这次不重复。',
  TOOL_INPUT_REJECTED:
    '刚才那条信息没通过校验，没有写进档案。等下我换个问法再跟你确认一次。',
};

export function noticeCopy(frame: NoticeFrame): string {
  return NOTICE_COPY[frame.code] ?? frame.message;
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
