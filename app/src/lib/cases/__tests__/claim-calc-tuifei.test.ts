// app/src/lib/cases/__tests__/claim-calc-tuifei.test.ts
// 退费算钱器**接上没有**（设计稿 §16 calculatorKinds）。
//
// 【为什么公式的判据之外还要有这一份】calc/__tests__/tuifei.test.ts 问的是"公式算得对不对"，
// 那是一个纯函数，它自己是对的。本份问的是完全不同的一件事：
//   · claim_calc 的 kind 词表按**案件所属领域**取了吗？（没取的形态是：
//     counseling 的用户调「退费」被拒，错误信息里列的还是另一个行当那十项）
//   · 算完那笔账真的落进了这个案子？回给模型的那段话真的带了"给区间不给一个数"那句纪律？
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as cases from '@/lib/cases';
import { runClaimCalc } from '@/lib/cases/claims';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS, DOMAINS_ENABLED_ENV } from '@/lib/domains/registry';

const COUNSELING = DOMAINS.counseling;

let db: Database.Database;
let uid: number;
const ORIGINAL = process.env[DOMAINS_ENABLED_ENV];

beforeEach(() => {
  process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN},counseling`;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('calc').lastInsertRowid);
});

afterEach(() => {
  db.close();
  if (ORIGINAL === undefined) delete process.env[DOMAINS_ENABLED_ENV];
  else process.env[DOMAINS_ENABLED_ENV] = ORIGINAL;
});

function makeCase(domain: string): number {
  const made = cases.ensureDefaultCase(db, uid, domain);
  if ('ok' in made) throw new Error(JSON.stringify(made));
  return made.caseId;
}

/** 一份标准算例：付 12000 元买 20 次（单次 600），已做 8 次。 */
const ARGS = {
  kind: '退费',
  total_paid_fen: 1_200_000,
  sessions_total: 20,
  sessions_used: 8,
  unit_price_fen: 60_000,
};

describe('claim_calc 的「退费」按案件领域放行', () => {
  it('counseling 案件算得出来，金额落库、calc_json 留痕', () => {
    const caseId = makeCase('counseling');
    const got = runClaimCalc(ARGS, { db, caseId, calculatorKinds: COUNSELING.calculatorKinds });
    expect(got.ok, JSON.stringify(got)).toBe(true);
    if (!got.ok) return;
    // amountFen = 区间上限（对我方最不利的那一端）
    expect(got.payload.amount_fen).toBe(720_000);
    const row = db.prepare('SELECT kind, amount_fen, calc_json FROM claims WHERE id = ?').get(got.claimId) as {
      kind: string;
      amount_fen: number;
      calc_json: string;
    };
    expect(row.kind).toBe('退费');
    expect(row.amount_fen).toBe(720_000);
    // 三条口径与三倍风险区间都在 calc_json 里，日后复算不依赖当时的调用现场
    const parsed = JSON.parse(row.calc_json) as Record<string, unknown>;
    expect(parsed.byUnusedRatioFen).toBe(720_000);
    expect(parsed.punitiveRisk).toBeTruthy();
  });

  it('回给模型的那段话逐字要求「只给区间」，且点名三倍那一步不得并进总额', () => {
    const caseId = makeCase('counseling');
    const got = runClaimCalc(ARGS, { db, caseId, calculatorKinds: COUNSELING.calculatorKinds });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const note = String(got.payload.note);
    expect(note).toContain('只给区间');
    expect(note).toContain('punitive-risk');
    expect(note).toContain('不得并进退费总额');
    // amount_fen 的语义要说清：它是区间上限，不是"应退这么多"
    expect(note).toContain('区间上限');
  });

  it('缺省领域的案子调「退费」⇒ 拒，且错误信息列的是**它自己**那份词表（变异：把词表写死成缺省域 → 红）', () => {
    const caseId = makeCase(DEFAULT_DOMAIN);
    const got = runClaimCalc(ARGS, {
      db,
      caseId,
      calculatorKinds: DOMAINS[DEFAULT_DOMAIN].calculatorKinds,
    });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain(DOMAINS[DEFAULT_DOMAIN].calculatorKinds[0]);
    expect(got.error).not.toContain('退费 /');
    expect(db.prepare('SELECT COUNT(*) n FROM claims').get()).toEqual({ n: 0 });
  });

  it('反过来也一样：counseling 案件调缺省领域那几项 ⇒ 拒，零写入', () => {
    const caseId = makeCase('counseling');
    const got = runClaimCalc(
      { kind: DOMAINS[DEFAULT_DOMAIN].calculatorKinds[0], avg_monthly_wage_fen: 1_000_000 },
      { db, caseId, calculatorKinds: COUNSELING.calculatorKinds },
    );
    expect(got.ok).toBe(false);
    expect(db.prepare('SELECT COUNT(*) n FROM claims').get()).toEqual({ n: 0 });
  });

  it('入参不齐 ⇒ **一次把四项全列出来**，不是一次报一个（变异：改成逐项 return → 红）', () => {
    const caseId = makeCase('counseling');
    const got = runClaimCalc({ kind: '退费' }, { db, caseId, calculatorKinds: COUNSELING.calculatorKinds });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.missing).toBeDefined();
    expect(got.missing!.length, '四项必填没有一次列全').toBe(4);
    for (const f of ['total_paid_fen', 'sessions_total', 'sessions_used', 'unit_price_fen']) {
      expect(got.missing!.join('；')).toContain(f);
    }
    expect(db.prepare('SELECT COUNT(*) n FROM claims').get()).toEqual({ n: 0 });
  });

  it('次数自相矛盾（已做 21 次 / 约定 20 次）⇒ 回一句说清是哪两个数打架，不落库', () => {
    const caseId = makeCase('counseling');
    const got = runClaimCalc(
      { ...ARGS, sessions_used: 21 },
      { db, caseId, calculatorKinds: COUNSELING.calculatorKinds },
    );
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain('已完成次数 21 超过约定总次数 20');
    expect(db.prepare('SELECT COUNT(*) n FROM claims').get()).toEqual({ n: 0 });
  });

  it('合同条款认得出来：写了「概不退费」⇒ 区间下限变 0，但上限不变', () => {
    const caseId = makeCase('counseling');
    const got = runClaimCalc(
      { ...ARGS, refund_clause: '概不退费' },
      { db, caseId, calculatorKinds: COUNSELING.calculatorKinds },
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const parsed = JSON.parse(
      (db.prepare('SELECT calc_json FROM claims WHERE id = ?').get(got.claimId) as { calc_json: string })
        .calc_json,
    ) as { rangeLowFen: number; rangeHighFen: number; byContractFen: number | null };
    expect(parsed.byContractFen).toBe(0);
    expect(parsed.rangeLowFen).toBe(0);
    expect(parsed.rangeHighFen).toBe(720_000);
  });

  it('条款名认不出来 ⇒ 按「合同未约定」走，**不猜**（那一条口径不出数，不是替它填一个 0）', () => {
    const caseId = makeCase('counseling');
    const got = runClaimCalc(
      { ...ARGS, refund_clause: '写了点别的什么' },
      { db, caseId, calculatorKinds: COUNSELING.calculatorKinds },
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const parsed = JSON.parse(
      (db.prepare('SELECT calc_json FROM claims WHERE id = ?').get(got.claimId) as { calc_json: string })
        .calc_json,
    ) as { byContractFen: number | null; rangeLowFen: number };
    expect(parsed.byContractFen).toBeNull();
    expect(parsed.rangeLowFen, '把"没约定"猜成了"约定退 0"').not.toBe(0);
  });
});
