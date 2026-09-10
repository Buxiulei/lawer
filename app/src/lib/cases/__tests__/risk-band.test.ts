// app/src/lib/cases/__tests__/risk-band.test.ts
// **风险区间**（设计稿 §3 `risk_band`、S6 派单第 5 条）的判据。
//
// 三条红线，每一条都对着一种具体的错法：
//   ① **不给胜率**。这个产品不预测结果概率（charter §1）——一个凭空的百分比会被
//      用户当成"我有七成把握"拿去跟对方谈。判据：回包里没有百分比形态的胜率表述，
//      且那句纪律明写着"不是胜率"。
//   ② **不编下限**。"按现有书证能撑的最低值"折成一个金额，需要知道"没有书证的那个输入
//      该按多少算"——那个数字不存在于任何地方，只能编。判据：关键输入含自述时 floor_fen 为 null，
//      并说清为什么给不出。
//   ③ **每个差额对应一条缺证要件**。只说"还差点材料"等于没说。判据：gaps 非空时逐条
//      带 element_id 与 typical_evidence，且 element_id 都是真实存在的要件。
//
// 【变异臂】把 floor_fen 改成恒等于 amountFen（编一个下限）⇒ ② 红；
// 把 gaps 改成只回条数不回明细 ⇒ ③ 红；把 note 里那句"不是胜率"删掉 ⇒ ① 红。
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runClaimCalc } from '@/lib/cases/claims';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

const LABOR = DOMAINS[DEFAULT_DOMAIN];

let db: Database;
let uid: number;
let caseId: number;

/** N 的三个必填项，够算出一个金额。 */
const N_ARGS = {
  kind: 'N',
  avg_monthly_wage_fen: 2_500_000,
  employed_from: '2020-03-01',
  terminated_at: '2026-08-31',
};

function calc(over: Record<string, unknown> = {}) {
  const res = runClaimCalc({ ...N_ARGS, ...over }, { db, caseId, calculatorKinds: LABOR.calculatorKinds });
  if (!res.ok) throw new Error(`没算成功：${res.error}`);
  return res.payload as Record<string, unknown>;
}

function band(over: Record<string, unknown> = {}) {
  return calc(over).risk_band as Record<string, unknown> | null;
}

