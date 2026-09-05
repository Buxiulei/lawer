// app/src/lib/capabilities/families/actions-write.ts
// G 族的写侧（设计稿 §2 G）。读侧与 action_complete 在 families/actions.ts。
// 另起文件的理由同 deadlines-write.ts：并行窗口不动别人在跑的族文件。
import * as agent from '@/lib/agent';
import * as cases from '@/lib/cases';
import * as store from '@/lib/db/agent';

import { withClientRef } from '../idempotent';
import { caseIdProp, num } from '../shared';
import type { Capability } from '../registry';

interface ActionInput {
  what: string;
  how: string;
  why: string;
  dueAt: string | null;
  priority: number;
}

/** ISO8601 校验；合法则回 ISO 串（落库格式的归一交给 SQL 的 datetime()，ADR-002） */
function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export const actionCreate: Capability = {
  name: 'action_create',
  family: 'actions',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { clientRef: true, naturalKey: '同案 + 待办中标题去掉标点空白后相等' },
  title: '新建行动卡',
  description:
    `给案件加行动卡，一次最多 ${agent.MAX_ACTION_CARDS} 张。超过这个数就不是「现在做什么」，` +
    '是又一份待办清单——用户看完照样不知道先干哪件。每张必须齐三样：' +
    'what（做什么）、how（怎么做）、why（为什么），外加 due_at（什么时候之前做完，ISO8601 时刻；' +
    '「今天下班前」也要换算成具体时刻）。同案下已有同题待办不会重复落库，回 created:false。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      items: {
        type: 'array',
        description: `要新建的行动卡，1~${agent.MAX_ACTION_CARDS} 张`,
        items: {
          type: 'object',
          properties: {
            what: { type: 'string', description: '做什么，一句话' },
            how: { type: 'string', description: '怎么做，具体到可以照着执行' },
            why: { type: 'string', description: '为什么现在要做这件事' },
            due_at: { type: 'string', description: '什么时候之前做完，ISO8601 时刻' },
            priority: { type: 'integer', description: '越大越急，默认 0' },
          },
          required: ['what', 'how', 'why', 'due_at'],
        },
      },
      client_ref: {
        type: 'string',
        description: '幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库',
      },
    },
    required: ['case_id', 'items'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    const owned = cases.getCase(db, { caseId, userId: identity.uid, timelineLimit: 1 });
    if (!owned.ok) return owned;

    const raw = Array.isArray(args.items) ? args.items : [];
    if (raw.length === 0) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'NO_ITEMS',
        message: 'items 至少要有一张行动卡，每张含 what / how / why / due_at。',
      };
    }
    // 【上限在这里挡，不在说明里劝】超出的部分不是"截掉多余的"而是整笔拒收：
    // 截掉的形态是调用方以为三张都记上了，其实第三张不在档案里，而返回 200。
    if (raw.length > agent.MAX_ACTION_CARDS) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'TOO_MANY_ACTIONS',
        message:
          `一次最多 ${agent.MAX_ACTION_CARDS} 张，这次给了 ${raw.length} 张，一张都没有写进档案。` +
          '请自己取舍出最急的几件再调一次，把不急的留到下次——' +
          '这里不替你截断，截断的话你会以为全都记上了。',
      };
    }

    const items: ActionInput[] = [];
    for (const [i, entry] of raw.entries()) {
      const it = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
      const pick = (k: string): string | null =>
        typeof it[k] === 'string' && (it[k] as string).trim() ? (it[k] as string).trim() : null;
      const what = pick('what');
      const how = pick('how');
      const why = pick('why');
      if (!what || !how || !why) {
        return {
          ok: false as const,
          status: 400,
          errorCode: 'INVALID_ACTION',
          message: `第 ${i + 1} 张行动卡缺 what / how / why 中的某项，三样都不能为空；本次一张都没有写进档案。`,
        };
      }
      const dueAt = isoOrNull(it.due_at);
      if (!dueAt) {
        return {
          ok: false as const,
          status: 400,
          errorCode: 'INVALID_DUE_AT',
          message: `第 ${i + 1} 张行动卡的 due_at 不是合法 ISO8601 时刻。「今天下班前」也要换算成具体时刻；本次一张都没有写进档案。`,
        };
      }
      items.push({
        what,
        how,
        why,
        dueAt,
        priority: Number.isInteger(Number(it.priority)) ? Number(it.priority) : 0,
      });
    }

    // 【一次调用一行台账】withClientRef 的 target 只能记一行，这里记的是**这一批的第一张**。
    // 重放时不再执行插入，回的也是那一张——要看这次到底落了哪几张，调 action_list。
    let results: { id: number; created: boolean; title: string }[] = [];
    const done = withClientRef(
      db,
      { caseId, tool: 'action_create', clientRef: args.client_ref, keyId: identity.keyId ?? null },
      () => {
        results = items.map((it) => {
          const row = store.insertActionItem(db, {
            caseId,
            title: it.what,
            detail: `怎么做：${it.how}\n为什么：${it.why}`,
            dueAt: it.dueAt,
            priority: it.priority,
            sourceMessageId: null,
          });
          return { id: row.id, created: row.created, title: it.what };
        });
        return { table: 'action_items', id: results[0].id };
      },
    );
    return done.deduped
      ? {
          ok: true as const,
          deduped: true,
          action_id: done.target.id,
          note:
            '这个 client_ref 之前已经提交过一次，本次没有重复落库。' +
            '要看这个案子当前有哪些待办，调 action_list。',
        }
      : { ok: true as const, deduped: false, actions: results };
  },
};
