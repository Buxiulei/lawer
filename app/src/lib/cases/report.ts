// app/src/lib/cases/report.ts
// 个案报告（设计稿 §4.3）：一案一份、整理过的长期记忆。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现具体领域的字面量（见 lib/capabilities/registry.ts 抬头，由
// lib/capabilities/__tests__/registry-guard.test.ts 机检）。分节标题一律从
// DomainPack.reportSections 取，本文件只认 source 那几个英文键。
// ─────────────────────────────────────────────────────
//
// 【它解决的是什么】档案里的事实分散在六张表，agent 每轮都要现拼一遍；拼出来的那份
// 没人存，下一轮再拼一次——而拼错的地方每轮都不一样。报告是**存下来的那一份**：
// 开工先看它，收工前更新它。
//
// 【惰性生成】首次 get 时才跑 bootstrap。**不做回填任务**：全库几千个案子里，
// 绝大多数从来没人打开过报告，为它们各生成一份初稿，等于把一批没人读的文本写进库，
// 而且写的那一刻就开始过期。
//
// 【过期不在这里写】任何 stale_* 的写入都只经 ./report-stale 的 markReportStale
// （唯一入口，理由见那个文件的抬头）。本文件只**读**它、以及在整理完之后清掉它。
import type { Database } from 'better-sqlite3';

import { parseBrief } from '@/lib/evidence/brief';
import { precedentLine } from '@/lib/knowledge/precedent-line';
import * as caseStore from '@/lib/db/cases';
import * as agentStore from '@/lib/db/agent';
import { getDomainPack, type DomainPack, type ReportSectionSpec } from '@/lib/domains/registry';

import { buildElementSheet, type ElementRow } from './elements';
import {
  buildIssueTable,
  counterpartyDecisionOnFile,
  issueMarker,
  issueMarkersIn,
  type IssueRow,
} from './issue-table';

import {
  countStaleTally,
  formatStaleTally,
  markReportStale,
  parseStaleTally,
  REPORT_IDLE_REASON,
  REPORT_IDLE_STALE_DAYS,
  type StaleTally,
} from './report-stale';

export { markReportStale, REPORT_IDLE_REASON, REPORT_IDLE_STALE_DAYS };

export interface ReportFailure {
  ok: false;
  status: number;
  errorCode: string;
  message: string;
}

type Result<T> = ({ ok: true } & T) | ReportFailure;

function fail(status: number, errorCode: string, message: string): ReportFailure {
  return { ok: false, status, errorCode, message };
}

/** 案件不存在与不属于本人返回同一个错误，与 lib/cases 同口径（不泄漏 id 有效性）。 */
const NOT_FOUND = (): ReportFailure => fail(404, 'CASE_NOT_FOUND', '案件不存在');

/** 报告落库行。version=0 = 只被过期标记建过的占位行，还没有初稿。 */
export interface CaseReportRow {
  case_id: number;
  sections_json: string;
  rendered_md: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  stale_since: string | null;
  stale_reason: string | null;
}

/** 分节内容：标题 → 正文（Markdown 片段，不含自己那一行标题）。 */
export type ReportSections = Record<string, string>;

/** 过期状态。三态由 `state` 分：null=不过期；'changed'=有变动；'idle'=太久没整理。 */
export interface ReportStaleState {
  state: null | 'changed' | 'idle';
  /** 从哪天起过期，YYYY-MM-DD；state=null 时为 null */
  since: string | null;
  /** 变动条数；'idle' 档为 0（它不是由某几次写入触发的） */
  changes: number;
  /** 「新证据 2、时间线 1」；'idle' 档为固定说明 */
  detail: string;
}

const REPORT_COLUMNS =
  'case_id, sections_json, rendered_md, version, updated_at, updated_by, stale_since, stale_reason';

export function findReportRow(db: Database, caseId: number): CaseReportRow | undefined {
  return db.prepare(`SELECT ${REPORT_COLUMNS} FROM case_reports WHERE case_id = ?`).get(caseId) as
    | CaseReportRow
    | undefined;
}

function parseSections(json: string): ReportSections {
  try {
    const v: unknown = JSON.parse(json);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: ReportSections = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string') out[k] = val;
      }
      return out;
    }
  } catch {
    // 脏行不该让读侧崩：当作"还没有内容"，下一次 get 会重新生成初稿。
  }
  return {};
}

function dateOnly(sqlTime: string): string {
  return sqlTime.slice(0, 10);
}

