// app/src/lib/capabilities/__tests__/elements-family.test.ts
// 要件族三条能力的判据（S6 判据四）。走的是能力的 `run(db, identity, args)`——
// 与 /api/mcp 的 tools/call、与两条 REST 端点调的是同一个函数。
//
// 【判据 ↔ 变异臂】
//  1) element_fill 逐条校验：要件不存在 / 槽位不属于这个要件 / 槽位这条路填不了
//     «把 satisfiedBy 那一句校验删掉 ⇒ 红»：那时一条事实会落进档案却不影响任何要件的状态，
//     回包 200、档案里多一行，而要件表一格都不变。
//  2) 三段式错误：填不了的槽位必须说清「缺什么 / 为什么缺 / 怎么办」
//     «把错误改成裸报错 ⇒ 红»：裸报错让调用方重推一遍我们已经推过的那一遍。
//  3) element_fill 不覆盖已有诉求的金额
//     «改成无条件 upsertClaim ⇒ 红»：一笔算过的钱被 0 抹平，回包 200。
//  4) 〔未记录〕≠ 不成立：一个什么都没填的案子，要件状态是「缺失」而不是「不成立」，
//     且回包里那句话不许把它说成"不满足"。
//  5) 别人的案子一条都读不到、写不进。
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Identity } from '@/lib/auth/identity';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

import { getCapability } from '..';

const LABOR = DOMAINS[DEFAULT_DOMAIN];

let db: Database.Database;
let alice: Identity;
let bob: Identity;
let caseId: number;

function call(name: string, identity: Identity, args: Record<string, unknown>) {
  const cap = getCapability(name);
  if (!cap) throw new Error(`注册表里没有 ${name}`);
  return cap.run(db, identity, args) as Record<string, unknown>;
}

function addUser(phoneHash: string): number {
  return Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run(phoneHash).lastInsertRowid);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uidA = addUser('hash-a');
  const uidB = addUser('hash-b');
  alice = { uid: uidA, via: 'api_key', scopes: ['case:read', 'case:write'] };
  bob = { uid: uidB, via: 'api_key', scopes: ['case:read', 'case:write'] };
  caseId = Number(
    db
      .prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, '甲的案子', '仲裁准备')")
      .run(uidA).lastInsertRowid,
  );
  db.prepare("INSERT INTO claims (case_id, kind, amount_fen, status) VALUES (?, '2N', 0, 'draft')").run(caseId);
});

describe('element_sheet_get：读要件表', () => {
  it('🔒 地板：注册表里真的有这三条（少一条会让下面每一组用例整组不跑）', () => {
    for (const n of ['element_sheet_get', 'issue_list', 'element_fill']) {
      expect(getCapability(n), n).toBeTruthy();
    }
  });

  it('回的是已登记那项诉求的要件，每行带 burden_label 与「补什么」', () => {
    const res = call('element_sheet_get', alice, { case_id: caseId });
    expect(res.rendered).toBe(true);
    const rows = res.rows as { id: string; claimKind: string; burden_label: string; typicalEvidence: string[] }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.claimKind).toBe('2N');
      expect(r.burden_label, `${r.id} 的举证责任措辞是空的`).toBeTruthy();
      expect(r.typicalEvidence.length, `${r.id} 没有"补什么"`).toBeGreaterThan(0);
    }
  });

  it('〔未记录〕≠ 不成立：一个什么都没填的案子，状态是「缺失」，回包里不许把它说成"不满足"', () => {
    const res = call('element_sheet_get', alice, { case_id: caseId });
    const rows = res.rows as { status: string }[];
    expect(rows.some((r) => r.status === '缺失')).toBe(true);
    expect(rows.some((r) => r.status === '不成立')).toBe(false);
    expect(String(res.note)).toContain('不是');
    expect(String(res.note)).toContain('〔未记录〕');
  });

  it('claim_kind 过滤只影响回哪几行，不影响状态怎么算', () => {
    const all = call('element_sheet_get', alice, { case_id: caseId });
    const one = call('element_sheet_get', alice, { case_id: caseId, claim_kind: '2N' });
    expect((one.rows as unknown[]).length).toBe((all.rows as unknown[]).length);
    expect(((one.rows as { status: string }[]) ?? []).map((r) => r.status)).toEqual(
      ((all.rows as { status: string }[]) ?? []).map((r) => r.status),
    );
  });

  it('别人的案子读不到', () => {
    const res = call('element_sheet_get', bob, { case_id: caseId });
    expect(res.ok).toBe(false);
  });
});

describe('issue_list：争点表', () => {
  it('要件没成立就有争点，每条带 nextStep（链接率 100%）', () => {
    const res = call('issue_list', alice, { case_id: caseId });
    expect(res.rendered).toBe(true);
    const issues = res.issues as { id: string; nextStep: string; anchors: string[] }[];
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) {
      expect(i.nextStep.trim(), `${i.id} 没有下一步`).not.toBe('');
      expect(i.anchors.length, `${i.id} 没有依据锚点`).toBeGreaterThan(0);
    }
  });

  it('回包里那句纪律说清了「正文提到的争点 ⊆ 争点表」', () => {
    const res = call('issue_list', alice, { case_id: caseId });
    expect(String(res.note)).toContain('子集');
  });

  it('别人的案子读不到', () => {
    expect(call('issue_list', bob, { case_id: caseId }).ok).toBe(false);
  });
});

