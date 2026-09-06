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
import { writeOnce } from '@/lib/capabilities/shared';
import * as cases from '@/lib/cases';
import type { DomainFailure, Result } from '@/lib/cases';
import { findFileById } from '@/lib/db/evidence';
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
  /** 本次没有发生扣费（重放）时是 null——写一个付款方式上去等于把上次那笔说成又付了一次 */
  paid_by: string | null;
  /** true = 这次是重放：同一个 client_ref（不给时同一张报价）此前已经导出过，回的是那一份 */
  deduped: boolean;
  note: string;
}

/**
 * 这次导出的幂等键：调用方给了 client_ref 就用它，没给就拿报价号当自然键
 * （一张报价只导出一份）。与 doc_submit 的 refOf 同形（lib/docs/review.ts）。
 */
function refOf(clientRef: unknown, quoteId: number): string {
  const trimmed = typeof clientRef === 'string' ? clientRef.trim() : '';
  return trimmed || `quote:${quoteId}`;
}

/** 这个幂等键此前落过哪一份 files 行；没落过回 null。 */
function existingExportFile(db: Database, caseId: number, clientRef: string): number | null {
  const row = db
    .prepare(
      "SELECT target_id FROM agent_writes WHERE case_id=? AND tool='draft_export' AND client_ref=?",
    )
    .get(caseId, clientRef) as { target_id: number } | undefined;
  return row ? row.target_id : null;
}

/**
 * 已经有一份 files 行了 ⇒ 签一条新的一次性下载地址，拼出对外回包。
 * 首次导出与重放走同一个出口：分成两段各拼一份的形态是，两边的字段哪天不一样，
 * 而客户端只在其中一条路径上试过。
 */
function issueExported(
  db: Database,
  args: {
    draftId: number;
    title: string;
    version: number;
    userId: number;
    fileId: number;
    size: number;
    sha256: string;
    quoteId: number;
    amount: number;
    charged: number;
    paidBy: string | null;
    deduped: boolean;
  },
): { ok: true } & DraftExported {
  const filename = safeFilename(args.title);
  const issued = issueDownloadToken(db, {
    fileId: args.fileId,
    userId: args.userId,
    filename,
    mime: 'application/pdf',
  });
  return {
    ok: true,
    stage: 'done',
    draft_id: args.draftId,
    version: args.version,
    format: 'pdf',
    filename,
    download_url: downloadUrlFor(issued.token),
    expires_at: issued.expiresAt,
    size: args.size,
    sha256: args.sha256,
    quote_id: args.quoteId,
    amount: args.amount,
    charged: args.charged,
    paid_by: args.paidBy,
    deduped: args.deduped,
    note:
      (args.deduped
        ? '这次调用与之前某次用了同一个幂等键（client_ref，不给时是这张报价），' +
          '服务端没有重新渲染、也没有再扣一次费，回的就是上次那一份 PDF，只是重签了一条新地址。'
        : '') +
      `下载地址只能取一次、${TTL_MINUTES} 分钟内有效，直接用浏览器打开即可（不必带凭据）。` +
      '过期或已取过就重新报一次价、再确认一次，导出一份新的。' +
      '导出的是正文原文，不含站内那段「发出前必读」提醒——那段是给你自己看的。',
  };
}

/**
 * 导出一份文书。**两步**（设计稿 §4.2）：
 *   不带 quoteId ⇒ 只回一张报价单，一分不扣；
 *   带 quoteId  ⇒ 查幂等键 → 核对报价 → 渲染 → 按这张报价确认扣费 → 落文件、签下载地址。
 *
 * 【确认这一步必须可重放】设计稿 §4.1：写工具带 client_ref 重放，回既有对象 + deduped:true。
 * 典型场景是「确认成功、响应在回程丢了」，客户端照说明书原样重试同一次调用。
 * 挡回去（要求「重新报价再确认」）在今天单价 0 时看不出损失，
 * 改价之后就是「付了钱、响应丢了、再付一次」。所以重放走的是幂等键查表（同 doc_submit）：
 * 命中即拿上次那份 files 行重签一条下载地址，**不重渲、不重扣**。
 * 重签而不是回原地址：下载地址本身是一次性的，把用过的那条回给用户等于回一条打不开的链接。
 *
 * 归属：借 cases.getDraft 的既有判定——别人的草稿在那里就是 404 DRAFT_NOT_FOUND，
 * 「不存在」与「不是你的」刻意不分（能分辨就成了枚举探针）。
 * 实名闸**不在这里**：它由能力注册表的 precondition 统一拦（lib/capabilities/registry.ts），
 * 各处各写一句的形态是新加一条能力时忘了抄那一句，而它照常返回 200。
 */