/**
 * 判过期。两个来源合成一个答案：
 *   ① markReportStale 记下的变动（stale_since 非空）；
 *   ② 距上次整理超过 REPORT_IDLE_STALE_DAYS 天——**读时判定，不落库**：
 *      落库要靠一个定时任务去扫全表，而"没跑"和"没到期"在库里长得一模一样。
 * 两者同时成立时报①：说得出「多了哪几条」比说「太久没整理」有用得多。
 */
export function reportStaleState(
  row: CaseReportRow | undefined,
  now: Date = new Date(),
): ReportStaleState {
  const none: ReportStaleState = { state: null, since: null, changes: 0, detail: '' };
  if (!row) return none;

  if (row.stale_since) {
    const tally: StaleTally = parseStaleTally(row.stale_reason);
    const changes = countStaleTally(tally);
    return {
      state: 'changed',
      since: dateOnly(row.stale_since),
      changes,
      detail: formatStaleTally(tally),
    };
  }

  // 没有初稿的占位行谈不上"太久没整理"——它一次都还没整理过，get 一下就有了。
  if (row.version === 0 || !row.updated_at) return none;

  const updatedMs = Date.parse(`${row.updated_at.replace(' ', 'T')}Z`);
  if (Number.isNaN(updatedMs)) return none;
  const days = (now.getTime() - updatedMs) / 86_400_000;
  if (days < REPORT_IDLE_STALE_DAYS) return none;
  return {
    state: 'idle',
    since: dateOnly(row.updated_at),
    changes: 0,
    detail: REPORT_IDLE_REASON,
  };
}

// ========== 初稿生成 ==========

const NONE = '（档案里还没有这一项）';

function fmtYuan(fen: number): string {
  return `${(fen / 100).toFixed(2)} 元`;
}

function bullets(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join('\n');
}

interface ReportInput {
  caseRow: caseStore.CaseRow;
  timeline: caseStore.TimelineEventRow[];
  claims: agentStore.ClaimRow[];
  deadlines: caseStore.DeadlineRow[];
  actions: caseStore.ActionItemRow[];
  evidence: caseStore.EvidenceRow[];
  /** 要件表要读它（对方主体那一张表也是事实槽的取数面之一，见 lib/cases/elements.resolveSlot） */
  companies: agentStore.CompanyProfileRow[];
}

/** 生成初稿时一节最多列几条明细。超出的部分要留痕，不能只裁不说。 */
const DRAFT_ITEMS_MAX = 20;

function trimmed<T>(rows: T[], render: (row: T) => string): string {
  const shown = rows.slice(0, DRAFT_ITEMS_MAX);
  const lines = shown.map(render);
  if (rows.length > shown.length) {
    lines.push(`（共 ${rows.length} 条，此处只列 ${shown.length} 条；其余去对应的清单里看）`);
  }
  return bullets(lines);
}

/**
 * 一节的初稿正文。**每一句都来自库里的同值字段**，取不到就写「档案里还没有这一项」——
 * 报告是长期记忆，一个编出来的数字会被后面每一轮当成既有事实用。
 */
