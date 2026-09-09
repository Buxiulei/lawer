// app/src/lib/capabilities/families/elements.ts
// 要件族（设计稿 §4.4-6）：读要件表、读争点表、把用户这一轮的话填进某个要件。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量（守卫扫整个 lib/capabilities/）。带领域措辞的对外文案
// 放在 lib/domains/<key>.ts 的 capabilities 一节，由这里引用。
// ─────────────────────────────────────────────────────
import * as cases from '@/lib/cases';
import { buildElementSheet, resolveSlot, type ElementFactsView } from '@/lib/cases/elements';
import { buildIssueTable } from '@/lib/cases/issue-table';
import { SOURCE_TIERS, normalizeSourceTier } from '@/lib/cases/source-tier';
import * as store from '@/lib/db/agent';
import * as caseStore from '@/lib/db/cases';
import { listElementFills, recordElementFill } from '@/lib/db/elements';
import { DOMAINS, type DomainPack } from '@/lib/domains/registry';
import { LABOR_CAPABILITY_COPY } from '@/lib/domains/labor';

import { assertedByOf, caseIdProp, num, sourceTierProp } from '../shared';
import type { Capability } from '../registry';

/** 归属校验 + 取领域包，三条能力共用的那一段。 */
type Ctx = { pack: DomainPack; caseRow: caseStore.CaseRow };
type Fail = { ok: false; status: number; errorCode: string; message: string };

function fail(status: number, errorCode: string, message: string): Fail {
  return { ok: false, status, errorCode, message };
}

function contextOf(db: Parameters<Capability['run']>[0], uid: number, caseId: number): Ctx | Fail {
  const owned = cases.getCase(db, { caseId, userId: uid, timelineLimit: 1 });
  if (!owned.ok) return owned as unknown as Fail;
  const pack = DOMAINS[owned.case.domain];
  if (!pack) {
    return fail(
      500,
      'UNKNOWN_DOMAIN',
      `这个案件的领域是「${owned.case.domain}」，但没有对应的领域包，取不到要件卡。`,
    );
  }
  const caseRow = caseStore.findCaseById(db, caseId)!;
  return { pack, caseRow };
}

/**
 * 档案的结构化子集 + 要件表。
 *
 * 【为什么不复用 CaseSnapshot】快照的时间线是**开过窗**的（最近 30 条）。要件推导按窗口内的
 * 事实算，窗口外那条带书证的老事件就凭空消失了——状态从「成立」变成「缺失」，
 * 而回包 200、每一行读起来都正常。这里按整案取数（listTimelineEvents 给足上限）。
 */
function sheetOf(db: Parameters<Capability['run']>[0], ctx: Ctx, caseId: number) {
  const claims = store.listClaims(db, caseId);
  const facts: ElementFactsView = {
    case: {
      employed_from: ctx.caseRow.employed_from,
      position: ctx.caseRow.position,
      monthly_wage_fen: ctx.caseRow.monthly_wage_fen,
      contract_count: ctx.caseRow.contract_count,
    },
    claims,
    // 200 = lib/cases 那侧取整案时间线用的同一个上限（那个常量没有导出，这里写同值并说明；
    // 取小的形态是：窗口外那条带书证的老事件凭空消失，要件从「成立」变成「缺失」而不报错）。
    timeline: caseStore.listTimelineEvents(db, caseId, 200),
    companies: store.listCompanyProfiles(db, caseId),
    evidence: caseStore.listEvidence(db, caseId),
  };
  const kinds = [...new Set(claims.map((c) => c.kind))];
  return { facts, kinds, sheet: buildElementSheet(facts, ctx.pack.elementCards ?? [], kinds) };
}

/**
 * 对方那份书面决定在不在档。槽位由领域包声明（`counterpartyDecisionSlot`）——
 * 共用层不认识它在某个行当里叫什么名字。声明省略 ⇒ 恒 false，争点表规则三整条不生效。
 */
function decisionOnFile(pack: DomainPack, facts: ElementFactsView): boolean {
  const slot = pack.counterpartyDecisionSlot;
  if (!slot) return false;
  return resolveSlot(slot, facts) != null;
}

