// app/src/lib/drafts/export.ts
// 文书导出 PDF（设计稿 §2 E draft_export）：草稿正文（markdown）→ sidecar 渲染 → 落 files 表
// → 签一条一次性限时下载地址。
//
// 【导出的是正文原文，不带那段「发出前必读」尾注】尾注是写给起草人自己的提醒
// （发出后果、能不能撤回、发不发由你定）。它印在一份要递给对方或递交机构的 PDF 上，
// 等于把自己的顾虑随文书一起交出去。站内看到尾注、导出不带，是刻意的；
// 免登录分享页同口径（lib/shares.ts），两处一致。
//
// 【为什么走报价→确认，哪怕今天是 0】见 pricing-config 的 draft_export.per_pdf 注释：
// 「免费」与「不计价」是两件事。现在按 0 走完同一条流程，改价只是往 pricing_config 写一行。
//
// 【两步，不是一步】设计稿 §4.2「所有 💰 工具两步」：不带 quote_id 只回一张报价单，
// 带 quote_id 才渲染并扣费。今天单价是 0，一步式与两步式在回包上看不出差别——
// 这正是不能省的理由：省掉之后，运营哪天往 pricing_config 写一个非零单价，
// 每次调用就会在用户从没看见过价钱的情况下直接扣走公道值，而两边一行报错都不会有。
// 「报个价就被扣了」与「没报价就被扣了」是同一类事故的两头。
//
// 【顺序：先渲染、后收钱】渲染失败一分不收，所以本文件里没有退款分支。
// 反过来（先扣后渲）在今天看不出差别（价是 0），
// 但收费落地那天就成了「扣了钱、没拿到文件」——而那时没人会回来重排这个顺序。
// 落文件与签地址同样排在确认之后：确认没过（余额不够 / 报价过期 / 这张报价已经用过）时，
// 库里一份取不走的文件都不该多出来。
import type { Database } from 'better-sqlite3';

import {
  confirmService,
  peekServiceQuote,
  quoteService,
  type ServiceQuote,
} from '@/lib/billing/service-quotes';
import * as cases from '@/lib/cases';
import type { DomainFailure, Result } from '@/lib/cases';
import { renderDraftPdf } from '@/lib/evidence/sidecar-client';
import { storeBytes } from '@/lib/evidence/files';
import { DOWNLOAD_TOKEN_TTL_MS, issueDownloadToken } from '@/lib/files/download-token';

/** 目前只支持 pdf。留成枚举而不是布尔，是因为 docx 是可预见的下一个。 */
export const DRAFT_EXPORT_FORMATS = ['pdf'] as const;
export type DraftExportFormat = (typeof DRAFT_EXPORT_FORMATS)[number];

const TTL_MINUTES = DOWNLOAD_TOKEN_TTL_MS / 60_000;

function fail(status: number, errorCode: string, message: string): DomainFailure {
  return { ok: false, status, errorCode, message };
}

/** 下载地址的路径部分。PUBLIC_BASE_URL 配了就拼绝对地址（同 evidence_upload_url 的口径）。 */
export function downloadUrlFor(token: string): string {
  const path = `/api/v1/files/download/${token}`;
  const base = process.env.PUBLIC_BASE_URL?.trim();
  return base ? `${base.replace(/\/+$/, '')}${path}` : path;
}

/**
 * 文书标题 → 下载文件名。路径分隔符、Windows 保留字符与控制字符一律换成下划线。
 * 中文原样保留（下载头按 RFC 5987 编码，见下载路由）——把中文也洗掉的话，
 * 用户存到桌面上的会是一串下划线，认不出是哪一份。空标题回兜底名。
 */
function safeFilename(title: string): string {
  // eslint-disable-next-line no-control-regex -- 控制字符正是这里要洗掉的东西
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60);
  return `${cleaned || '文书'}.pdf`;
}

/**
 * 报价回包的对外形态：字段名一律下划线，与 doc_submit 的报价回包（DocQuoteView）对齐。
 * ServiceQuote 是仓内 camelCase 风格，转换在这一层做——直接把它抛出去会让 draft_export
 * 回 quoteId/expiresAt，与全部 MCP 入参、以及同为报价流的 doc_submit 打架。
 */