function draftSection(
  source: ReportSectionSpec['source'],
  input: ReportInput,
  now: Date,
  pack: DomainPack,
): string {
  const c = input.caseRow;
  switch (source) {
    case 'basics': {
      const wage = c.monthly_wage_fen === null ? NONE : fmtYuan(c.monthly_wage_fen);
      return bullets([
        `抬头：${c.title}`,
        `当前阶段：${c.stage}`,
        // 【当前轨】只有声明了并行轨的领域才有这一行（设计稿 §16）。没有并行轨的领域
        // 印一行「当前轨：主线」是常驻噪音，而常驻噪音会被连同真信息一起跳过去。
        // 与事实卡同一口径：轨**不覆盖**阶段，两行并排出现才说得清"主线没动"。
        ...(pack.tracks.length > 0
          ? [
              c.track
                ? `当前轨：${c.track}（与主线并行，主线阶段仍是「${c.stage}」）`
                : `当前轨：主线（没有并行轨在走）；本领域的并行轨：${pack.tracks.join('、')}`,
            ]
          : []),
        `辖区：${c.district}`,
        `起算日：${c.employed_from ?? NONE}`,
        `月度金额基数：${wage}`,
        `岗位：${c.position ?? NONE}`,
        `合同签订次数：${c.contract_count ?? NONE}`,
      ]);
    }
    case 'narrative': {
      // 主线按发生时间正序：报告是拿来"从头读一遍"的，倒序的时间线读起来是倒放的。
      const asc = [...input.timeline].sort((a, b) => a.happened_at.localeCompare(b.happened_at));
      if (!asc.length) return NONE;
      return trimmed(asc, (e) => `${dateOnly(e.happened_at)}　${e.title}${e.detail ? `——${e.detail}` : ''}`);
    }
    case 'disputes': {
      // 【派生集，不是自由发挥】每一行由要件表按三条规则捞出来（lib/cases/issue-table.ts），
      // 行首带 `〔争点 id〕` 标记；改这一节的措辞可以，增删条目会被 updateSection 拒掉。
      const derived = derivedIssues(input, pack);
      if (derived) {
        if (!derived.rows.length) {
          return (
            `- 本案已登记诉求的 ${derived.elements.length} 个要件目前**全部成立**，派生不出争点。\n` +
            '- 这不是"没有风险"：它只说明档案里这几项都有支撑，对方还没有在档案里主张过什么。'
          );
        }
        return [
          `- 下面 ${derived.rows.length} 条由要件表派生（要件没成立 / 对方主张过 / 举证责任在对方且其书面决定已在档）。`,
          '- **条目只增不减地由服务端维护**：措辞可以改成人话，增删条目要先改档案，不能在这里改。',
          ...derived.rows.flatMap(issueLines),
        ].join('\n');
      }
      // 退回原来的写法：本领域还没有要件卡，或本案一项诉求都没登记。**明说它不是派生的**。
      if (!input.claims.length) return NONE;
      const total = input.claims.reduce((n, r) => n + r.amount_fen, 0);
      return (
        `${trimmed(input.claims, (r) => `${r.kind}：${fmtYuan(r.amount_fen)}${r.basis ? `（依据 ${r.basis}）` : ''}`)}\n` +
        `- 合计：${fmtYuan(total)}\n` +
        '- （本节此刻列的是已登记的金额，**不是**派生的争点：这个领域还没有要件卡。）'
      );
    }
    case 'positions':
      return bullets([`目标：${c.goal ?? NONE}`, `底线：${c.bottom_line ?? NONE}`]);
    case 'evidence': {
      if (!input.evidence.length) return NONE;
      const byCat = new Map<string, number>();
      for (const e of input.evidence) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);
      const head = `合计 ${input.evidence.length} 件（${[...byCat].map(([k, n]) => `${k} ${n}`).join('、')}）`;
      return `${bullets([head])}\n${trimmed(input.evidence, (e) => {
        const brief = parseBrief(e.brief_json);
        const note = brief ? `简报：${brief.proves}` : '未提取（没读过内容）';
        return `${e.name}〔${e.category}〕${note}`;
      })}`;
    }
    case 'timeline': {
      if (!input.timeline.length) return NONE;
      const desc = [...input.timeline].sort((a, b) => b.happened_at.localeCompare(a.happened_at));
      return trimmed(desc, (e) => `${dateOnly(e.happened_at)}　[${e.kind}] ${e.title}`);
    }
    case 'deadlines': {
      const live = input.deadlines.filter((d) => !d.resolved_at);
      if (!live.length) return NONE;
      return trimmed(live, (d) => `${d.kind}：${dateOnly(d.due_at)} 到期${d.derived_from ? `（${d.derived_from}）` : ''}`);
    }
    case 'actions': {
      const open = input.actions.filter((a) => a.status === '待办');
      if (!open.length) return NONE;
      return trimmed(open, (a) => `${a.title}${a.due_at ? `（${dateOnly(a.due_at)} 前）` : ''}`);
    }
    case 'risks': {
      // 【领域的固定条目排在最前，且与"缺口"分开成两段】它们不是缺口——缺口补齐了就消失，
      // 而这几条是这个行当里本来就没有定论的东西，只会由某位律师针对某个案子书面确认一次。
      // 混进缺口列表的形态是：模型看见"风险 6 条"，于是逐条"解决"它们，
      // 而解决其中四条的唯一方式就是给出一个结论——那正是这几条要拦的事。
      //
      // 【为什么每条下面还要挂一行「过往相似案例」】报告是用户和模型一起"从头读一遍"的
      // 那一份。只印条目本身的形态是：读到"这几件事没有定论"就到此为止，
      // 既不知道库里有没有判过的，也没有任何东西说"库里确实没有"——于是要么跳过找案例
      // 这一步，要么顺手编一个填上。措辞与事实卡共用同一个入口（lib/knowledge/precedent-line），
      // 两处各写一句的形态是其中一处的空臂悄悄消失，而两份文本各自读起来都正常。
      const fixed = pack.interpretationDisputed
        ? [
            `- **${pack.interpretationDisputed.discipline}**`,
            ...pack.interpretationDisputed.items.flatMap((x) => [
              `- ${x.text}`,
              `  - ${precedentLine(x.precedents)}`,
            ]),
          ].join('\n')
        : '';
      const gaps: string[] = [];
      const missing = basicsMissing(c);
      if (missing.length) gaps.push(`基本盘缺 ${missing.length} 项：${missing.join('、')}`);
      const unextracted = input.evidence.filter((e) => !parseBrief(e.brief_json)).length;
      if (unextracted) gaps.push(`有 ${unextracted} 件材料没读过内容，里面写了什么还不知道`);
      if (!input.deadlines.some((d) => !d.resolved_at)) gaps.push('档案里没有生效中的期限，还没核过时限');
      if (!input.claims.length) gaps.push('还没有算过任何金额主张');
      const gapText = gaps.length
        ? bullets(gaps)
        : '（初稿阶段没发现明显缺口；风险要靠人判断，别把这一行当成"没有风险"）';
      // 【未定项 = 还没成立的那几个要件】同样是派生集，行首带同一个 `〔争点 id〕` 标记，
      // 只收「缺失 / 不成立 / 成立·待证」那几行——已经成立的要件不是未定项。
      // 它与上面「争议焦点」的分别：那一节是"在争什么"（含举证责任在对方的那几条），
      // 这一节是"还立不住的那几条"，两节的下一步动作不同。
      const derived = derivedIssues(input, pack);
      const unsettled = (derived?.rows ?? []).filter((r) => r.reasons.includes('element_unsettled'));
      const unsettledText = unsettled.length
        ? [
            `- 还没立住的要件 ${unsettled.length} 条（由要件表派生，措辞可改、条目不可增删）：`,
            ...unsettled.flatMap(issueLines),
          ].join('\n')
        : '';
      return [fixed, gapText, unsettledText].filter((x) => x).join('\n\n');
    }
    case 'changelog':
      return bullets([`${dateOnly(now.toISOString())}　system：从档案生成初稿`]);
  }
}