/** 传一份某个类别的材料进证据库（要件表按类别认它）。 */
function addEvidence(category: string, name: string) {
  const fileId = Number(
    db
      .prepare("INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, 1, 'application/pdf', '/dev/null')")
      .run(`sha-${category}-${name}`).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO evidence (case_id, user_id, file_id, name, category, status)
     VALUES (?, ?, ?, ?, ?, '已上传')`,
  ).run(caseId, uid, fileId, name, category);
}

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(
    db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('h', '未认证')").run().lastInsertRowid,
  );
  caseId = Number(
    db
      .prepare(
        `INSERT INTO cases (user_id, title, stage, employed_from, monthly_wage_fen, position, contract_count)
         VALUES (?, '案子', '仲裁准备', '2020-03-01', 2500000, '后端工程师', '续签过一次')`,
      )
      .run(uid).lastInsertRowid,
  );
  db.prepare("INSERT INTO company_profiles (case_id, name, role) VALUES (?, '某公司', '签约主体')").run(caseId);
});

afterEach(() => db.close());

describe('① 不给胜率', () => {
  test('回包里那句纪律明写"不是胜率"，且没有百分比形态的把握表述', () => {
    const b = band()!;
    expect(String(b.note)).toContain('不是胜率');
    expect(String(b.note)).not.toMatch(/\d+\s*%/);
    expect(String(b.floor_reason)).not.toMatch(/\d+\s*%/);
  });
});

describe('② 不编下限', () => {
  test('输入全是自述、要件也没立住 ⇒ floor_fen 为 null，并说清为什么给不出', () => {
    const b = band()!;
    expect(b.floor_fen).toBeNull();
    expect(b.floor_yuan).toBeNull();
    expect(String(b.floor_reason)).toContain('算不出一个下限');
    expect(String(b.floor_reason)).toContain('不要自己编');
    // 上限就是这次算出来的那个数（不打折、不加成）
    expect(b.ceiling_fen).toBe(calc().amount_fen);
  });

  test('材料补齐之后缺口确实变少（自证上一条不是恒 null），但档位仍停在「依据不足」', () => {
    const before = band()!;
    expect(before.band).toBe('依据不足'); // 什么材料都没有时是这一档
    addEvidence('公司文件', '解除通知.pdf');
    addEvidence('工资', '工资流水.pdf');
    // 先算一次把 claim:N 登记进去，再算一次拿到补齐之后的那张表
    const backed = { evidence_backed: ['avg_monthly_wage_fen', 'employed_from', 'terminated_at'] };
    calc(backed);
    const after = band(backed)!;

    // 输入侧不再有"只有你自己说"的项，缺口从 5 条降到 2 条（"补了材料什么都没变"是这条要拦的一半）
    expect(after.self_reported_inputs).toEqual([]);
    const gaps = after.gaps as { element_id: string; status: string }[];
    expect(gaps.length).toBeLessThan((before.gaps as unknown[]).length);

    // ── 基线换过的那一次（S6 复审整改，2026-09-10）：'需补证后可主张' → '依据不足' ──
    // 【为什么变了，而且这不是判据写松了】复审第一条把原 N-2 拆成两张卡：
    //   · N-2a 公司作出的决定（协商解除 / 第四十条 / 第四十一条 / 期满终止，§44 倒置）
    //   · N-2b 你依照第三十八条提出的被迫解除（第四十六条第一项，谁主张谁举证）
    // 两条路径**二选一**，而要件表按诉求列全 ⇒ 本案走的是路径一（档案里有《解除通知》），
    // 路径二那张卡恒是「缺失」＝〔未记录〕；riskBandOf 见到任何一条「缺失」就落到「依据不足」。
    // 拆之前这个案子到得了「需补证后可主张」——**这是对外行为的真实变化，记在这里**。
    // 要不要让 riskBandOf 认识"互斥路径"（或给要件卡一个"任选其一"的分组）是另一票，
    // 已作为 openQuestion 报给经理，不由这一票偷偷改掉。
    expect(after.band).toBe('依据不足');
    expect(gaps.map((g) => g.element_id)).toEqual(['N-2b', 'N-1']);
    expect(gaps.find((g) => g.element_id === 'N-2b')!.status).toBe('缺失');

    // 【N-1 为什么到不了「成立」，而这不是 bug】「劳动关系存在、工作年限起点可确定」
    // 只由首诊填的入职日与登记的对方主体撑着，而首诊四项按 S4 的口径恒是「自述」。
    // 所以它的天花板就是「成立·待证」。这句话是实话：只要入职日仍然只有当事人自己的说法，
    // 这一项在庭上就是待证的。要不要让一份社保或合同把首诊字段提档，是 S4 那一层的口径问题。
    expect(gaps.find((g) => g.element_id === 'N-1')!.status).toBe('成立·待证');
    expect(after.floor_fen).toBeNull();
  });
});

describe('③ 每个差额对应一条缺证要件', () => {
  test('gaps 逐条带 element_id 与 typical_evidence，且 element_id 都是真的要件', () => {
    const b = band()!;
    const gaps = b.gaps as { element_id: string; status: string; typical_evidence: string[] }[];
    expect(gaps.length).toBeGreaterThan(0);
    const known = new Set((LABOR.elementCards ?? []).map((c) => c.id));
    for (const g of gaps) {
      expect(known.has(g.element_id), `${g.element_id} 不是这个领域的要件`).toBe(true);
      expect(g.typical_evidence.length, `${g.element_id} 没说补什么`).toBeGreaterThan(0);
      expect(g.status, `${g.element_id} 已经成立却进了缺口清单`).not.toBe('成立');
    }
  });

  test('档位随档案变：补上公司文件之后，缺口清单短一条（自证不是恒定文案）', () => {
    const before = (band()!.gaps as unknown[]).length;
    addEvidence('公司文件', '解除通知.pdf');
    const after = (band()!.gaps as unknown[]).length;
    expect(after).toBeLessThan(before);
  });

  test('自述输入逐个点名（"有几项待证"不说是哪几项等于没说）', () => {
    const b = band()!;
    expect(b.self_reported_inputs).toEqual(
      expect.arrayContaining(['avgMonthlyWageFen', 'employedFrom', 'terminatedAt']),
    );
  });
});

describe('地板：这一段真的接上了（回 null 会让上面每一条整组报错）', () => {
  test('本领域有要件卡 ⇒ risk_band 非 null', () => {
    expect((LABOR.elementCards ?? []).length).toBeGreaterThan(0);
    expect(band()).not.toBeNull();
  });
});