export const elementSheetGet: Capability = {
  name: 'element_sheet_get',
  family: 'elements',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/elements' },
  title: '读要件表',
  description: LABOR_CAPABILITY_COPY.elementSheetGetDescription,
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      claim_kind: { type: 'string', description: '只看这一项诉求的要件；不传即看已登记的全部诉求' },
    },
    required: ['case_id'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    const ctx = contextOf(db, identity.uid, caseId);
    if ('ok' in ctx) return ctx;
    const { sheet, kinds } = sheetOf(db, ctx, caseId);
    const want = typeof args.claim_kind === 'string' ? args.claim_kind.trim() : '';
    const rows = want ? sheet.rows.filter((r) => r.claimKind === want) : sheet.rows;
    const fills = listElementFills(db, caseId);
    return {
      ok: true as const,
      rendered: sheet.rendered,
      claim_kinds: kinds,
      burden_labels: ctx.pack.burdenLabels ?? null,
      rows: rows.map((r) => ({
        ...r,
        burden_label: ctx.pack.burdenLabels?.[r.burden] ?? null,
        // 哪几行事实是**为了这个要件**写进来的（element_fill 的留痕）。
        // 空数组不代表这个要件没有支撑：状态是从事实槽推出来的，与有没有留痕无关。
        filled_by: fills
          .filter((f) => f.element_id === r.id)
          .map((f) => ({ table: f.target_table, id: f.target_id, slot: f.slot })),
      })),
      note:
        '状态由档案里那几条事实的来源档位程序推出，不是这一轮的判断。' +
        '「缺失」= 档案里没有这一项（〔未记录〕），**不是**「不满足」，更不是「这项诉求提不了」——' +
        '这几行只允许说需补什么（每行的 typicalEvidence 就是那句话）。' +
        'burden=unverified 表示这一项的条号还没核实，先别按任何一边准备。',
    };
  },
};

