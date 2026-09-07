// app/src/lib/paste/index.ts
// 无工具模式的领域入口：生成开场白（opener.ts）、预览粘回的结构块、确认后写入。
// 路由只做「取参数 → 调这里 → 回 JSON」。
//
// 【两步而不是一步】粘回来的内容是一个模型写的，用户没逐条看过。直接写库的形态是：
// 助手把某件事的日期记错一天、把「公司说考虑一下」写成「公司同意 N+1」，
// 这些都会安静地成为档案里的事实，日后拿去谈判、拿去写申请书的正是它们。
// 所以第一步只回「要写什么、会不会跟已有的撞上」，第二步才写，且只写他勾的那几条。
import { assessCrisis, buildCrisisOpener } from '@/lib/agent/crisis';
import { createKnowledgeSearcher } from '@/lib/agent/knowledge-adapter';
import type { Identity } from '@/lib/auth/identity';
import * as cases from '@/lib/cases';
import type { DomainFailure } from '@/lib/cases';
import * as store from '@/lib/db/agent';
import * as caseStore from '@/lib/db/cases';
import { dedupTitleKey } from '@/lib/db/dedup';
import { domainPackOrDefault, getDomainPack } from '@/lib/domains/registry';
import type { Database } from 'better-sqlite3';

import { applyBatch, type ApplyResult } from './apply';
import { getBatch, putBatch } from './batch';
import { parsePasteBack, type PasteItem } from './parse';

export { OPENER_TIERS, buildOpener, isOpenerTier, type OpenerTier } from './opener';
export { clearBatches } from './batch';
export { clientRefOf } from './apply';
export { FENCE_TAG } from './protocol';

/** 危机提示：命中时挂在回填结果最顶上 */
export interface CrisisNotice {
  triggered: boolean;
  /** 触发时是一段带号码的文字，未触发为 null */
  message: string | null;
}

/**
 * 对粘回来的整段文字跑一遍危机判据。
 *
 * 【为什么服务端还要再过一遍】开场白里那条「危机优先」是给模型的**文字约定**，
 * 而约定归约定：模型可能没接住，也可能用户是在这一段里第一次说出那句话。
 * 这一层是确定性的——判据、号码都不经模型（同 lib/agent/crisis 的整层设计）。
 * 判据同源：与站内对话用的是**同一个** assessCrisis / buildCrisisOpener，不另写一份词表。
 *
 * `domain`：这段文字属于哪个案件的领域（词表与首段按它取）。拿不到案件时省略即缺省领域——
 * 省略的形态在第二个领域上是：那个人粘回来的那句话不在缺省词表里，于是这一次预览
 * 什么都没提示，而结构块照常解析、回包照常 200。
 */
export function crisisNotice(text: string, domain?: string): CrisisNotice {
  const crisisPack = domainPackOrDefault(domain).crisis;
  const crisis = assessCrisis(text, crisisPack);
  if (!crisis.triggered) return { triggered: false, message: null };
  // 号码从资源卡里取，不写死在代码里（记错一个数字，用户拨过去就是空号）
  const card = crisis.resourcePackId
    ? createKnowledgeSearcher().get?.(crisis.resourcePackId, { domain: null })
    : undefined;
  const hotline = buildCrisisOpener(card?.facts, {}, crisisPack);
  return {
    triggered: true,
    message: ['**这段对话里出现了危机信号。**先看这一段，档案的事等一等——', '', hotline].join('\n'),
  };
}

/** 去重预测的四种结局 */
export type DedupForecast = 'new' | 'duplicate' | 'overwrite' | 'unknown';

export interface PreviewItem {
  index: number;
  kind: PasteItem['kind'];
  summary: string;
  ok: boolean;
  error: { code: string; message: string } | null;
  dedup: DedupForecast;
  dedup_note: string;
}

export interface PreviewResult {
  ok: true;
  batch_id: string;
  crisis: CrisisNotice;
  items: PreviewItem[];
  /** 结构块里出现的、我们不认的顶层键 */
  unknown_keys: string[];
}

/**
 * 去重预测。**是预测不是判决**：真正的去重发生在写入那一刻（能力自己的 client_ref 与自然键），
 * 确认回执里的 deduped 才是事实。这里读同一批数据、用同一个标题规范化函数
 * （lib/db/dedup.dedupTitleKey），给用户一个「勾了会不会白勾」的提示。
 */