/**
 * 报告里那两节的**派生源**：要件表 → 争点表（设计稿 §4.3-3）。
 *
 * 【为什么这两节改成派生】此前「争议焦点」印的是诉求金额清单、「风险与未定项」印的是几条缺口，
 * 两节都不说"这一项凭什么成立、还差什么、该谁证"。而模型每一轮自由发挥出来的争点，
 * 同一个案子这一轮说争 A、下一轮说争 B——判据「争点回声」（正文提到的争点 ⊆ 争点表）
 * 要成立，前提是**有一张服务端说得清出处的争点表**。
 *
 * 取不到（本领域还没有要件卡 / 本案一项诉求都没登记）时回 null，两节各自退回原来的写法，
 * 并在正文里说清这一节此刻不是派生的——静默退回的形态是：一节读起来完全正常，
 * 而"它是机器派生的"这个前提已经不成立了。
 */
function derivedIssues(input: ReportInput, pack: DomainPack): { rows: readonly IssueRow[]; elements: readonly ElementRow[] } | null {
  const cards = pack.elementCards ?? [];
  if (cards.length === 0) return null;
  const kinds = [...new Set(input.claims.map((c) => c.kind))];
  const facts = {
    case: {
      employed_from: input.caseRow.employed_from,
      position: input.caseRow.position,
      monthly_wage_fen: input.caseRow.monthly_wage_fen,
      contract_count: input.caseRow.contract_count,
    },
    claims: input.claims,
    timeline: input.timeline,
    companies: input.companies,
    evidence: input.evidence,
  };
  const sheet = buildElementSheet(facts, cards, kinds);
  if (!sheet.rendered) return null;
  // 对方那份书面决定在不在档：槽位由领域包声明（共用层不认识它在这个行当里叫什么），
  // 判定走 issue-table 的唯一入口（那里说明了为什么不许在这里再写一遍同形的三行）。
  const onFile = counterpartyDecisionOnFile(pack.counterpartyDecision, facts);
  const table = buildIssueTable(sheet.rows, { counterpartyDecisionOnFile: onFile }, true);
  return { rows: table.rows, elements: sheet.rows };
}

/**
 * 从要件表派生的那几节（**source 英文键**，不是标题——标题归领域包，本文件不认识它）。
 * 与 draftSection 里调 derivedIssues 的那两个分支同值：多一节少一节都要有人来改这一行。
 */
const DERIVED_SOURCES: readonly ReportSectionSpec['source'][] = ['disputes', 'risks'];

/**
 * 一段文本里**顶格 `- ` 却不带 `〔争点 id〕` 标记**的那些行。
 *
 * 【为什么只看顶格】`  - 下一步：…` 是某一条派生条目自己的子行，缩进着；把子行也算进来
 * 等于不许模型在某一条下面多写一句话，而那正是"改写成人话"要允许的事。
 */
