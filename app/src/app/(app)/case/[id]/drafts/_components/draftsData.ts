'use client';

/**
 * 文书页的数据层：真接口调用 + 演示案件的 mock 适配。
 *
 * 【立这一层的由头】文书页此前一行是 `const drafts = mockDrafts`——**对任何 caseId 都是它**。
 * 真实用户点进自己案子的文书页，读到的是「星曜网络科技（北京）有限公司」的异议函和仲裁申请书。
 * 页面看起来完全正常：有标题、有版本号、有更新时间，只是那不是他的东西。
 *
 * 接口形状取自同仓路由实现：
 *   GET /api/v1/cases/{id}/drafts   文书（正文一并回）
 * 后端只有这一条通路：文书由对话里的 draft_write 落库，除此之外没有第二个写入口。
 */

import type { Draft, DraftKind } from '@/app/_mock/types';
import { apiFetch } from '@/app/_ui/api';

/** 页面只认这个形状，不认后端字段名，也不认数据是真是假 */
export type DraftView = Pick<
  Draft,
  'id' | 'kind' | 'title' | 'content' | 'version' | 'status' | 'updatedAt'
>;

/** 后端行的形状（照 lib/db/agent 的 DraftRow） */
interface ApiDraftRow {
  id: number;
  case_id: number;
  kind: string;
  title: string;
  content: string | null;
  version: number;
  status: string;
  created_at: string;
  updated_at: string;
}

/** 与 lib/agent/tools 的 DRAFT_KINDS 逐字对齐 */
const DRAFT_KINDS: readonly DraftKind[] = [
  '异议函',
  '被迫解除通知',
  '仲裁申请书',
  '证据清单',
  '答辩状',
  '上诉状',
  '谈判话术',
  '其他',
];

/**
 * 库里 status 目前恒是英文 'draft'（draft_write 写死：发不发只有用户能决定）。
 * 中文三档一并认，是为了将来加「标记已发出」时前端不用跟着改。
 */
const STATUS_MAP: Record<string, Draft['status']> = {
  draft: '草稿',
  草稿: '草稿',
  待定稿: '待定稿',
  已发出: '已发出',
};

/** 认不出的类型按「其他」渲染，但要出声——静默改归类会让用户找不到自己那份 */
function toKind(raw: string): DraftKind {
  if ((DRAFT_KINDS as readonly string[]).includes(raw)) return raw as DraftKind;
  console.warn('[drafts] 未知的文书类型，按「其他」渲染：', raw);
  return '其他';
}

/**
 * 认不出的状态按「草稿」渲染。往「草稿」这一档错是有方向的：
 * 把没发出的说成已发出，用户会以为对方已经收到了。
 */
function toStatus(raw: string): Draft['status'] {
  const known = STATUS_MAP[raw];
  if (known) return known;
  console.warn('[drafts] 未知的文书状态，按「草稿」渲染：', raw);
  return '草稿';
}

export function toDraftView(row: ApiDraftRow): DraftView {
  return {
    id: String(row.id),
    kind: toKind(row.kind),
    title: row.title,
    content: row.content ?? '',
    version: row.version,
    status: toStatus(row.status),
    updatedAt: row.updated_at,
  };
}

export async function fetchDrafts(caseId: string): Promise<DraftView[]> {
  const res = await apiFetch<{ drafts: ApiDraftRow[] }>(`/cases/${caseId}/drafts`);
  return res.drafts.map(toDraftView);
}

/** 详情页按 id 找。文书一个案子只有几份，取列表再挑比多开一条接口划算 */
export function findDraft(drafts: DraftView[], draftId: string): DraftView | undefined {
  return drafts.find((d) => d.id === draftId);
}
