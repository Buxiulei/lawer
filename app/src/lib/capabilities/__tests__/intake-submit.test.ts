// intake_submit 这层壳的判据：**说明书上宣告的每一个参数，都真的落进了档案**。
//
// 【为什么单开一条盯这个】这层壳做的事只有两件——补上归属（case_id / 身份），
// 把对外参数名换成内部键名。第二件事原来是一份**手写的对照表**，而它的失败形态不报错：
// 少抄一行，那个参数就被静默丢弃——说明书上写着它、用户的 agent 照着填了、回包 ok:true、
// 档案里那一格是空的。谁都不会收到任何一句提示。
//
// 现在映射由领域包的 intakeSchema 派生（shared.intakeArgsToInput），这一条是它的观察点：
// 把映射改回手写、随便漏掉一项（如 position / bottom_line / company_wording），本文件必红。
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Identity } from '@/lib/auth/identity';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

import { getCapability } from '..';

const PACK = DOMAINS[DEFAULT_DOMAIN];
const SITE = PACK.copy.site;

let db: Database.Database;
let caseId: number;
let me: Identity;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(
    db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('a').lastInsertRowid,
  );
  caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uid, '我的').lastInsertRowid,
  );
  me = { uid, via: 'api_key', scopes: ['case:read', 'case:write'], keyId: undefined };
});

/** 一份**填满**的首诊入参，键名全部照工具说明书（inputSchema 里那些 param） */
function fullArgs() {
  return {
    case_id: caseId,
    stage: PACK.stages[0],
    company_name: '对面那家有限公司',
    employed_from: '2020-03-01',
    monthly_wage_yuan: 30000,
    position: '高级工程师',
    contract_count: '两次',
    events: [{ date: '2026-08-20', text: '收到一份通知' }],
    free_text: '我把经过整段写在这里。',
    company_docs: { terminationNotice: '给了', settlementAgreement: '没给', otherPaper: '给了一张' },
    company_wording: '口头说的是「优化」',
    goals: ['要个说法', '把钱结清'],
    bottom_line: '不低于 8 万',
  };
}

function submit(args: Record<string, unknown>) {
  const cap = getCapability('intake_submit');
  expect(cap, '注册表里没有 intake_submit').toBeDefined();
  return cap!.run(db, me, args) as Record<string, unknown>;
}

function caseRow() {
  return db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as Record<string, unknown>;
}

function timelineTitles(): string[] {
  return (
    db.prepare('SELECT title FROM timeline_events WHERE case_id = ? ORDER BY id').all(caseId) as {
      title: string;
    }[]
  ).map((r) => r.title);
}

describe('intake_submit：说明书上的每个参数都落进档案', () => {
  it('必填四项 + 诉求落在 cases 列上（元→分的换算就在这层壳里）', () => {
    const res = submit(fullArgs());
    expect(res.ok).toBe(true);
    const row = caseRow();
    expect(row.stage).toBe(PACK.stages[0]);
    expect(row.employed_from).toBe('2020-03-01');
    // 对外收「元」、落库存「分」：漏掉换算的形态是金额小 100 倍，而它是所有金额的基数
    expect(row.monthly_wage_fen).toBe(3_000_000);
    expect(row.goal).toBe('要个说法、把钱结清');
  });

  it('可选四项一个都不许丢：position / contract_count / bottom_line 落列，company_wording 落时间线（变异：映射里删掉其中任一项 → 红）', () => {
    submit(fullArgs());
    const row = caseRow();
    expect(row.position).toBe('高级工程师');
    expect(row.contract_count).toBe('两次');
    expect(row.bottom_line).toBe('不低于 8 万');
    expect(timelineTitles()).toContain(SITE.intakeCounterpartWordingTitle);
  });

  it('events / free_text / company_docs 三项各自落成时间线事件（变异：映射里删掉 company_docs → 那条事件消失 → 红）', () => {
    const res = submit(fullArgs());
    const titles = timelineTitles();
    expect(titles).toContain('收到一份通知'); // events
    expect(titles).toContain(SITE.intakeFreeTextTitle); // free_text
    expect(titles).toContain(SITE.intakeCounterpartDocsTitle); // company_docs
    expect((res.result as { timelineAdded: number }).timelineAdded).toBe(4);
  });

  it('company_name 落成对方主体那一行（变异：映射里删掉 company_name → 必填校验先红）', () => {
    submit(fullArgs());
    const row = db
      .prepare('SELECT name, sources_json FROM company_profiles WHERE case_id = ?')
      .get(caseId) as { name: string; sources_json: string };
    expect(row.name).toBe('对面那家有限公司');
    expect(row.sources_json).toContain(SITE.intakeCompanySource);
  });

  it('可选项整个不给也照常建档，且不会因此写出空事件（缺省不填 ≠ 填了空）', () => {
    const all = fullArgs();
    const res = submit({
      case_id: all.case_id,
      stage: all.stage,
      company_name: all.company_name,
      employed_from: all.employed_from,
      monthly_wage_yuan: all.monthly_wage_yuan,
      goals: all.goals,
    });
    expect(res.ok).toBe(true);
    const row = caseRow();
    expect(row.position).toBeNull();
    expect(row.bottom_line).toBeNull();
    expect(timelineTitles()).toEqual([]);
  });

  it('校验不过时逐字段回原因，且一行都不写（金额缺了 ⇒ INVALID_MONTHLY_WAGE）', () => {
    const args = fullArgs() as Record<string, unknown>;
    delete args.monthly_wage_yuan;
    const res = submit(args);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_MONTHLY_WAGE');
    expect(timelineTitles()).toEqual([]);
    expect(caseRow().employed_from).toBeNull();
  });
});