const isUnmarkedBullet = (line: string): boolean => /^-\s/.test(line) && issueMarkersIn(line).size === 0;

function unmarkedBullets(text: string): string[] {
  return text.split('\n').filter(isUnmarkedBullet).map((l) => l.trim());
}

/** 第一条**带标记**的顶格条目在第几行（没有则 -1）。 */
function firstMarkedBullet(text: string): number {
  return text.split('\n').findIndex((l) => l.startsWith('-') && issueMarkersIn(l).size > 0);
}

/**
 * 派生节里"多出来的条目"——**不带标记那一半**。两把尺，各拦一种绕路：
 *
 *   · `after`：第一条派生条目**之后**还有顶格无标记的条目 ⇒ 那是节末追加的一条争点。
 *   · `extra`：整节的顶格无标记条目**比服务端初稿里的还多** ⇒ 那是插在条目区之前、
 *     或者在一条派生争点都没有的那一段里凭空写出来的。
 *
 * 【为什么不是裁决字面的"整节计数 >0 即拒"】服务端初稿自己就带着几行顶格说明：
 * 「下面 N 条由要件表派生……」「还没立住的要件 N 条……」「基本盘缺 2 项：……」，
 * 以及本领域有要件卡、但本案登记的诉求恰好没有要件卡时（labor 的年假 / 加班费 / 年终奖
 * 都是这一类）退回去印的那份金额清单。整节计数 >0 就拒的形态是**初稿自己违规**，
 * 于是这道闸从上线第一天起就得关掉。所以基线取的是**服务端此刻会生成的那份初稿**里
 * 有几条这样的行：允许照抄、允许改写、允许删，**就是不许比它多**。
 * 复审 2026-09-10（第二轮）点名的两条绕路（空集里写无标记条目 / 插在第一条条目之前）
 * 落在 `extra` 这把尺上；第一轮点名的节末追加落在 `after` 上。
 *（这一处**与裁决第四条的字面不同**：字面是"整节计数 >0 即拒"。差别与上面这个理由
 * 一并报给经理裁，不在这里替他定；判据「初稿原样写回恒放行」钉的就是这个理由本身。）
 *
 * 【剩下的那道缝，记在这里】"删掉一行说明、同时插进一条自造条目"总数不变，
 * 若又落在第一条派生条目之前，两把尺都不响。堵死它要按行比对初稿，而按行比对
 * 与"允许把机械句式改写成人话"是直接冲突的——那会让这道闸天天误报、然后被关掉。
 *
 * @param content 本次要写入的正文
 * @param draft 服务端此刻按档案生成的这一节初稿（基线）
 */
function derivedBulletStrays(content: string, draft: string): { after: string[]; extra: string[] } {
  const first = firstMarkedBullet(content);
  const after =
    first < 0
      ? []
      : content.split('\n').slice(first + 1).filter(isUnmarkedBullet).map((l) => l.trim());
  const all = unmarkedBullets(content);
  const allowed = unmarkedBullets(draft).length;
  return { after, extra: all.length > allowed ? all : [] };
}

/** 一行争点的正文。**行首那个 `〔争点 id〕` 是派生标记**，改措辞可以，删掉它就对不上账了。 */
function issueLines(row: IssueRow): string[] {
  const anchors = row.anchors.length ? `｜依据 ${row.anchors.join('、')}` : '｜依据 待补';
  return [
    `- ${issueMarker(row.id)}${row.issue}（${row.claimKind}）：${row.status}${anchors}`,
    `  - 下一步：${row.nextStep}`,
  ];
}

/** 基本盘缺哪几项。事实卡首行的「基本盘缺 N 项」与报告的风险节共用这一份口径。 */
export function basicsMissing(c: caseStore.CaseRow): string[] {
  const out: string[] = [];
  if (!c.employed_from) out.push('起算日');
  if (c.monthly_wage_fen === null) out.push('月度金额基数');
  if (!c.position) out.push('岗位');
  if (!c.contract_count) out.push('合同签订次数');
  return out;
}

function loadInput(db: Database, caseRow: caseStore.CaseRow): ReportInput {
  return {
    caseRow,
    timeline: caseStore.listTimelineEvents(db, caseRow.id, 200),
    claims: agentStore.listClaims(db, caseRow.id),
    deadlines: caseStore.listDeadlines(db, caseRow.id, true),
    actions: caseStore.listActionItems(db, caseRow.id, null),
    evidence: caseStore.listEvidence(db, caseRow.id),
    companies: agentStore.listCompanyProfiles(db, caseRow.id),
  };
}