export const issueList: Capability = {
  name: 'issue_list',
  family: 'elements',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/issues' },
  title: '读争点表',
  description: LABOR_CAPABILITY_COPY.issueListDescription,
  inputSchema: {
    type: 'object',
    properties: { ...caseIdProp },
    required: ['case_id'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    const ctx = contextOf(db, identity.uid, caseId);
    if ('ok' in ctx) return ctx;
    const { sheet, facts } = sheetOf(db, ctx, caseId);
    const table = buildIssueTable(
      sheet.rows,
      { counterpartyDecisionOnFile: decisionOnFile(ctx.pack, facts) },
      sheet.rendered,
    );
    return {
      ok: true as const,
      rendered: table.rendered,
      issues: table.rows,
      note:
        '这是**本轮可以谈的全部争点**：正文里提到的争点必须是它的子集——多出来的是发明争点，' +
        '少了的是漏答。每条都带 nextStep（追问或行动卡的题目），不要只报争点不给下一步。' +
        '要让某条争点消失，去改档案（补一份材料、登记一条诉求），不要在正文里把它说没。',
    };
  },
};

/** `<表>:<取值>` 拆开。返回 null = 这个串根本不是一个槽位地址。 */
function splitSlot(slot: string): { source: string; value: string } | null {
  const at = slot.indexOf(':');
  if (at <= 0) return null;
  const value = slot.slice(at + 1).trim();
  if (!value) return null;
  return { source: slot.slice(0, at), value };
}

export const elementFill: Capability = {
  name: 'element_fill',
  family: 'elements',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  // 【不挂 facts_token】它是追加型写入（记一条事实 / 登记一条诉求项），与 timeline_add 同理：
  // 挂上去的形态是——要记一笔就得先读一遍事实卡，于是模型干脆不记，
  // 而"不落库"正是这套档案最早的那类事故（设计稿 §4.2-4）。
  precondition: [],
  idempotency: {
    clientRef: false,
    naturalKey: '同案 + 同要件 + 同一行事实只留一条留痕；事实本身的去重沿用它那张表的自然键',
  },
  title: '把这一轮的话填进某个要件',
  description: LABOR_CAPABILITY_COPY.elementFillDescription,
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      element_id: { type: 'string', description: '要件 id，取自 element_sheet_get 的 rows[].id' },
      slot: {
        type: 'string',
        description:
          '填哪一个事实槽，`<表>:<取值>` 形态，**必须是该要件 satisfiedBy 里列着的那几个之一**' +
          '（element_sheet_get 的 rows[].missingSlots 就是还空着的那几个）。' +
          '**可以不填**：不填就是"把用户就这个要件说的这句话记下来"——落一条时间线事件挂在该要件名下，' +
          '要件的状态**不会**因此改变（状态只看那几个槽），回包会把还缺的槽与该补的材料列给你。',
      },
      timeline_kind: {
        type: 'string',
        enum: [...cases.TIMELINE_KINDS],
        description: '落时间线时这条事件算哪一类；不填 slot 时必填',
      },
      happened_at: { type: 'string', description: '这件事发生在什么时候，ISO8601；凡是落时间线都必填' },
      title: { type: 'string', description: '一句话概括用户说的这件事（照他的说法写，不要替他下结论）' },
      detail: { type: 'string', description: '细节补充，可省略' },
      ...sourceTierProp(
        '不传即落最弱档：用户随口说的一句话就是最弱档。' +
          '**只有真的看见了材料才往上报档**——把一句自述标成有材料支撑，' +
          '会让这个要件在要件表上从「待证」跳成「成立」，而庭上没有那份材料。',
      ),
    },
    required: ['case_id', 'element_id'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    const ctx = contextOf(db, identity.uid, caseId);
    if ('ok' in ctx) return ctx;

    const cards = ctx.pack.elementCards ?? [];
    if (cards.length === 0) {
      return fail(
        400,
        'NO_ELEMENT_CARDS',
        '这个案件所属的领域还没有要件卡，所以填不进任何要件。' +
          '缺的是领域包里的 elementCards——在它补上之前，' +
          '把用户说的事按原样记进时间线（timeline_add）即可，那条路一直是通的。',
      );
    }
    const elementId = typeof args.element_id === 'string' ? args.element_id.trim() : '';
    const card = cards.find((c) => c.id === elementId);
    if (!card) {
      return fail(
        404,
        'ELEMENT_NOT_FOUND',
        `没有 id 为「${elementId}」的要件。本案可填的要件先用 element_sheet_get 读一遍，` +
          '那份回包里的 rows[].id 就是这里要填的值——不要按要件名去猜 id。',
      );
    }
    const tier0 = normalizeSourceTier(args.source_tier ?? '自述');
    if (!tier0) {
      return fail(
        400,
        'INVALID_SOURCE_TIER',
        `source_tier 只能是 ${SOURCE_TIERS.join(' / ')}；没有把握就整个不传（落最弱档）。`,
      );
    }

    const slot = typeof args.slot === 'string' ? args.slot.trim() : '';

    // ── 不点名槽位：把用户就这个要件说的话记下来，**明说它不改变状态** ──
    // 【为什么留这条路】四诉求的要件里有好几个只认"一份材料"（解除通知、工资流水）——
    // 一句话再准确也变不成那份材料。没有这条路的形态是：模型想记下用户刚说的关键一句，
    // 发现每个槽都填不了，于是要么不记（"不落库"是这套档案最早的那类事故），
    // 要么挑一个填得进去的槽硬填（把一句自述写成一份材料）。
    if (!slot) {
      const kind = typeof args.timeline_kind === 'string' ? args.timeline_kind.trim() : '';
      if (!kind) {
        return fail(
          400,
          'MISSING_TIMELINE_KIND',
          '不点名 slot 时要给 timeline_kind：这句话会落成一条时间线事件，得先说清它算哪一类。' +
            `可选：${cases.TIMELINE_KINDS.join(' / ')}。` +
            `想直接填某个事实槽的，slot 只能是这几个之一：${card.satisfiedBy.join(' / ')}。`,
        );
      }
      const done = cases.addTimelineEvent(db, {
        caseId,
        userId: identity.uid,
        happenedAt: args.happened_at,
        kind,
        title: args.title,
        detail: args.detail,
        sourceTier: tier0,
        assertedBy: assertedByOf(identity),
      });
      if (!done.ok) return done;
      recordElementFill(db, {
        caseId,
        elementId: card.id,
        slot: '',
        targetTable: 'timeline_events',
        targetId: done.event.id,
      });
      const { sheet } = sheetOf(db, ctx, caseId);
      const row = sheet.rows.find((r) => r.id === card.id);
      return {
        ok: true as const,
        element_id: card.id,
        slot: null,
        wrote: { table: 'timeline_events', id: done.event.id },
        deduped: done.deduped,
        element_status: row?.status ?? null,
        still_missing: row?.missingSlots ?? card.satisfiedBy,
        typical_evidence: card.typicalEvidence,
        note:
          '这句话已经记进时间线并挂在这个要件名下。**它不会改变这个要件的状态**——' +
          '状态只看 satisfiedBy 那几个槽在不在档。还缺的槽见 still_missing，' +
          '要补的材料见 typical_evidence：把这两样如实告诉用户，不要说成"这一项已经解决了"。',
      };
    }

    if (!card.satisfiedBy.includes(slot)) {
      return fail(
        400,
        'SLOT_NOT_IN_ELEMENT',
        `槽位「${slot}」不属于要件「${card.name}」。它认的槽位是：${card.satisfiedBy.join(' / ')}。` +
          '填一个不属于它的槽，那条事实会落进档案却不影响这个要件的状态——' +
          '回包 200、档案里多一行，而要件表一格都不变。',
      );
    }
    const parts = splitSlot(slot);
    if (!parts) return fail(400, 'INVALID_SLOT', `槽位「${slot}」不是 <表>:<取值> 形态。`);

    const tier = tier0;

    // ── 时间线槽：一句话 → 一条事件 ──
    if (parts.source === 'timeline') {
      const done = cases.addTimelineEvent(db, {
        caseId,
        userId: identity.uid,
        happenedAt: args.happened_at,
        kind: parts.value,
        title: args.title,
        detail: args.detail,
        sourceTier: tier,
        assertedBy: assertedByOf(identity),
      });
      if (!done.ok) return done;
      recordElementFill(db, {
        caseId,
        elementId: card.id,
        slot,
        targetTable: 'timeline_events',
        targetId: done.event.id,
      });
      return { ok: true as const, element_id: card.id, slot, wrote: { table: 'timeline_events', id: done.event.id }, deduped: done.deduped };
    }

    // ── 诉求槽：登记这一项（金额一律 0，算钱只走 claim_calc）──
    if (parts.source === 'claim') {
      if (!ctx.pack.claimKinds.includes(parts.value)) {
        return fail(400, 'INVALID_KIND', `诉求种类只能是 ${ctx.pack.claimKinds.join(' / ')}`);
      }
      const existing = store.listClaims(db, caseId).find((c) => c.kind === parts.value);
      // 【已经有这一项就一个字节都不动它】覆盖的形态是：一笔算过的金额被这里的 0 抹平，
      // 回包 200，用户下次读档看到的是 0 元。要改金额去 claim_calc。
      let id = existing?.id ?? 0;
      let created = false;
      if (!existing) {
        const row = store.upsertClaim(db, {
          caseId,
          kind: parts.value,
          amountFen: 0,
          calcJson: null,
          basis: `要件 ${card.id}：${card.name}`,
          status: 'draft',
          origin: { tier, assertedBy: assertedByOf(identity) },
        });
        id = row.id;
        created = row.created;
      }
      recordElementFill(db, { caseId, elementId: card.id, slot, targetTable: 'claims', targetId: id });
      return {
        ok: true as const,
        element_id: card.id,
        slot,
        wrote: { table: 'claims', id },
        created,
        note: created
          ? '这一项已登记，金额是 0（待算）。要出金额请调 claim_calc，不要在别处填数。'
          : '这一项之前已经登记过，本次没有改动它的金额与依据，只记了"它支撑哪个要件"。',
      };
    }

    // ── 其余槽位：这条路写不了，但要说清该走哪条 ──
    return fail(
      400,
      'SLOT_NOT_FILLABLE_HERE',
      `槽位「${slot}」不能用这条能力填。` +
        `缺什么：${parts.source} 这张表上的事实不是"一句话"能落的。` +
        '为什么缺：basics 是首诊那几项（改它要改案件抬头）、company 是对方主体档案、' +
        'evidence 是一份真实存在的材料——把一句自述写成这三样里的任何一样，' +
        '都会让要件表把没有的东西显示成有。' +
        '怎么办：basics 走 case_update，company 走 company_profile_upsert，' +
        'evidence 走 evidence_upload_url + evidence_register（必须真有那份文件）。' +
        '现在就想留痕的，把用户这句话按原样记进时间线（timeline_add）。',
    );
  },
};
