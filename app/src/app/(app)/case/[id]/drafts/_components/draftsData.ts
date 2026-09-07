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

import type { Draft } from '@/app/_mock/types';
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

/**
 * 文书种类**原样透传**。
 *
 * 【为什么不在这一层收口】能有哪几类由**案件所属领域**的 `DomainPack.docKinds` 说了算
 * （服务端 draft_write 按它校验），而这一层手里只有 caseId，不知道这个案子属于哪个领域。
 * 从前这里挂着一份写死的缺省领域八类，词表外的一律折成「其他」——那个形态是：
 * 第二个领域的九类文书在列表里全叫「其他」，用户找不到自己那一份，
 * 而页面不报错、条数也对、更新时间也对。
 *
 * 「这一类不在本领域词表里」的告警判在知道领域的那一层（DraftsListView，它本来就问了一次
 * 领域给导语与空态用），见下面的 unknownKinds。
 */
export function toDraftView(row: ApiDraftRow): DraftView {
  return {
    id: String(row.id),
    kind: row.kind,
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

/**
 * 这几份里有哪几类**不在本领域的词表里**（去重、保序）。
 *
 * 【它只用来出声，不用来改字】库里这一类不在 `DomainPack.docKinds` 里，说明写它的那一侧
 * 与本领域的词表对不上——那是要人去看的事，不是页面该替用户改掉的事。
 * 从前这两件事绑在一起（认不出就折成「其他」），代价是第二个领域**每一份**文书
 * 都被改了归类，而用户在列表里再也找不到自己那一份。
 *
 * 纯函数是为了让"出声"这件事在 node 判据里验得出来：调用它的地方在 effect 里，
 * 而本仓测试跑的是 node 环境，effect 一遍都不会执行。
 */
export function unknownKinds(kinds: readonly string[], known: readonly string[]): string[] {
  return [...new Set(kinds)].filter((k) => !known.includes(k));
}

/** 详情页按 id 找。文书一个案子只有几份，取列表再挑比多开一条接口划算 */
export function findDraft(drafts: DraftView[], draftId: string): DraftView | undefined {
  return drafts.find((d) => d.id === draftId);
}