function specsFor(caseRow: caseStore.CaseRow): Result<{ specs: readonly ReportSectionSpec[] }> {
  const pack = getDomainPack(caseRow.domain);
  if (!pack) {
    return fail(
      500,
      'UNKNOWN_DOMAIN',
      `这个案件的领域是「${caseRow.domain}」，但 lib/domains 里没有对应的领域包，` +
        '所以取不到报告的分节骨架。请核对 cases.domain 的取值，或补上这个领域包再试。',
    );
  }
  return { ok: true, specs: pack.reportSections };
}

// ========== 渲染 ==========

/**
 * 渲染稿。网页档案页只读它一列，所以这里生成的东西必须是**能独立看懂的一整份**：
 * 标题按领域包的顺序，缺的那节也照样出标题（写「档案里还没有这一项」）——
 * 少一节与"这案子没有这回事"在页面上长得一模一样。
 */
export function renderMarkdown(
  specs: readonly ReportSectionSpec[],
  sections: ReportSections,
  meta: { title: string },
): string {
  const blocks = [`# ${meta.title}`];
  for (const spec of specs) {
    const body = sections[spec.title]?.trim();
    blocks.push(`## ${spec.title}\n\n${body || NONE}`);
  }
  return blocks.join('\n\n');
}

// ========== 读写入口 ==========

function writeReport(
  db: Database,
  caseId: number,
  next: { sections: ReportSections; rendered: string; version: number; updatedBy: string },
): void {
  db.prepare(
    `INSERT INTO case_reports (case_id, sections_json, rendered_md, version, updated_at, updated_by, stale_since, stale_reason)
     VALUES (?, ?, ?, ?, datetime('now'), ?, NULL, NULL)
     ON CONFLICT(case_id) DO UPDATE SET
       sections_json = excluded.sections_json,
       rendered_md   = excluded.rendered_md,
       version       = excluded.version,
       updated_at    = excluded.updated_at,
       updated_by    = excluded.updated_by,
       stale_since   = NULL,
       stale_reason  = NULL`,
  ).run(caseId, JSON.stringify(next.sections), next.rendered, next.version, next.updatedBy);
}

/**
 * 从档案生成初稿，落库，作者记 system。**只在没有初稿时调**（version=0 或没有行）：
 * 覆盖一份已经有人改过的报告，会把 agent 与用户整理出来的判断全部换成机器复述。
 *
 * 生成即清过期：初稿吃的是**此刻**的档案，之前攒下的那几条变动已经在里面了。
 */
export function bootstrapReport(
  db: Database,
  caseId: number,
  now: Date = new Date(),
): Result<{ row: CaseReportRow }> {
  const caseRow = caseStore.findCaseById(db, caseId);
  if (!caseRow) return NOT_FOUND();
  const spec = specsFor(caseRow);
  if (spec.ok !== true) return spec;

  const input = loadInput(db, caseRow);
  const sections: ReportSections = {};
  const pack = getDomainPack(caseRow.domain)!; // specsFor 已经拦过取不到包的情况
  for (const s of spec.specs) sections[s.title] = draftSection(s.source, input, now, pack);

  writeReport(db, caseId, {
    sections,
    rendered: renderMarkdown(spec.specs, sections, { title: caseRow.title }),
    version: 1,
    updatedBy: 'system',
  });
  return { ok: true, row: findReportRow(db, caseId)! };
}

export interface ReportView {
  case_id: number;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  sections: ReportSections;
  section_order: string[];
  rendered_md: string;
  stale: ReportStaleState;
}

function view(row: CaseReportRow, specs: readonly ReportSectionSpec[], now: Date): ReportView {
  return {
    case_id: row.case_id,
    version: row.version,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    sections: parseSections(row.sections_json),
    section_order: specs.map((s) => s.title),
    rendered_md: row.rendered_md,
    stale: reportStaleState(row, now),
  };
}

/**
 * 取报告。没有初稿就**当场生成**（惰性 bootstrap），所以这条路永远回得出一份东西。
 * @param section 只要某一节时传它的标题；不在骨架里的标题回 REPORT_SECTION_NOT_FOUND。
 */