export interface DraftExportQuoted {
  stage: 'quote';
  draft_id: number;
  version: number;
  format: DraftExportFormat;
  quote_id: number;
  amount: number;
  expires_at: string;
  units: number;
  unit_label: string;
  unit_price: number;
  price_key: string;
  label: string;
  next: string;
}

export interface DraftExported {
  stage: 'done';
  draft_id: number;
  version: number;
  format: DraftExportFormat;
  filename: string;
  download_url: string;
  expires_at: string;
  size: number;
  sha256: string;
  /** 这次导出走的那张报价（今天金额为 0，账上照样有一笔可查的记录） */
  quote_id: number;
  amount: number;
  charged: number;
  paid_by: string;
  note: string;
}

/**
 * 导出一份文书。**两步**（设计稿 §4.2）：
 *   不带 quoteId ⇒ 只回一张报价单，一分不扣；
 *   带 quoteId  ⇒ 核对报价 → 渲染 → 按这张报价确认扣费 → 落文件、签下载地址。
 *
 * 归属：借 cases.getDraft 的既有判定——别人的草稿在那里就是 404 DRAFT_NOT_FOUND，
 * 「不存在」与「不是你的」刻意不分（能分辨就成了枚举探针）。
 * 实名闸**不在这里**：它由能力注册表的 precondition 统一拦（lib/capabilities/registry.ts），
 * 各处各写一句的形态是新加一条能力时忘了抄那一句，而它照常返回 200。
 */
