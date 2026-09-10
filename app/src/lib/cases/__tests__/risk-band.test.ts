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

/** 往时间线记一条事件（要件表按 kind 认它，按 source_tier 定档）。 */
function addTimeline(kind: string, title: string, sourceTier = '书证') {
  db.prepare(
    `INSERT INTO timeline_events (case_id, happened_at, kind, title, source_tier)
     VALUES (?, '2026-08-20', ?, ?, ?)`,
  ).run(caseId, kind, title, sourceTier);
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

  test('材料补齐之后档位往上走、缺口只剩说得出名字的那一条（自证上一条不是恒 null）', () => {
    const before = band()!;
    expect(before.band).toBe('依据不足'); // 什么材料都没有时是这一档
    addEvidence('公司文件', '解除通知.pdf');
    // 【为什么还要记这条时间线事件】（第三轮小修 2026-09-10）「公司文件」是个很宽的类别，
    // 一份员工手册也落在它下面。路径一因此不只要那份文件，还要一条**公司确实作出过这个决定**
    // 的记录；只放文件的形态是下面那条反臂用例。
    addTimeline('公司动作', '收到解除通知');
    addEvidence('工资', '工资流水.pdf');
    // 先算一次把 claim:N 登记进去，再算一次拿到补齐之后的那张表
    const backed = { evidence_backed: ['avg_monthly_wage_fen', 'employed_from', 'terminated_at'] };
    calc(backed);
    const after = band(backed)!;

    // 档位确实往上走了一档，且输入侧不再有"只有你自己说"的项
    expect(after.band).toBe('需补证后可主张');
    expect(after.self_reported_inputs).toEqual([]);
    const gaps = after.gaps as { element_id: string; status: string }[];
    expect(gaps.length).toBeLessThan((before.gaps as unknown[]).length);

    // ── 互斥路径不许把档位拖下去（第二轮复审 2026-09-10 第四条）──
    // 【为什么这条断言值钱】S6 复审第一条把原 N-2 拆成两张卡：N-2a 公司作出的决定
    //（§44 倒置）与 N-2b 你依照第三十八条提出的被迫解除（谁主张谁举证）。两条路径**二选一**，
    // 而要件表按诉求列全 ⇒ 本案走的是路径一（档案里有《解除通知》），路径二那张卡恒是
    //「缺失」＝〔未记录〕。riskBandOf 若不认识这层分组，见到任何一条「缺失」就落到
    //「依据不足」——一个《解除通知》与工资流水都在档的案子被告知"依据不足"，
    // gaps 里还多一条让他去准备那份他从来没发过的被迫解除通知。
    // 两张卡挂同一个 alternativeGroup 之后，走通一条即算走通（representativeElementIds）。
    expect(gaps.map((g) => g.element_id), 'N-2b（没走的那条路）不该出现在缺口里').toEqual(['N-1']);

    // 【N-1 为什么到不了「成立」，而这不是 bug】「劳动关系存在、工作年限起点可确定」
    // 只由首诊填的入职日与登记的对方主体撑着，而首诊四项按 S4 的口径恒是「自述」。
    // 所以它的天花板就是「成立·待证」。这句话是实话：只要入职日仍然只有当事人自己的说法，
    // 这一项在庭上就是待证的。要不要让一份社保或合同把首诊字段提档，是 S4 那一层的口径问题。
    expect(gaps.find((g) => g.element_id === 'N-1')!.status).toBe('成立·待证');
    expect(after.floor_fen).toBeNull();
  });

  test('只有一份「公司文件」不算走通路径一：两条路径都还在缺口里，档位不许往上走（变异：去掉 N-2a 的 timeline:公司动作 槽 → 红）', () => {
    // 【它守什么】（第三轮小修 2026-09-10）风闻裁员、还没收到任何解除通知、先把员工手册
    // 传上来的那个人——员工手册也落在「公司文件」类别下。路径一若靠它成立，就成了本组代表行，
    // 于是同组那条被迫解除路径（他真正该走的那条）从缺口清单里消失，档位还跟着往上抬一档。
    addEvidence('公司文件', '员工手册.pdf');
    addEvidence('工资', '工资流水.pdf');
    calc();
    const b = band()!;
    expect(b.band, '一份员工手册就把档位抬上去了').toBe('依据不足');
    expect(
      (b.gaps as { element_id: string }[]).map((g) => g.element_id),
      '两条解除路径都还没走通，两条都该留在缺口里',
    ).toEqual(expect.arrayContaining(['N-2a', 'N-2b']));
  });

  test('反臂：两条路径都没走通时照旧落「依据不足」（分组不是"少一条缺口"的免检章）', () => {
    // 【为什么要这条反臂】上一条把「路径二缺失」从缺口里摘掉了。只有它的话，
    // 把分组做成"组内有一条缺失就整组不算缺"也是绿的——那等于这一项诉求再也报不出缺口。
    // 这里不传任何材料：两条路径都是〔未记录〕，两条都该留在缺口里。
    calc();
    const b = band()!;
    expect(b.band).toBe('依据不足');
    const ids = (b.gaps as { element_id: string }[]).map((g) => g.element_id);
    expect(ids, '两条路都没走通时，两条都该摆出来让用户自己认').toEqual(
      expect.arrayContaining(['N-2a', 'N-2b']),
    );
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
    addTimeline('公司动作', '收到解除通知'); // 路径一要两样，见上面那条用例的注释
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