export async function exportDraft(
  db: Database,
  input: {
    userId: number;
    draftId: number;
    format?: unknown;
    quoteId?: number;
    clientRef?: unknown;
    /** 走 api key 的调用带它，网页登录态留空。只进台账，不参与去重。 */
    keyId?: number | null;
  },
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

  // ── 重放：这个幂等键此前已经导出过 ⇒ 回那一份，不渲染、不扣费 ──
  //
  // 【为什么排在渲染与 confirmService 之前】排在后面就白渲一次（sidecar 一次真调用），
  // 更要命的是 confirmService 已经跑过：调用方拿同一个 client_ref 配一张**新**报价重试时，
  // 那张新报价会被真扣走，然后才发现"上次已经导出过了"。
  // 【为什么不借 confirmService 取上次的金额与付款方式】同上：新报价那一路它会真扣。
  // 重放这一路一分不扣，charged 记 0、paid_by 记 null，amount 按手上这张报价的面额如实报。
  const clientRef = refOf(input.clientRef, input.quoteId);
  const replayedFileId = existingExportFile(db, draft.case_id, clientRef);
  if (replayedFileId !== null) {
    const fileRow = findFileById(db, replayedFileId);
    if (fileRow) {
      return issueExported(db, {
        draftId: draft.id,
        title: draft.title,
        version: draft.version,
        userId: input.userId,
        fileId: fileRow.id,
        size: fileRow.size,
        sha256: fileRow.sha256,
        quoteId: input.quoteId,
        amount: peeked.amount,
        charged: 0,
        paidBy: null,
        deduped: true,
      });
    }
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
   * 这张报价此前确认过，而上面那道幂等查表又没命中——只可能是**换了一个 client_ref
   * 拿同一张报价再来一次**。这条路要挡：放行的形态是拿一张确认过的报价配无数个 client_ref
   * 反复重调，每次 charged=0 照样渲一份新 PDF（渲的还是**当下**的正文，未必是当初付钱那一版）
   * ——收费落地那天就是「付一次、永久免费导出」。
   * 幂等键相同的那一路不会走到这里：它在渲染之前就已经拿上次那份回去了。
   * 这一步排在落文件与签地址之前：被挡住的调用不该在库里留下一份谁都取不走的文件。
   */
  if (confirmed.deduped) {
    return fail(
      409,
      'QUOTE_ALREADY_USED',
      `报价 ${input.quoteId} 已经确认过了，而这次带的 client_ref 与当初那次不是同一个，` +
        '不能再用来导出一份。' +
        '为什么：一张报价对应一次导出；换个幂等键就能再导一份的话，一张报价就能导无数份。' +
        '怎么办：只是重试上一次调用（比如没收到回包）就带**同一个** client_ref 原样重发，' +
        '服务端会把上次那一份原样交回、一分不扣；' +
        '真要再导一份就不带 quote_id 调一次 draft_export 重新取报价号。',
    );
  }

  // 落 files 表（内容寻址 + 加密，与证据文件同一条管线）并记一行台账。
  //
  // 【为什么落文件要包在 writeOnce 里】台账那一行就是上面那道重放查表读的东西。
  // 「先落文件、成了再补记一笔」在正常路径上看不出问题，出问题的是两步之间：
  // 文件已经落库、记台账时进程被杀，于是这次导出在台账里不存在——用户带同一个 client_ref
  // 重试，查不到那一行，就走到上面那条 409，被告知"重新报价"，而钱已经扣过了。
  const recorded = writeOnce(
    db,
    { caseId: draft.case_id, tool: 'draft_export', clientRef, keyId: input.keyId ?? null },
    () => {
      // 只带出下面要用的三个字段：storeBytes 自己也有一个 deduped（按内容哈希去重，
      // 与 client_ref 去重是两件事），原样摊平会和 writeOnce 的 deduped 撞名。
      const s = storeBytes(db, pdf, 'application/pdf');
      return { ok: true as const, fileId: s.fileId, size: s.size, sha256: s.sha256 };
    },
    (res) => ({ table: 'files', id: res.fileId }),
  );
  if (recorded.ok !== true) return recorded;

  // deduped 分支只在并发抢同一个 client_ref 时出现（同进程串行，跨进程靠唯一索引）。
  // 这一路本次是真扣了费的，charged 照实报，但交回的是先到那笔落下的文件。
  const target = recorded.deduped
    ? findFileById(db, recorded.id)
    : { id: recorded.fileId, size: recorded.size, sha256: recorded.sha256 };
  if (!target) {
    return fail(
      500,
      'EXPORT_FILE_MISSING',
      `导出已记账（报价 ${input.quoteId}），但台账指向的那一行文件读不回来。` +
        '这是服务端的数据不一致，不是你的操作有问题。把这个报价号发给我们，本次费用会原路退回。',
    );
  }

  return issueExported(db, {
    draftId: draft.id,
    title: draft.title,
    version: draft.version,
    userId: input.userId,
    fileId: target.id,
    size: target.size,
    sha256: target.sha256,
    quoteId: confirmed.quoteId,
    amount: confirmed.amount,
    charged: confirmed.charged,
    paidBy: confirmed.paidBy,
    deduped: recorded.deduped,
  });
}
