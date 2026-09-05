// app/src/lib/capabilities/families/deadlines-write.ts
// F 族的写侧（设计稿 §2 F）。读侧（deadline_list）在 families/deadlines.ts。
//
// 【为什么另起一个文件而不是并进 deadlines.ts】P1 几路窗口并行，各写各的能力；
// 谁都不动别人已经在跑的族文件，合并时就只在 families/index.ts 那一处碰头。
// 代价是同一族有两个文件，读的时候要一起看——这条写在这里，免得下一个人以为漏了。
import * as cases from '@/lib/cases';
import * as deadline from '@/lib/deadline';
import * as store from '@/lib/db/agent';
import { DOMAINS } from '@/lib/domains/registry';

import { withClientRef } from '../idempotent';
import { caseIdProp, num } from '../shared';
import type { Capability } from '../registry';

/** 对外枚举：各领域包 deadlineKinds 的并集（tools/list 拿不到案件上下文）。
 *  真正落库前按该案件所属领域的词表再校验一次。 */
const ALL_DEADLINE_KINDS = [
  ...new Set(Object.values(DOMAINS).flatMap((p) => p.deadlineKinds)),
];

/** kind（落库值）→ 推算规则。规则表按 storedKind 反查，不在这里抄第二份对照表。 */
function ruleForKind(kind: string): deadline.DeadlineRule | undefined {
  return Object.values(deadline.DEADLINE_RULES).find((r) => r.storedKind === kind);
}

/** 有推算规则的那些 kind——没有规则的种类算不出到期日，报错时要把这份名单给出来 */
function computableKinds(kinds: readonly string[]): string[] {
  return kinds.filter((k) => ruleForKind(k) !== undefined);
}

export const deadlineSet: Capability = {
  name: 'deadline_set',
  family: 'deadlines',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { clientRef: true, naturalKey: '同案 + 同 kind + 同锚点日（到期日由前两者唯一决定）' },
  title: '推算并登记一条法定期限',
  description:
    '给一个锚点日期（收到某份文书的日子、解除的日子……），服务端**按规则推算**到期日并登记。' +
    '日期不由你算：返回里带 derived_from（一步步的推算过程）与 basis（条号与逐字原文），' +
    '把到期日、推算依据和全部 caveats（尤其「未含法定节假日顺延」）一起讲给用户，别只报一个日子。' +
    '天数由办案机构在通知书上指定的那类期限必须传 days——缺了会明确告诉你缺哪一项。' +
    '同案同 kind 同锚点重复调用不会多出一条。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      kind: { type: 'string', enum: ALL_DEADLINE_KINDS, description: '期限种类' },
      anchor_date: { type: 'string', description: '起算锚点，YYYY-MM-DD（如文书签收日、解除日）' },
      days: {
        type: 'integer',
        description: '天数由办案机构指定的期限才要传，照通知书上写的填，不要猜',
      },
      client_ref: {
        type: 'string',
        description: '幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库',
      },
    },
    required: ['case_id', 'kind', 'anchor_date'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    const owned = cases.getCase(db, { caseId, userId: identity.uid, timelineLimit: 1 });
    if (!owned.ok) return owned;

    const pack = DOMAINS[owned.case.domain];
    if (!pack) {
      return {
        ok: false as const,
        status: 500,
        errorCode: 'UNKNOWN_DOMAIN',
        message: `这个案件的领域是「${owned.case.domain}」，但没有对应的领域包，取不到期限种类词表。`,
      };
    }
    const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
    if (!pack.deadlineKinds.includes(kind)) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'INVALID_KIND',
        message: `kind 只能是 ${pack.deadlineKinds.join(' / ')}`,
      };
    }
    const rule = ruleForKind(kind);
    if (!rule) {
      // 三段式：缺什么 / 为什么缺 / 怎么办。裸报一句「不支持」会让调用方原样重试。
      return {
        ok: false as const,
        status: 400,
        errorCode: 'NO_DEADLINE_RULE',
        message:
          `「${kind}」目前没有推算规则，本工具算不出它的到期日。` +
          '原因是这一类期限的日子不是从锚点推出来的（由通知书或排期直接给定），' +
          `而本工具只登记推算得出的期限。可推算的种类：${computableKinds(pack.deadlineKinds).join(' / ')}。` +
          '这一条请改用时间线（timeline_add）如实记下那个日子。',
      };
    }
    if (rule.daysFromCaller && !Number.isInteger(Number(args.days))) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'DAYS_REQUIRED',
        message:
          `「${kind}」的天数不是法定固定值，由办案机构在通知书上指定，所以必须传 days（正整数）。` +
          '照通知书上写的那个数填，不要猜——猜错的后果是用户按一个不存在的期限安排举证。',
      };
    }

    let computed: deadline.DeadlineComputation;
    try {
      computed = deadline.computeDeadline(rule.key, String(args.anchor_date ?? ''), {
        days: Number(args.days),
      });
    } catch (e) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'INVALID_ANCHOR',
        message: e instanceof Error ? e.message : String(e),
      };
    }

    // 【同案 + 同 kind + 同锚点为什么落到 insertDeadline 的自然键上】到期日是
    // (kind, 锚点, days) 的确定函数，同锚点必然同到期日，故 (case, kind, 到期日) 命中即重放。
    let created = false;
    const done = withClientRef(
      db,
      { caseId, tool: 'deadline_set', clientRef: args.client_ref, keyId: identity.keyId ?? null },
      () => {
        const row = store.insertDeadline(db, {
          caseId,
          kind: computed.rule.storedKind,
          dueDate: computed.dueDate,
          derivedFrom: computed.derivedFrom,
        });
        created = row.created;
        return { table: 'deadlines', id: row.id };
      },
    );
    return {
      ok: true as const,
      deadline_id: done.target.id,
      created: done.deduped ? false : created,
      deduped: done.deduped || !created,
      due_date: computed.dueDate,
      label: computed.rule.label,
      derived_from: computed.derivedFrom,
      basis: computed.rule.basis,
      caveats: computed.caveats,
      note: '把到期日、推算依据与全部 caveats（尤其「未含法定节假日顺延」）一起讲给用户，别只报一个日子。',
    };
  },
};

