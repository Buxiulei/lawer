// 金额 / 期限 / 行动 三组写能力的判据。
//
// 这三组是**唯一会把数字与日期写进档案**的入口，它们的失败形态都不报错：
// 归属校验漏一处 → 金额写进别人的案子，返回 200；幂等漏一处 → agent 重试一次，
// 用户档案里多一条；算钱抄第二份 → 网页里的数与用户自己 agent 算的数不一样。
// 所以下面每条都盯着「零写入」「只一行」「两处同源」这类**可数的**结论，
// 不盯返回文案。每条的变异臂写在用例名里：照着改一处，那一条必须红。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import * as agent from '@/lib/agent';
import { runMigrations } from '@/lib/db/migrate';
import type { Identity } from '@/lib/auth/identity';

import { getCapability } from '..';

const SRC_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..', '..');

let db: Database.Database;
let mine: number;
let theirs: number;
let me: Identity;

function count(table: string, where = '1=1'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

/** 调一条能力。run 的返回是「原样 JSON 化的领域结果」，失败形态是 ok:false + errorCode */
function call(name: string, args: Record<string, unknown>, identity: Identity = me) {
  const cap = getCapability(name);
  expect(cap, `注册表里没有 ${name}`).toBeDefined();
  return cap!.run(db, identity, args) as Record<string, unknown>;
}

/** 一组够算出 N 的入参（金额单位分） */
const N_INPUTS = {
  avg_monthly_wage_fen: 2_000_000,
  employed_from: '2020-03-01',
  terminated_at: '2026-03-01',
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uidA = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('a').lastInsertRowid);
  const uidB = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('b').lastInsertRowid);
  mine = Number(db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uidA, '我的').lastInsertRowid);
  theirs = Number(db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uidB, '别人的').lastInsertRowid);
  me = { uid: uidA, via: 'api_key', scopes: ['case:read', 'case:write'], keyId: undefined };
});

// ========== 归属：别人的案件一律 CASE_NOT_FOUND 且零写入 ==========

describe('六条能力：本人案件可调，他人案件 CASE_NOT_FOUND 且零写入', () => {
  /** name → 一组合法入参（case_id 由调用处填） */
  const CASES: [string, Record<string, unknown>][] = [
    ['claim_calc', { kind: 'N', inputs: N_INPUTS }],
    ['claims_upsert', { kind: '欠薪', amount_fen: 123_400 }],
    ['claims_list', {}],
    ['deadline_set', { kind: '起诉15日', anchor_date: '2026-03-02' }],
    ['deadline_resolve', { deadline_id: 1 }],
    [
      'action_create',
      { items: [{ what: '寄出异议函', how: '顺丰到付并留底', why: '固定送达证据', due_at: '2026-03-05T18:00:00+08:00' }] },
    ],
  ];

  it.each(CASES)('%s：本人案件调得动', (name, args) => {
    // deadline_resolve 需要本案先有一条期限
    if (name === 'deadline_resolve') {
      const set = call('deadline_set', { case_id: mine, kind: '起诉15日', anchor_date: '2026-03-02' });
      args = { deadline_id: set.deadline_id };
    }
    const out = call(name, { case_id: mine, ...args });
    expect(out.ok, JSON.stringify(out)).not.toBe(false);
  });

  it.each(CASES)(
    '%s：他人案件回 CASE_NOT_FOUND（变异：把 getCase 那道门去掉直接落库 → 红）',
    (name, args) => {
      const before = {
        claims: count('claims'),
        deadlines: count('deadlines'),
        actions: count('action_items'),
        writes: count('agent_writes'),
      };
      const out = call(name, { case_id: theirs, ...args });
      expect(out.ok).toBe(false);
      expect(out.errorCode).toBe('CASE_NOT_FOUND');
      // 「不是自己的」与「不存在」返回同一个错误，且**一行都不许落**
      expect({
        claims: count('claims'),
        deadlines: count('deadlines'),
        actions: count('action_items'),
        writes: count('agent_writes'),
      }).toEqual(before);
    },
  );
});