function forecast(
  db: Database,
  caseId: number,
  item: PasteItem,
): { dedup: DedupForecast; note: string } {
  if (item.error) return { dedup: 'unknown', note: '这一条还写不进去，先按上面的提示改。' };
  const args = item.args as Record<string, string | undefined>;

  if (item.kind === 'timeline') {
    const key = dedupTitleKey(String(args.title));
    const same = caseStore
      .listTimelineSameDayKind(db, caseId, String(args.happened_at), String(args.kind))
      .some((e) => dedupTitleKey(e.title) === key);
    return same
      ? { dedup: 'duplicate', note: '同一天、同类别、同标题的事件档案里已经有了，勾了也不会多出一条。' }
      : { dedup: 'new', note: '会新增一条时间线事件。' };
  }

  if (item.kind === 'actions') {
    const items = (item.args.items as { what: string }[] | undefined) ?? [];
    const key = dedupTitleKey(items[0]?.what ?? '');
    const same = caseStore
      .listActionItems(db, caseId, '待办')
      .some((a) => dedupTitleKey(a.title) === key);
    return same
      ? { dedup: 'duplicate', note: '待办里已经有同一件事了，勾了也不会多出一张。' }
      : { dedup: 'new', note: '会新增一张行动卡。' };
  }

  if (item.kind === 'claims') {
    const same = store.listClaims(db, caseId).some((c) => c.kind === args.kind);
    return same
      ? { dedup: 'overwrite', note: '这一类诉求已经有一条了，勾了是**覆盖**它，不是再记一笔。' }
      : { dedup: 'new', note: '会新增一条诉求。' };
  }

  if (item.kind === 'deadlines') {
    // 到期日由服务端按规则推算（本层不做任何日期运算），所以这里只能按种类给一个弱预测：
    // 同种类已有一条时，多半会撞上「同案 + 同种类 + 同到期日」的自然键。
    const same = caseStore
      .listDeadlines(db, caseId, true)
      .some((d) => d.kind === args.kind);
    return same
      ? {
          dedup: 'unknown',
          note: '这一类期限档案里已经有了。到期日由服务端按规则推算，算出来是同一天就不会多出一条，不同天会各留一条。',
        }
      : { dedup: 'new', note: '会推算到期日并新增一条期限。' };
  }

  return { dedup: 'unknown', note: '' };
}

/**
 * 第一步：解析 + 校验 + 预测，**不写任何一行**。
 * 归属校验走 lib/cases（非本人案件一律 CASE_NOT_FOUND）。
 */
export function previewPasteBack(
  db: Database,
  input: { caseId: number; userId: number; text: unknown },
): PreviewResult | (DomainFailure & { crisis?: CrisisNotice }) {
  const owned = cases.getCase(db, {
    caseId: input.caseId,
    userId: input.userId,
    timelineLimit: 1,
  });
  if (!owned.ok) return owned;

  const text = typeof input.text === 'string' ? input.text : '';
  if (!text.trim()) {
    return {
      ok: false,
      status: 400,
      errorCode: 'EMPTY_TEXT',
      message: '没有收到任何文字。把助手那一轮回复**整段**复制过来（包含末尾的结构块）再试。',
    };
  }

  // 危机判据先跑：解析失败也要把这一段带出去——一个人在最坏的那个夜里粘进来的文字，
  // 不该因为块格式不对就连号码都拿不到。
  const crisis = crisisNotice(text, owned.case.domain);

  const pack = getDomainPack(owned.case.domain);
  if (!pack) {
    return {
      ok: false,
      status: 500,
      errorCode: 'UNKNOWN_DOMAIN',
      message: `这个案件的领域是「${owned.case.domain}」，但没有对应的领域包，解析不了回填内容。`,
      crisis,
    };
  }

  const parsed = parsePasteBack(text, pack);
  if (!parsed.ok) {
    return { ok: false, status: parsed.status, errorCode: parsed.errorCode, message: parsed.message, crisis };
  }

  const batch = putBatch({ caseId: input.caseId, userId: input.userId, items: parsed.items });
  return {
    ok: true,
    batch_id: batch.id,
    crisis,
    unknown_keys: parsed.unknownKeys,
    items: parsed.items.map((it) => {
      const f = forecast(db, input.caseId, it);
      return {
        index: it.index,
        kind: it.kind,
        summary: it.summary,
        ok: it.error === null,
        error: it.error,
        dedup: f.dedup,
        dedup_note: f.note,
      };
    }),
  };
}

export interface ConfirmResult {
  ok: true;
  batch_id: string;
  results: ApplyResult[];
  written: number;
  deduped: number;
  failed: number;
}

/** 第二步：写入用户勾的那几条。重放同一个 batch_id 零双写（client_ref 兜底）。 */
export async function confirmPasteBack(
  db: Database,
  identity: Identity,
  input: { caseId: number; batchId: unknown; accept: unknown },
): Promise<ConfirmResult | DomainFailure> {
  const owned = cases.getCase(db, {
    caseId: input.caseId,
    userId: identity.uid,
    timelineLimit: 1,
  });
  if (!owned.ok) return owned;

  const batch = getBatch({ id: input.batchId, caseId: input.caseId, userId: identity.uid });
  if (!batch) {
    // 自述三段式：缺什么 / 为什么缺 / 怎么办
    return {
      ok: false,
      status: 404,
      errorCode: 'BATCH_NOT_FOUND',
      message:
        '这一批预览找不到了。预览只在服务端内存里留一小时（它不写库，所以也不会在档案里留痕），' +
        '超时或服务重启后就没了。把助手那段回复重新粘一次，重新预览再确认即可。',
    };
  }

  const accept = Array.isArray(input.accept)
    ? input.accept.filter((v): v is number => Number.isInteger(v))
    : [];
  if (accept.length === 0) {
    return {
      ok: false,
      status: 400,
      errorCode: 'NOTHING_ACCEPTED',
      message: 'accept 里没有任何条目序号，这次一条都没有写进档案。勾上要留下的那几条再确认。',
    };
  }

  const results = await applyBatch(db, identity, batch, accept);
  return {
    ok: true,
    batch_id: batch.id,
    results,
    written: results.filter((r) => r.ok && !r.deduped).length,
    deduped: results.filter((r) => r.ok && r.deduped).length,
    failed: results.filter((r) => !r.ok).length,
  };
}