export const deadlineResolve: Capability = {
  name: 'deadline_resolve',
  family: 'deadlines',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { clientRef: true, naturalKey: '已了结的再调不刷新时间戳（回 already_resolved）' },
  title: '把一条期限标记为已了结',
  description:
    '把一条期限标记为已履行/作废，停止提醒。**幂等**：已经标记过的再调不报错、也不刷新时间戳，' +
    '只回 already_resolved:true——「什么时候办完的」不该被后来的重复调用改掉。' +
    '不属于本案的 id 一律当作不存在。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      deadline_id: { type: 'integer', description: '期限 id（从 deadline_list 取）' },
      client_ref: {
        type: 'string',
        description: '幂等键，一次业务操作给一个稳定值',
      },
    },
    required: ['case_id', 'deadline_id'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    // 归属校验与取行走 lib/cases（同一批领域校验，不在这里重写一遍）
    const listed = cases.listDeadlines(db, { caseId, userId: identity.uid, includeResolved: true });
    if (!listed.ok) return listed;

    const deadlineId = num(args.deadline_id);
    const row = listed.deadlines.find((d) => d.id === deadlineId);
    // 不属于本案的期限按"不存在"处理，不泄漏它在别的案件下存在
    if (!row) {
      return {
        ok: false as const,
        status: 404,
        errorCode: 'DEADLINE_NOT_FOUND',
        message: `期限 #${deadlineId} 不存在或不属于本案。调 deadline_list 看这个案子有哪些期限。`,
      };
    }
    if (row.resolved_at) {
      return {
        ok: true as const,
        deadline_id: deadlineId,
        resolved: true,
        already_resolved: true,
        // 与其余写能力的重放回包同形：调用方统一按 deduped 判重放，不用再认第二个字段
        deduped: true as const,
        resolved_at: row.resolved_at,
      };
    }

    const done = withClientRef(
      db,
      { caseId, tool: 'deadline_resolve', clientRef: args.client_ref, keyId: identity.keyId ?? null },
      () => {
        store.resolveDeadline(db, caseId, deadlineId);
        return { table: 'deadlines', id: deadlineId };
      },
    );
    return {
      ok: true as const,
      deadline_id: deadlineId,
      resolved: true,
      already_resolved: false,
      deduped: done.deduped,
    };
  },
};