export function getReport(
  db: Database,
  input: { caseId: number; userId: number; section?: string | null; now?: Date },
): Result<{ report: ReportView; section?: { title: string; content: string } }> {
  const now = input.now ?? new Date();
  const caseRow = caseStore.findCaseById(db, input.caseId);
  if (!caseRow || caseRow.user_id !== input.userId) return NOT_FOUND();
  const spec = specsFor(caseRow);
  if (spec.ok !== true) return spec;

  let row = findReportRow(db, input.caseId);
  if (!row || row.version === 0) {
    const done = bootstrapReport(db, input.caseId, now);
    if (done.ok !== true) return done;
    row = done.row;
  }

  const report = view(row, spec.specs, now);
  const wanted = input.section?.trim();
  if (!wanted) return { ok: true, report };
  if (!report.section_order.includes(wanted)) {
    return fail(
      404,
      'REPORT_SECTION_NOT_FOUND',
      `报告里没有「${wanted}」这一节。本案报告的分节是：${report.section_order.join(' / ')}。` +
        '分节骨架是固定的，想加一节要先改领域包，不能靠写入一个新标题凭空长出来。',
    );
  }
  return { ok: true, report, section: { title: wanted, content: report.sections[wanted] ?? '' } };
}

/**
 * 改一节。**乐观锁**：base_version 必须等于当前 version，否则 409 REPORT_VERSION_CONFLICT。
 *
 * 【为什么必须有这把锁】两个 agent（或一个 agent 加一个网页）同时整理同一份报告时，
 * 后写的那次会把先写的那次整节盖掉——两边都返回 200，用户永远不知道自己丢了一段。
 * 有锁的话后到的那次拿到 409，读回最新版再改。
 *
 * 【变更日志自动追加】谁、什么时候、改了哪一节、为什么。这一行由服务端写，
 * 不交给调用方"顺手也更新一下变更日志"——顺手的事忘一次就断一次，
 * 而断掉的日志与"这段时间没人改过"在外部同形。
 */