// ========== claim_calc 与站内 agent 同源 ==========

describe('claim_calc 与站内 agent 是同一份算钱逻辑', () => {
  const TOOLS_TS = path.join(SRC_ROOT, 'lib/agent/tools.ts');
  const CAP_TS = path.join(SRC_ROOT, 'lib/capabilities/families/claims.ts');

  it('两处都从 @/lib/cases/claims 引 runClaimCalc（变异：任一处改成本地实现 → 红）', () => {
    for (const file of [TOOLS_TS, CAP_TS]) {
      const text = fs.readFileSync(file, 'utf-8');
      expect(text, file).toMatch(/from '@\/lib\/cases\/claims'/);
      expect(text, file).toMatch(/runClaimCalc/);
    }
  });

  it('公式只在 lib/cases/claims 里被调用（变异：往任一入口抄一份 calcN → 红）', () => {
    // 抄第二份不会在同一天出错，它会在某次公式修订之后只改了一处。
    for (const file of [TOOLS_TS, CAP_TS]) {
      const text = fs.readFileSync(file, 'utf-8');
      expect(text, `${file} 里出现了直接调公式`).not.toMatch(/calc\.(calcN|calc2N|calcNPlus1)\(/);
    }
  });

  it('同一组入参：MCP 与站内算出同一个金额与同一条算式（变异：任一侧换公式 → 红）', () => {
    const viaMcp = call('claim_calc', { case_id: mine, kind: 'N', inputs: N_INPUTS });
    expect(viaMcp.ok).not.toBe(false);

    // 站内那条路：executeTool 走 HANDLERS.claim_calc，落到同一个 runClaimCalc
    const state = agent.newTurnState();
    const outcome = agent.executeTool(
      'claim_calc',
      JSON.stringify({ kind: 'N', ...N_INPUTS }),
      {
        db,
        caseId: mine,
        userId: me.uid,
        threadId: 0,
        sourceMessageId: null,
        searcher: agent.createKnowledgeSearcher(),
        citations: { known: () => true } as never,
        crisisCardAlreadyGiven: false,
        state,
        emit: () => {},
      },
    );
    expect(outcome.ok, outcome.content).toBe(true);
    const site = JSON.parse(outcome.content) as { amount_fen: number; formula: string };
    expect(viaMcp.amount_fen).toBe(site.amount_fen);
    expect(viaMcp.formula).toBe(site.formula);
    // 同案同 kind 只留一条：两条路各算一次，claims 表里仍然只有一行
    expect(count('claims', `case_id = ${mine}`)).toBe(1);
  });
});

// ========== client_ref 重放 ==========

describe('client_ref 重放：agent_writes 只一行，业务表只一条', () => {
  const ARMS: [string, Record<string, unknown>, string][] = [
    ['claim_calc', { kind: 'N', inputs: N_INPUTS }, 'claims'],
    ['claims_upsert', { kind: '欠薪', amount_fen: 500_000 }, 'claims'],
    ['deadline_set', { kind: '起诉15日', anchor_date: '2026-03-02' }, 'deadlines'],
    [
      'action_create',
      { items: [{ what: '整理工资流水', how: '导出近 24 个月银行明细', why: '基数要能自证', due_at: '2026-03-05T18:00:00+08:00' }] },
      'action_items',
    ],
  ];

  it.each(ARMS)(
    '%s 重放同一个 client_ref（变异：把 withClientRef 去掉直接落库 → 红）',
    (name, args, table) => {
      const first = call(name, { case_id: mine, ...args, client_ref: 'ref-1' });
      expect(first.ok).not.toBe(false);
      expect(first.deduped).toBe(false);

      const replay = call(name, { case_id: mine, ...args, client_ref: 'ref-1' });
      expect(replay.deduped).toBe(true);

      expect(count('agent_writes', `tool = '${name}' AND client_ref = 'ref-1'`)).toBe(1);
      expect(count(table, `case_id = ${mine}`)).toBe(1);
    },
  );

  it('不同 client_ref 不去重（空名单会让上面那组永远绿）', () => {
    call('deadline_set', { case_id: mine, kind: '起诉15日', anchor_date: '2026-03-02', client_ref: 'r1' });
    call('deadline_set', { case_id: mine, kind: '上诉15日', anchor_date: '2026-04-02', client_ref: 'r2' });
    expect(count('agent_writes', "tool = 'deadline_set'")).toBe(2);
    expect(count('deadlines', `case_id = ${mine}`)).toBe(2);
  });
});

// ========== 期限 ==========

describe('deadline_set / deadline_resolve', () => {
  it('同案 + 同 kind + 同锚点不重复落库（变异：把 insertDeadline 换成裸 INSERT → 红）', () => {
    const a = call('deadline_set', { case_id: mine, kind: '起诉15日', anchor_date: '2026-03-02' });
    const b = call('deadline_set', { case_id: mine, kind: '起诉15日', anchor_date: '2026-03-02' });
    expect(a.deadline_id).toBe(b.deadline_id);
    expect(b.created).toBe(false);
    expect(b.deduped).toBe(true);
    expect(count('deadlines', `case_id = ${mine}`)).toBe(1);
  });

  it('锚点不同则是两条（去重不能宽到把不同锚点也吃掉）', () => {
    call('deadline_set', { case_id: mine, kind: '起诉15日', anchor_date: '2026-03-02' });
    call('deadline_set', { case_id: mine, kind: '起诉15日', anchor_date: '2026-05-06' });
    expect(count('deadlines', `case_id = ${mine}`)).toBe(2);
  });

  it('天数由办案机构指定的期限：不给 days 就 DAYS_REQUIRED 且零写入（变异：删掉这道检查 → 红）', () => {
    const out = call('deadline_set', { case_id: mine, kind: '举证期限', anchor_date: '2026-03-02' });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('DAYS_REQUIRED');
    expect(count('deadlines')).toBe(0);
    expect(count('agent_writes')).toBe(0);

    const ok = call('deadline_set', { case_id: mine, kind: '举证期限', anchor_date: '2026-03-02', days: 5 });
    expect(ok.ok).not.toBe(false);
    expect(ok.due_date).toBeTruthy();
  });

  it('推算不出来的种类明说算不出来，不静默落一条空期限', () => {
    const out = call('deadline_set', { case_id: mine, kind: '开庭', anchor_date: '2026-03-02' });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('NO_DEADLINE_RULE');
    expect(count('deadlines')).toBe(0);
  });

  it('deadline_resolve 幂等：第二次不报错、不刷新时间戳', () => {
    const set = call('deadline_set', { case_id: mine, kind: '起诉15日', anchor_date: '2026-03-02' });
    const first = call('deadline_resolve', { case_id: mine, deadline_id: set.deadline_id });
    expect(first.resolved).toBe(true);
    expect(first.already_resolved).toBe(false);
    const at = (db.prepare('SELECT resolved_at FROM deadlines WHERE id = ?').get(set.deadline_id) as {
      resolved_at: string;
    }).resolved_at;

    const again = call('deadline_resolve', { case_id: mine, deadline_id: set.deadline_id });
    expect(again.ok).not.toBe(false);
    expect(again.already_resolved).toBe(true);
    expect(
      (db.prepare('SELECT resolved_at FROM deadlines WHERE id = ?').get(set.deadline_id) as {
        resolved_at: string;
      }).resolved_at,
    ).toBe(at);
  });

  it('别人案件下的期限 id 当作不存在（变异：改按 id 直接 UPDATE → 红）', () => {
    const theirRow = Number(
      db
        .prepare("INSERT INTO deadlines (case_id, kind, due_at, derived_from) VALUES (?, '起诉15日', datetime('now'), 'x')")
        .run(theirs).lastInsertRowid,
    );
    const out = call('deadline_resolve', { case_id: mine, deadline_id: theirRow });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('DEADLINE_NOT_FOUND');
    expect(
      (db.prepare('SELECT resolved_at FROM deadlines WHERE id = ?').get(theirRow) as { resolved_at: string | null })
        .resolved_at,
    ).toBeNull();
  });
});

// ========== 行动卡 ==========

describe('action_create', () => {
  const card = (what: string) => ({
    what,
    how: '照着做',
    why: '有理由',
    due_at: '2026-03-05T18:00:00+08:00',
  });

  it(`一次最多 ${agent.MAX_ACTION_CARDS} 张，超了整笔拒收（变异：改成截断多余的 → 红）`, () => {
    const out = call('action_create', {
      case_id: mine,
      items: [card('一'), card('二'), card('三'), card('四')],
    });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('TOO_MANY_ACTIONS');
    expect(count('action_items')).toBe(0);
  });

  it('三张一次落三条，created 语义照 insertActionItem（同题待办回 created:false）', () => {
    const out = call('action_create', { case_id: mine, items: [card('一'), card('二'), card('三')] });
    expect((out.actions as { created: boolean }[]).map((a) => a.created)).toEqual([true, true, true]);
    expect(count('action_items', `case_id = ${mine}`)).toBe(3);

    const again = call('action_create', { case_id: mine, items: [card('一')] });
    expect((again.actions as { created: boolean }[])[0].created).toBe(false);
    expect(count('action_items', `case_id = ${mine}`)).toBe(3);
  });

  it('三样缺一即整笔拒收，不写半截卡', () => {
    const out = call('action_create', {
      case_id: mine,
      items: [card('一'), { what: '二', how: '', why: '有理由', due_at: '2026-03-05T18:00:00+08:00' }],
    });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('INVALID_ACTION');
    expect(count('action_items')).toBe(0);
  });

  it('due_at 不是合法时刻即拒收——「今天下班前」不是一个日期', () => {
    const out = call('action_create', {
      case_id: mine,
      items: [{ what: '一', how: '照着做', why: '有理由', due_at: '今天下班前' }],
    });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('INVALID_DUE_AT');
    expect(count('action_items')).toBe(0);
  });
});

// ========== 诉求清单 ==========

describe('claims_upsert / claims_list', () => {
  it('同案同 kind 一条：第二次是覆盖不是追加', () => {
    const a = call('claims_upsert', { case_id: mine, kind: '欠薪', amount_fen: 100_000 });
    const b = call('claims_upsert', { case_id: mine, kind: '欠薪', amount_fen: 250_000 });
    expect(b.claim_id).toBe(a.claim_id);
    expect(b.created).toBe(false);
    expect(count('claims', `case_id = ${mine}`)).toBe(1);
    expect(
      (db.prepare('SELECT amount_fen FROM claims WHERE id = ?').get(a.claim_id) as { amount_fen: number }).amount_fen,
    ).toBe(250_000);
  });

  it('算得出来的项不许在这里填金额（变异：删掉这道闸门 → 红）', () => {
    const out = call('claims_upsert', { case_id: mine, kind: 'N', amount_fen: 999_999 });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('AMOUNT_REQUIRES_CALC');
    expect(count('claims')).toBe(0);
    // 金额留空只登记这一项是允许的
    expect(call('claims_upsert', { case_id: mine, kind: 'N' }).ok).not.toBe(false);
  });

  it('本领域词表之外的 kind 一律拒收', () => {
    const out = call('claims_upsert', { case_id: mine, kind: '随便编一个', amount_fen: 0 });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('INVALID_KIND');
  });

  it('合计由服务端算（变异：把 total_fen 改成回 0 → 红）', () => {
    call('claims_upsert', { case_id: mine, kind: '欠薪', amount_fen: 123_400 });
    call('claims_upsert', { case_id: mine, kind: '年终奖', amount_fen: 76_600 });
    const out = call('claims_list', { case_id: mine });
    expect((out.claims as unknown[]).length).toBe(2);
    expect(out.total_fen).toBe(200_000);
    expect(out.total_yuan).toBe('2000.00');
  });
});
