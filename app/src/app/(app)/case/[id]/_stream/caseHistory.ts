'use client';

/**
 * 历史对话的数据层：取数 + 后端行 → 页面认的形状。
 *
 * 【立这一层的由头】对话页此前**从不取历史**。库里 messages 表一条不少地存着
 * （agent 每一轮都写），但只喂给服务端拼上下文；网页打开时是一片空白，
 * 用户以为自己讲过的经过没了——一个正在等仲裁的人，最不该怀疑的就是这个。
 *
 * 接口形状取自同仓路由实现：
 *   GET /api/v1/cases/{id}/messages   该案件的历史对话（正序，最近 200 条）
 */

import { apiFetch } from '@/app/_ui/api';
import type { StreamedMessage } from '../_components/Messages';

/** 后端行的形状（照 lib/cases 的 CaseMessageView，逐字 snake_case） */
export interface ApiMessageRow {
  id: number;
  role: string;
  content: string;
  created_at: string;
  model: string | null;
  served_model: string | null;
  served_mismatch: boolean;
  /**
   * 这一轮**终态失败**的错误码；null = 正常轮。非空时 `content` 是那段三段式失败文案，
   * 页面据此画成「这一轮没能生成回答 + 重试」而不是画成一条回答——
   * 失败这件事必须挺过一次刷新（naive-qa-2 F-203）。
   */
  failed_code: string | null;
}

/**
 * 认不出的 role 一律当 assistant 画。方向是有讲究的：把助手的话画成用户气泡，
 * 用户会以为那句话是自己说的——而助手正文里写的是"你现在该做什么"。
 */
function toRole(raw: string): 'user' | 'assistant' {
  return raw === 'user' ? 'user' : 'assistant';
}

export function toHistoryMessage(row: ApiMessageRow): StreamedMessage {
  return {
    id: `m_${row.id}`,
    // 线程在服务端按 mode 分（问诊/陪跑），但用户眼里只有一条对话，页面也只画一条
    threadId: 'th_1',
    role: toRole(row.role),
    content: row.content,
    createdAt: row.created_at,
    model: row.model ?? undefined,
    servedModel: row.served_model,
    modelMismatch: row.served_mismatch,
    failedCode: row.failed_code,
    // 重试要发回的是库主键本身，不是展示 id（后者带 `m_` 前缀，反解一次就多一处会坏的地方）
    failedMessageId: row.failed_code ? String(row.id) : undefined,
  };
}

export async function fetchCaseMessages(caseId: string): Promise<StreamedMessage[]> {
  const res = await apiFetch<{ messages: ApiMessageRow[] }>(`/cases/${caseId}/messages`);
  return res.messages.map(toHistoryMessage);
}