export function updateSection(
  db: Database,
  input: {
    caseId: number;
    userId: number;
    section: string;
    content: string;
    reason: string;
    baseVersion: number;
    updatedBy: string;
    now?: Date;
  },
): Result<{ report: ReportView }> {
  const now = input.now ?? new Date();
  const caseRow = caseStore.findCaseById(db, input.caseId);
  if (!caseRow || caseRow.user_id !== input.userId) return NOT_FOUND();
  const spec = specsFor(caseRow);
  if (spec.ok !== true) return spec;

  const title = input.section?.trim();
  if (!title) return fail(400, 'INVALID_SECTION', 'section 不能为空，要写报告里那一节的标题。');
  const changelogSpec = spec.specs.find((s) => s.source === 'changelog');
  if (!spec.specs.some((s) => s.title === title)) {
    return fail(
      404,
      'REPORT_SECTION_NOT_FOUND',
      `报告里没有「${title}」这一节。本案报告的分节是：${spec.specs.map((s) => s.title).join(' / ')}。`,
    );
  }
  if (changelogSpec && title === changelogSpec.title) {
    return fail(
      400,
      'REPORT_SECTION_READONLY',
      `「${title}」由服务端只追加地维护，不接受直接改写——` +
        '每次改别的节时它会自动多一行。要记一件事，就把它写进它该在的那一节。',
    );
  }
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (!content) {
    return fail(
      400,
      'INVALID_CONTENT',
      'content 不能为空。要清空一节请写清楚"这一节目前没有内容"以及为什么，' +
        '空字符串在页面上与"还没生成"长得一模一样。',
    );
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) {
    return fail(400, 'INVALID_REASON', 'reason 不能为空：变更日志要记下这一改是为什么。');
  }
  if (!Number.isInteger(input.baseVersion)) {
    return fail(
      400,
      'INVALID_BASE_VERSION',
      'base_version 必须是整数——先 case_report_get 拿到当前 version，再拿它来改。',
    );
  }

  // 没有初稿就先生成：拿一份不存在的报告去比版本号，只会得到"版本 0 对不上"这种没用的错。
  let row = findReportRow(db, input.caseId);
  if (!row || row.version === 0) {
    const done = bootstrapReport(db, input.caseId, now);
    if (done.ok !== true) return done;
    row = done.row;
  }

  if (row.version !== input.baseVersion) {
    return fail(
      409,
      'REPORT_VERSION_CONFLICT',
      `这份报告已经是第 ${row.version} 版，而你是照第 ${input.baseVersion} 版改的，本次没有写入。` +
        '原因是中间有人（另一个 agent、或用户在网页上）改过它，直接覆盖会把那次改动整节抹掉。' +
        '请先 case_report_get 读回最新版，把你的改动合到它上面，再用新的 version 重试。',
    );
  }

  const sections = parseSections(row.sections_json);

  // 【派生集只许改措辞，不许增删条目】（设计稿 §4.3-3 / §1.2「争点回声」）
  // 争点表是从要件表机械派生的：多一条 = 发明争点，少一条 = 漏答。
  // 判定落在**不随措辞变**的 `〔争点 id〕` 标记上（不是比对整段文本）——
  // 比文本的形态是：模型把机械句式写成人话就被判成"改了条目"，于是这道闸要么天天误报、
  // 要么被关掉。要让某条争点消失，去改档案（补一份证据、登记一条诉求），报告会跟着重生成。
  // 【为什么"本领域有要件卡"也要开闸，而不是只看已存内容里有没有标记】
  // 派生集**可以是空的**：本案要件全部成立那一段，这一节写的是「全部成立，派生不出争点」。
  // 只在 before.size>0 时开闸的形态是——正是那一段，模型可以任意写入三条自造争点
  //（哪怕带着伪标记），回包 200 落库。空集不是"这道闸不适用"，它是**一个要对齐的集合**。
  const sectionSpec = spec.specs.find((s) => s.title === title);
  const pack = getDomainPack(caseRow.domain)!; // specsFor 已经拦过取不到包的情况
  const derivedSection =
    sectionSpec !== undefined &&
    DERIVED_SOURCES.includes(sectionSpec.source) &&
    (pack.elementCards?.length ?? 0) > 0;

  const before = issueMarkersIn(sections[title] ?? '');
  if (before.size > 0 || derivedSection) {
    const after = issueMarkersIn(content);
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));
    if (added.length || removed.length) {
      return fail(
        400,
        'REPORT_SECTION_DERIVED',
        `「${title}」的条目是服务端从要件表派生的，本次没有写入。` +
          (added.length ? `多出来的条目：${added.map(issueMarker).join('、')}（凭空多一条争点＝发明争点）。` : '') +
          (removed.length ? `被删掉的条目：${removed.map(issueMarker).join('、')}（少一条＝漏答）。` : '') +
          (before.size === 0
            ? '本案这一节此刻**一条派生争点都没有**（要件全部成立，或还没登记诉求），所以它只能是空集。'
            : '') +
          '这一节允许你把机械句式改写成人话——把每个 〔争点 …〕 标记原样留在它那一条的行首即可；' +
          '要让某一条真的消失或新增，去改档案（补证据、登记诉求、记一条对方的书面决定），这一节会跟着重生成。',
      );
    }
  }
  // 【标记对上了还不算完】增删条目那把尺只比标记集合，比不出**不带标记的新条目**：
  // 在有标记的节末追加一条「- 另外公司还涉嫌…」，标记集合一个字没变，而页面上多了一条争点。
  // 两把尺见 derivedBulletStrays：节末追加（after）与"比初稿多"（extra）。
  if (derivedSection) {
    const draft = draftSection(sectionSpec.source, loadInput(db, caseRow), now, pack);
    const stray = derivedBulletStrays(content, draft);
    const hit = stray.after.length ? stray.after : stray.extra;
    if (hit.length) {
      const where = stray.after.length
        ? '这几条落在第一条派生条目之后'
        : '这一节顶格、不带标记的条目比服务端初稿里的还多';
      return fail(
        400,
        'REPORT_SECTION_DERIVED',
        `「${title}」的条目区里多了不带 〔争点 …〕 标记的条目，本次没有写入：` +
          `${hit.slice(0, 3).map((s) => `「${s.slice(0, 40)}」`).join('、')}（共 ${hit.length} 条）。` +
          `缺什么：${where}，而它们没有派生出处。为什么缺：这一节的条目由服务端从要件表派生，` +
          '不带标记的条目说不出它是被哪条规则捞进来的——那就是发明争点。' +
          '怎么办：要补一句说明，就写成正文（不要顶格 `- `）或缩进成某一条自己的子行（`  - …`）；' +
          '要真的多一条争点，去改档案（补证据、登记诉求、记一条对方的书面决定），这一节会跟着重生成。',
      );
    }
  }

  sections[title] = content;
  if (changelogSpec) {
    const line = `- ${dateOnly(now.toISOString())}　${input.updatedBy}：更新「${title}」——${reason}`;
    const prev = sections[changelogSpec.title]?.trim();
    sections[changelogSpec.title] = prev ? `${prev}\n${line}` : line;
  }

  writeReport(db, input.caseId, {
    sections,
    rendered: renderMarkdown(spec.specs, sections, { title: caseRow.title }),
    version: row.version + 1,
    updatedBy: input.updatedBy,
  });
  return { ok: true, report: view(findReportRow(db, input.caseId)!, spec.specs, now) };
}
