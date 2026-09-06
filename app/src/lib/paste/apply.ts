// app/src/lib/paste/apply.ts
// 把确认过的条目写进档案。**一条自己的写入逻辑都没有**——四类条目分别交给能力注册表里
// 那四条既有能力去写（设计稿 P1：任何能力只实现一次）。
//
// 【为什么不直接调 lib/cases】能力那一层已经把「归属校验 + 参数校验 + 幂等台账」串好了，
// 绕过它去调领域函数，等于把这三件事在这里再写一遍，而漏掉哪一件都不会报错：
// 漏归属校验 = 写进别人的案子还回 200；漏幂等 = 用户点两次确认，档案里多一份。
//
// 【client_ref 是这条路径的命根子】paste-<batch_id>-<index>：同一批同一条永远是同一个串，
// 所以「点两次确认」「网络重试」「用户回退再点一次」全部塌缩成一次写入。
// 变异臂：把 client_ref 去掉 ⇒ 重放双写 ⇒ 判据红。
import type { DomainFailure } from '@/lib/cases';
import { getCapability } from '@/lib/capabilities';
import type { Identity } from '@/lib/auth/identity';
import type { Database } from 'better-sqlite3';

import type { PasteBatch } from './batch';
import type { PasteItem } from './parse';
import type { BlockKey } from './protocol';

/** 条目类别 → 写它的能力名。加一类条目 = 在这里加一行 + 在 parse.ts 里认一个键。 */
const CAPABILITY_OF: Partial<Record<BlockKey, string>> = {
  timeline: 'timeline_add',
  actions: 'action_create',
  claims: 'claims_upsert',
  deadlines: 'deadline_set',
};

/** 一条的写入结果 */
export interface ApplyResult {
  index: number;
  kind: BlockKey;
  summary: string;
  ok: boolean;
  /** 没有新增一行（同 client_ref 重放，或命中自然键） */
  deduped: boolean;
  error: { code: string; message: string } | null;
}

/** 这一批的 client_ref 怎么拼。写入与判据共用这一个函数。 */
export function clientRefOf(batchId: string, index: number): string {
  return `paste-${batchId}-${index}`;
}

function isFailure(v: unknown): v is DomainFailure {
  return typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;
}

/**
 * 一条回包里「有没有真的新增一行」。
 *
 * 四条能力的回包字段不完全一样（deduped / created / actions[].created），
 * 在这里归一成一个布尔：网页上要显示的是「这条是新记的，还是本来就有」，
 * 不是各家字段名。
 */
function didDedup(res: Record<string, unknown>): boolean {
  if (res.deduped === true) return true;
  if (res.created === false) return true;
  const actions = res.actions;
  if (Array.isArray(actions) && actions.length > 0) {
    return actions.every((a) => (a as { created?: unknown }).created === false);
  }
  return false;
}

/**
 * 写入 accept 里点名的那些条目。校验没过的、类别不可写的一律跳过（回一条 error），
 * 不因为其中一条失败而中止后面的——用户勾了五条，不该因为第三条日期写错就只写进两条
 * 且不说是哪几条没写。
 */
export async function applyBatch(
  db: Database,
  identity: Identity,
  batch: PasteBatch,
  accept: number[],
): Promise<ApplyResult[]> {
  const wanted = new Set(accept);
  const out: ApplyResult[] = [];

  for (const item of batch.items) {
    if (!wanted.has(item.index)) continue;
    out.push(await applyOne(db, identity, batch, item));
  }
  return out;
}

async function applyOne(
  db: Database,
  identity: Identity,
  batch: PasteBatch,
  item: PasteItem,
): Promise<ApplyResult> {
  const base = { index: item.index, kind: item.kind, summary: item.summary };
  if (item.error) return { ...base, ok: false, deduped: false, error: item.error };

  const capName = CAPABILITY_OF[item.kind];
  const cap = capName ? getCapability(capName) : undefined;
  if (!cap) {
    return {
      ...base,
      ok: false,
      deduped: false,
      error: {
        code: 'UNSUPPORTED_KIND',
        message: `「${item.kind}」这一类现在没有对应的写入入口，这一条没有写进档案。`,
      },
    };
  }

  const res = await cap.run(db, identity, {
    ...item.args,
    case_id: batch.caseId,
    client_ref: clientRefOf(batch.id, item.index),
  });

  if (isFailure(res)) {
    return {
      ...base,
      ok: false,
      deduped: false,
      error: { code: res.errorCode, message: res.message },
    };
  }
  return {
    ...base,
    ok: true,
    deduped: didDedup((res ?? {}) as Record<string, unknown>),
    error: null,
  };
}
