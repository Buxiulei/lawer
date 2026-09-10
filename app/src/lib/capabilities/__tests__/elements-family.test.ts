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
//  6) 「对方书面决定在档」只认双槽：一份员工手册（也归「公司文件」类）不许让 issue_list
//     的回包带上 burden_on_other_side
//     «counterpartyDecisionSlot 改回单槽 / 2N-3 去掉 timeline:公司动作 ⇒ 红»：
//     模型据回包对一个还没收到任何通知的人说"公司那份书面决定已在档"，回包 200。
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Identity } from '@/lib/auth/identity';
import { NEXT_STEP_FIX_DECISION } from '@/lib/cases/issue-table';
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

  it('§38 被迫解除那条路的 burden_label **不许**是「公司来证」（复审 2026-09-10 第一条）', () => {
    // REST/MCP 这一面回的是 burden_label 原文，模型据它对用户说"这件事谁来证"。
    // 印成「公司来证」的后果与事实卡那一面一样：走 §38 的用户不去备欠薪/未缴社保的初步证明。
    db.prepare("INSERT INTO claims (case_id, kind, amount_fen, status) VALUES (?, 'N', 0, 'draft')").run(caseId);
    const rows = call('element_sheet_get', alice, { case_id: caseId, claim_kind: 'N' }).rows as {
      id: string;
      burden: string;
      burden_label: string;
    }[];
    const forced = rows.find((r) => r.id === 'N-2b');
    expect(forced, '回包里没有 N-2b（§38 被迫解除）').toBeTruthy();
    expect(forced!.burden).toBe('claimant');
    expect(forced!.burden_label, '§38 那条路被印成了对方举证').not.toContain('公司来证');
    // 【反臂】N-2a（用人单位作出的决定）必须仍是「公司来证」——
    // 没有它，"整列 burden_label 都空了"也会让上面那句绿。
    const decided = rows.find((r) => r.id === 'N-2a');
    expect(decided, '回包里没有 N-2a（用人单位决定型）').toBeTruthy();
    expect(decided!.burden_label).toContain('公司来证');
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

  /** 往档案里放一件某类别的材料（真走 files + evidence 两张表，与上传那条路同形）。 */
  function addEvidence(category: string, name = `${category}.pdf`): void {
    const fileId = Number(
      db
        .prepare("INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, 1, 'application/pdf', '/dev/null')")
        .run(`sha-${category}-${name}`).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO evidence (case_id, user_id, file_id, name, category, status)
       VALUES (?, ?, ?, ?, ?, '已上传')`,
    ).run(caseId, alice.uid, fileId, name, category);
  }

  /** 往时间线记一条事件（要件表按 kind 认它，按 source_tier 定档）。 */
  function addTimeline(kind: string, title: string, sourceTier = '书证'): void {
    db.prepare(
      `INSERT INTO timeline_events (case_id, happened_at, kind, title, source_tier)
       VALUES (?, '2026-08-20', ?, ?, ?)`,
    ).run(caseId, kind, title, sourceTier);
  }

  it('规则三反臂：书证在档但类别 ≠ 领域包声明的「对方书面决定」⇒ 不算在档（把 onFile 改成常量 true / evidence.length>0 → 红）', () => {
    // 【它守什么】复审 2026-09-10 第三条：「在不在档」此前在报告与本能力里各写了一遍，
    // 而没有任何判据钉住它——换成常量 true，两侧的既有判据全绿。
    // 现在两侧共用 lib/cases/issue-table.counterpartyDecisionOnFile，这一条钉的就是那个入口。
    expect([...(LABOR.counterpartyDecision?.slots ?? [])]).toEqual([
      'evidence:公司文件',
      'timeline:公司动作',
    ]);
    // 那条「公司动作」还要过取值判定（2026-09-10「公司动作」票）——只对齐槽的形态是：
    // 要件卡按判定说「缺失」，规则三只数记录说「在档」，两行并排印在同一份报告上。
    expect(
      LABOR.counterpartyDecision?.slotChecks?.['timeline:公司动作'],
      '「公司动作」那个槽没有取值判定',
    ).toBeTruthy();
    addEvidence('工资'); // 有书证，但不是那张写着理由的纸
    const before = (call('issue_list', alice, { case_id: caseId }).issues as {
      id: string;
      reasons: string[];
    }[]).find((i) => i.id === '2N-3');
    expect(before, '2N-3 不在争点表里（它此刻应当因"缺失"进表）').toBeTruthy();
    expect(
      before!.reasons,
      '档案里只有工资流水，却说"对方的书面决定已在档"——规则三凭空成立了',
    ).not.toContain('burden_on_other_side');

    // 【正臂】把那张纸与「公司确实作出过这个决定」一并落档，规则三当场就带上——
    // 证明上面那句不是"这条规则根本没接上"。两格缺一不可，见下面那条判据。
    addEvidence('公司文件', '解除通知.pdf');
    addTimeline('公司动作', '收到《解除劳动合同通知书》');
    const after = (call('issue_list', alice, { case_id: caseId }).issues as {
      id: string;
      reasons: string[];
    }[]).find((i) => i.id === '2N-3')!;
    expect(after.reasons).toContain('burden_on_other_side');
  });

  /** 争点表里那一行（没有则 undefined）。 */
  function issueOf(id: string) {
    return (call('issue_list', alice, { case_id: caseId }).issues as {
      id: string;
      status: string;
      reasons: string[];
      nextStep: string;
    }[]).find((i) => i.id === id);
  }

  it('一份员工手册不是解除决定：MCP 回包里 N-2a / 2N-3 都缺失，两行都不带 burden_on_other_side（第四轮 2026-09-10）', () => {
    // 【它守什么】「公司文件」是个很宽的类别——员工手册、规章制度、工资结构表都在它下面。
    // 收窄成双槽之前，这一份手册同时做成三件事，每件都返回 200：
    //   ① N-2a 的 reasons 带上 burden_on_other_side，经本能力原样回包，
    //      模型据此对一个还没收到任何通知的人说"公司那份书面决定已在档"；
    //   ② 2N-3 整条「成立」并恒进争点表；
    //   ③ nextStep 让他去把一份不存在的解除决定「原样固定下来」。
    // 【变异臂】counterpartyDecisionSlot 改回单槽 ⇒ 下面两句 reasons 红；
    //          2N-3 的 satisfiedBy 去掉 timeline:公司动作 ⇒ 它的状态断言红（会变成「成立」并整行离表）。
    db.prepare("INSERT INTO claims (case_id, kind, amount_fen, status) VALUES (?, 'N', 0, 'draft')").run(caseId);
    addEvidence('公司文件', '员工手册.pdf');

    for (const id of ['N-2a', '2N-3']) {
      const row = issueOf(id);
      expect(row, `${id} 不在争点表里（只有一份手册时它该以「缺失」进表）`).toBeTruthy();
      expect(row!.status, `${id} 被一份员工手册顶成了「${row!.status}」`).toBe('缺失');
      expect(
        row!.reasons,
        `档案里只有一份员工手册，${id} 却说"对方那份书面决定已在档"`,
      ).not.toContain('burden_on_other_side');
    }
    const all = call('issue_list', alice, { case_id: caseId }).issues as { nextStep: string }[];
    for (const row of all) {
      expect(row.nextStep, '没有那份决定，却让用户去把它「原样固定下来」').not.toContain(
        NEXT_STEP_FIX_DECISION,
      );
    }
  });

  it('自述档的公司动作不算「那份书面决定在档」：2N-3 停在「成立·待证」，回包 reasons 不带 burden_on_other_side（第四轮口径）', () => {
    // 【本票裁定的口径写在这里】规则三那句出路是「把他那份书面决定原样固定下来」；
    // 当事人自述的一通口头通知里没有那份决定，所以门槛取书证及以上
    //（理由见 lib/cases/issue-table.counterpartyDecisionOnFile 的函数注释）。
    // 【为什么这条判据落在本层，而不是报告层】状态一旦是「成立·待证」，nextStep 就走
    // 「只有你自己的说法」那一支，NEXT_STEP_FIX_DECISION 本来就印不出来——报告层只看得到
    // 措辞，钉不住这件事。**reasons 只在这一面原样回包**，模型据它对用户说
    // "公司那份书面决定已在档"，所以口径的牙必须长在这里。
    // 【变异臂】把门槛从 isDocumented 放回 `!= null` ⇒ 下面那句 reasons 红。
    addEvidence('公司文件', '解除通知.pdf');
    addTimeline('公司动作', 'HR 口头通知我被裁了', '自述');
    const row = issueOf('2N-3')!;
    expect(row, '2N-3 不在争点表里').toBeTruthy();
    expect(row.status, '两个槽里最弱的那一档是自述，这一条就该停在「成立·待证」').toBe('成立·待证');
    expect(
      row.reasons,
      '只有一句口头通知，回包却说"对方那份书面决定已在档"',
    ).not.toContain('burden_on_other_side');

    // 【反臂】同一条事件换成书证档（由《解除通知》提取写入的那种）当场翻真——
    // 没有这一臂，"规则三根本没接上"也会让上面那句绿。
    addTimeline('公司动作', '收到《解除劳动合同通知书》', '书证');
    const after = issueOf('2N-3')!;
    expect(after.status).toBe('成立');
    expect(after.reasons).toContain('burden_on_other_side');
  });

  it('规则三不碰偏在型：对方书面决定在档时，「计算基数」不被指示去固定那份决定（复审第三条 b）', () => {
    // 2N-5 是 reversed_procedure_rules（工资支付记录在公司手里），不是"这件事该由公司证"。
    // 把它一起捞进来的形态是：用户被指示去固定那份解除通知——而那张纸上一个字都不会写工资基数。
    const card = (LABOR.elementCards ?? []).find((c) => c.id === '2N-5')!;
    expect(card.burden).toBe('reversed_procedure_rules');
    addEvidence('公司文件', '解除通知.pdf');
    addTimeline('公司动作', '收到《解除劳动合同通知书》'); // 双槽都到位，规则三这才真的成立
    addEvidence('工资', '工资流水.pdf'); // 让 2N-5 变成「成立」，规则一不再捞它
    const rows = call('issue_list', alice, { case_id: caseId }).issues as {
      id: string;
      reasons: string[];
      nextStep: string;
    }[];
    // 【前提要自证】没有这一句，"规则三根本没成立"也会让下面两句绿——
    // 而收窄成双槽之后，前提正是最容易被漏掉的那一格（少记一条「公司动作」即不成立）。
    expect(
      rows.find((i) => i.id === '2N-3')?.reasons ?? [],
      '前提不成立：那份决定没算在档，本条判据在空跑',
    ).toContain('burden_on_other_side');
    const base = rows.find((i) => i.id === '2N-5');
    expect(base?.reasons ?? [], '偏在型被规则三捞进了争点表').not.toContain('burden_on_other_side');
    expect(base, '「计算基数」已经成立又没有别的理由，它就该整行不在表上').toBeUndefined();
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

describe('首诊那段整段自述不算一条事件记录（S6 backlog ② 复审裁定，2026-09-10）', () => {
  // 【它守什么】lib/cases/intake.ts 把首诊「把经过写下来」那一整段原样落成一条
  // kind='我方动作' 的事件（标题恒是 copy.site.intakeFreeTextTitle）。那是**叙事**，
  // 不是事件记录：里面写着"我已经发了被迫解除通知"，只说明他这么讲过，
  // 不说明档案里记着这件事发生在哪天、怎么送达。认它的形态是——首诊填完当场，
  //「路径二：你依照第三十八条提出被迫解除」就写着「成立·待证」，
  // 而时间线上一条通知记录都没有、沟通记录那一格是几张随手传的聊天截图。
  //
  // 【为什么这条判据走真库、还要真过 intake_submit】判定那一边只认得"标题等于那句话"。
  // 在判据里自己写一条同名事件的形态是：首诊哪天改了那句标题，判定静默失效，
  // 而这条判据照旧全绿——它验的成了自己写的那句话。
  //
  // 【变异 → 红】判定里去掉那道排除 ⇒ 第一条当场变「成立·待证」。
  const NARRATIVE = '我已经发了被迫解除通知，公司拖欠工资两个月';

  /** 这个案子要主张 N（要件表按已登记的诉求过滤），另一格「沟通记录」也放一件材料。 */
  beforeEach(() => {
    db.prepare("INSERT INTO claims (case_id, kind, amount_fen, status) VALUES (?, 'N', 0, 'draft')").run(caseId);
    const fileId = Number(
      db
        .prepare("INSERT INTO files (sha256, size, mime, enc_path) VALUES ('sha-chat', 1, 'image/png', '/dev/null')")
        .run().lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO evidence (case_id, user_id, file_id, name, category, status)
       VALUES (?, ?, ?, '与HR的聊天.png', '沟通记录', '已上传')`,
    ).run(caseId, alice.uid, fileId);
  });

  function submitIntake(freeText: string) {
    const res = call('intake_submit', alice, {
      case_id: caseId,
      stage: LABOR.stages[0],
      company_name: '对面那家有限公司',
      employed_from: '2020-03-01',
      monthly_wage_yuan: 30000,
      goals: ['把钱结清'],
      free_text: freeText,
    });
    expect(res.ok, `首诊没提交成功：${JSON.stringify(res)}`).toBe(true);
  }

  function n2b() {
    const rows = call('element_sheet_get', alice, { case_id: caseId }).rows as {
      id: string;
      status: string;
      missingSlots: string[];
    }[];
    const row = rows.find((r) => r.id === 'N-2b');
    expect(row, '要件表里没有 N-2b（这个案子没登记 N？本条判据在空跑）').toBeTruthy();
    return row!;
  }

  it('🔴 首诊里写着"我已经发了被迫解除通知" ⇒ N-2b 仍是「缺失」（变异：判定里去掉这道排除 → 红）', () => {
    submitIntake(`${NARRATIVE}。当时 HR 说会给个说法，到现在也没有。`);
    // 【前提要自证】那条事件真的按「我方动作」落库了——否则本条判据验的是"根本没这条记录"
    const ev = db
      .prepare("SELECT kind, title FROM timeline_events WHERE case_id = ? AND kind = '我方动作'")
      .all(caseId) as { kind: string; title: string }[];
    expect(ev.length, '首诊那段自述没落成一条「我方动作」，本条判据在空跑').toBe(1);
    expect(ev[0].title).toBe(LABOR.copy.site.intakeFreeTextTitle);

    const row = n2b();
    expect(row.status, `首诊那段自述把 N-2b 抬成了 ${row.status}`).toBe('缺失');
    expect(row.missingSlots.join('｜'), '缺口没告诉他该把这件事记成一条时间线事件').toContain('时间线事件');
  });

  it('同一段话经 timeline_add 显式记成一条事件 ⇒ 成立·待证（这道排除不是"这句话一律不认"）', () => {
    submitIntake(`${NARRATIVE}。当时 HR 说会给个说法，到现在也没有。`);
    const added = call('timeline_add', alice, {
      case_id: caseId,
      happened_at: '2026-09-01T02:00:00Z',
      kind: '我方动作',
      title: NARRATIVE,
    });
    expect(added.ok, `事件没记进去：${JSON.stringify(added)}`).toBe(true);
    const row = n2b();
    expect(row.status, `显式记了那条事件，N-2b 还是 ${row.status}`).toBe('成立·待证');
    expect(row.missingSlots).toEqual([]);
  });
});