describe('element_fill：校验先于写入', () => {
  it('要件不存在 ⇒ ELEMENT_NOT_FOUND，且档案零写入', () => {
    const before = (db.prepare('SELECT COUNT(*) n FROM timeline_events').get() as { n: number }).n;
    const res = call('element_fill', alice, {
      case_id: caseId,
      element_id: '压根没有这个要件',
      timeline_kind: '公司动作',
      happened_at: '2026-08-20T02:00:00Z',
      title: '随便一句话',
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('ELEMENT_NOT_FOUND');
    expect((db.prepare('SELECT COUNT(*) n FROM timeline_events').get() as { n: number }).n).toBe(before);
  });

  it('槽位不属于这个要件 ⇒ SLOT_NOT_IN_ELEMENT，并把它认的槽位逐个列出来', () => {
    const res = call('element_fill', alice, {
      case_id: caseId,
      element_id: '2N-1',
      slot: 'claim:欠薪',
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('SLOT_NOT_IN_ELEMENT');
    const card = (LABOR.elementCards ?? []).find((c) => c.id === '2N-1')!;
    for (const s of card.satisfiedBy) expect(String(res.message)).toContain(s);
  });

  it('这条路填不了的槽位 ⇒ 三段式错误：缺什么 / 为什么缺 / 怎么办', () => {
    const res = call('element_fill', alice, {
      case_id: caseId,
      element_id: '2N-2',
      slot: 'evidence:公司文件',
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('SLOT_NOT_FILLABLE_HERE');
    for (const part of ['缺什么', '为什么缺', '怎么办']) {
      expect(String(res.message), `错误里没有「${part}」这一段`).toContain(part);
    }
    // 「怎么办」必须点名真实存在的替代能力，不是一句"请用别的工具"
    expect(String(res.message)).toContain('evidence_register');
  });

  it('不点名 slot ⇒ 记一条时间线并挂到该要件名下，且明说状态没变、还缺什么', () => {
    const res = call('element_fill', alice, {
      case_id: caseId,
      element_id: '2N-2',
      timeline_kind: '公司动作',
      happened_at: '2026-08-20T02:00:00Z',
      title: 'HR 当面说"回家等通知"，什么文件都不给',
    });
    expect(res.ok).toBe(true);
    expect((res.wrote as { table: string }).table).toBe('timeline_events');
    expect(String(res.note)).toContain('不会改变这个要件的状态');
    expect((res.still_missing as string[]).length).toBeGreaterThan(0);
    expect((res.typical_evidence as string[]).length).toBeGreaterThan(0);
    // 留痕真的落库了，而且 element_sheet_get 读得回来
    const sheet = call('element_sheet_get', alice, { case_id: caseId });
    const row = (sheet.rows as { id: string; filled_by: unknown[] }[]).find((r) => r.id === '2N-2')!;
    expect(row.filled_by.length).toBe(1);
  });

  it('不点名 slot 又不给 timeline_kind ⇒ 拒收，并把可选值与可填槽位一起给出来', () => {
    const res = call('element_fill', alice, { case_id: caseId, element_id: '2N-2' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('MISSING_TIMELINE_KIND');
    expect(String(res.message)).toContain('公司动作');
  });

  it('填 claim 槽：已经登记过的那一项，金额与依据一个字节都不动', () => {
    db.prepare("UPDATE claims SET amount_fen = 9000000, basis = '算过的依据' WHERE case_id = ? AND kind = '2N'").run(caseId);
    const res = call('element_fill', alice, { case_id: caseId, element_id: '2N-4', slot: 'claim:2N' });
    expect(res.ok).toBe(true);
    const row = db.prepare("SELECT amount_fen, basis FROM claims WHERE case_id = ? AND kind = '2N'").get(caseId) as {
      amount_fen: number;
      basis: string;
    };
    expect(row.amount_fen).toBe(9_000_000);
    expect(row.basis).toBe('算过的依据');
    expect(String(res.note)).toContain('之前已经登记过');
  });

  it('同一条事实重复填同一个要件只留一条留痕（幂等）', () => {
    const args = {
      case_id: caseId,
      element_id: '2N-2',
      timeline_kind: '公司动作',
      happened_at: '2026-08-20T02:00:00Z',
      title: '同一件事说两遍',
    };
    call('element_fill', alice, args);
    call('element_fill', alice, args);
    const n = (db.prepare('SELECT COUNT(*) n FROM element_fills').get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('别人的案子写不进（写侧的归属校验与读侧同一口径）', () => {
    const res = call('element_fill', bob, {
      case_id: caseId,
      element_id: '2N-2',
      timeline_kind: '公司动作',
      happened_at: '2026-08-20T02:00:00Z',
      title: '越界写入',
    });
    expect(res.ok).toBe(false);
    expect((db.prepare('SELECT COUNT(*) n FROM element_fills').get() as { n: number }).n).toBe(0);
  });
});