export async function exportDraft(
  db: Database,
  input: { userId: number; draftId: number; format?: unknown; quoteId?: number },
): Promise<Result<DraftExportQuoted | DraftExported>> {
  const format = input.format === undefined || input.format === null ? 'pdf' : input.format;
  if (!(DRAFT_EXPORT_FORMATS as readonly unknown[]).includes(format)) {
    return fail(
      400,
      'INVALID_FORMAT',
      `format 目前只支持 ${DRAFT_EXPORT_FORMATS.join(' / ')}，收到 ${JSON.stringify(input.format)}。`,
    );
  }

  const found = cases.getDraft(db, { userId: input.userId, draftId: input.draftId });
  if (!found.ok) return found;
  const draft = found.draft;

  const body = (draft.content ?? '').trim();
  if (!body) {
    return fail(
      422,
      'DRAFT_EMPTY',
      `文书 ${draft.id}《${draft.title}》正文是空的，没有可导出的内容，本次没有产生任何扣费。` +
        '一份零字的 PDF 看起来像导出成功了，要到打开它的时候才发现是空的。' +
        '请先用 draft_write 把正文写进这一稿再导出。',
    );
  }

  // ── 第一步：报价。只落一行 service_quotes，不动钱（quoteService 第一条铁律）。──
  if (input.quoteId === undefined) {
    const quoted = quoteService(db, {
      userId: input.userId,
      caseId: draft.case_id,
      service: 'export',
      payload: { units: 1 },
    });
    if (!quoted.ok) return fail(quoted.status, quoted.errorCode, quoted.message);
    const q: ServiceQuote = quoted.quote;
    return {
      ok: true,
      stage: 'quote',
      draft_id: draft.id,
      version: draft.version,
      format: 'pdf',
      quote_id: q.quoteId,
      amount: q.amount,
      expires_at: q.expiresAt,
      units: q.breakdown.units,
      unit_label: q.breakdown.unitLabel,
      unit_price: q.breakdown.unitPrice,
      price_key: q.breakdown.priceKey,
      label: q.breakdown.label,
      next:
        `带上 quote_id=${q.quoteId} 再调一次 draft_export，才渲染 PDF 并按这张报价扣费。` +
        '报价免费，不确认就一分都不扣；报价过期了重新报一次即可。',
    };
  }

  // ── 第二步：核对报价 → 渲染 → 确认扣费 → 落文件、签地址 ──
  //
  // 【核对必须在确认之前】confirmService 一返回钱就已经扣了。把「这张报价买的是不是这件事」
  // 放到它后面核，就成了「先扣、再发现买错了」，只能靠一笔本不该发生的退款去补。
  const peeked = peekServiceQuote(db, input.userId, input.quoteId);
  if (peeked === null) {
    return fail(
      404,
      'QUOTE_NOT_FOUND',
      `报价 ${input.quoteId} 不存在或不属于本人。` +
        '怎么办：不带 quote_id 调一次 draft_export 重新取报价号——报价是免费的。',
    );
  }
  if (peeked.service !== 'export') {
    return fail(
      400,
      'QUOTE_SERVICE_MISMATCH',
      `报价 ${input.quoteId} 是给「${peeked.service}」报的，不能用来导出文书。` +
        '为什么：一张报价只买它自己那件事；不校验就等于这件事能按另一件事的价钱结账。' +
        '怎么办：不带 quote_id 调一次 draft_export 重新取报价号。',
    );
  }
  if (peeked.caseId !== draft.case_id) {
    return fail(
      400,
      'QUOTE_CASE_MISMATCH',
      `报价 ${input.quoteId} 是给案件 ${peeked.caseId} 报的，不能用来导出案件 ${draft.case_id} 的文书。` +
        '怎么办：对这份文书重新报一次价，再带新的 quote_id 来确认。',
    );
  }

  // 渲染。失败到此为止：报价那一行留着（未确认 = 未扣费），到期自然作废。
  let pdf: Buffer;
  try {
    pdf = await renderDraftPdf({
      title: draft.title,
      subtitle: null,
      markdown: body,
      footer_note: null,
    });
  } catch (err) {
    return fail(
      502,
      'EXPORT_RENDER_FAILED',
      `文书渲染服务没有把 PDF 交回来，本次没有产生任何扣费，草稿本身一个字都没有改动。` +
        `原因：${err instanceof Error ? err.message : String(err)}。` +
        '怎么办：带同一个 quote_id 重新导出一次；导出不改动任何案卷数据，重试没有副作用。',
    );
  }

  // 收钱。今天是 0，照样落一条流水——「导出过几份」在免费期也要答得上来。
  const confirmed = confirmService(db, input.userId, input.quoteId);
  if (!confirmed.ok) return fail(confirmed.status, confirmed.errorCode, confirmed.message);

  /**
   * 这张报价此前已经确认过。**一张报价只导出一份**：放行的形态是拿一张确认过的报价反复重调，
   * 每次 charged=0 照样拿到一份新 PDF 与一条新下载地址——收费落地那天就是「付一次、永久免费导出」。
   * 这一步排在落文件与签地址之前：被挡住的调用不该在库里留下一份谁都取不走的文件。
   */
  if (confirmed.deduped) {
    return fail(
      409,
      'QUOTE_ALREADY_USED',
      `报价 ${input.quoteId} 已经确认过了，不能再用来导出一份。` +
        '为什么：一张报价对应一次导出；下载地址本身也是一次性的，要再取一份就要重新报价。' +
        '怎么办：不带 quote_id 调一次 draft_export 重新取报价号，再带新的 quote_id 来确认。',
    );
  }

  // 落 files 表（内容寻址 + 加密，与证据文件同一条管线），再签一次性限时下载地址。
  const stored = storeBytes(db, pdf, 'application/pdf');
  const filename = safeFilename(draft.title);
  const issued = issueDownloadToken(db, {
    fileId: stored.fileId,
    userId: input.userId,
    filename,
    mime: 'application/pdf',
  });

  return {
    ok: true,
    stage: 'done',
    draft_id: draft.id,
    version: draft.version,
    format: 'pdf',
    filename,
    download_url: downloadUrlFor(issued.token),
    expires_at: issued.expiresAt,
    size: stored.size,
    sha256: stored.sha256,
    quote_id: confirmed.quoteId,
    amount: confirmed.amount,
    charged: confirmed.charged,
    paid_by: confirmed.paidBy,
    note:
      `下载地址只能取一次、${TTL_MINUTES} 分钟内有效，直接用浏览器打开即可（不必带凭据）。` +
      '过期或已取过就重新报一次价、再确认一次，导出一份新的。' +
      '导出的是正文原文，不含站内那段「发出前必读」提醒——那段是给你自己看的。',
  };
}
