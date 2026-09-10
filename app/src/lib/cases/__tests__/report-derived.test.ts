// app/src/lib/cases/__tests__/report-derived.test.ts
// 报告「争议焦点」「风险与未定项」两节改成**派生集**之后的判据（S6 判据三的落地面）。
//
// 三件事，缺一个这套东西就不成立：
//   ① 两节真的由要件表派生（条目带 `〔争点 id〕` 标记，且 id 就是要件 id）；
//   ② 改措辞放行、增删条目回 REPORT_SECTION_DERIVED（"模型只改措辞"这句话要有牙）；
//   ③ 本领域没有要件卡 / 本案没有诉求时，退回原来的写法并**明说它不是派生的**
//      （静默退回的形态是：一节读起来完全正常，而"它是机器派生的"这个前提已经不成立了）。
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, test } from 'vitest';

process.env.LAWER_DATA_KEY = Buffer.alloc(32, 9).toString('base64');

import { encryptField } from '@/lib/crypto';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

import { issueMarker, issueMarkersIn } from '../issue-table';
import { bootstrapReport, getReport, updateSection } from '../report';

const LABOR = DOMAINS[DEFAULT_DOMAIN];
const DISPUTES = LABOR.reportSections.find((s) => s.source === 'disputes')!.title;
const RISKS = LABOR.reportSections.find((s) => s.source === 'risks')!.title;

let db: Database;
let uid: number;
let caseId: number;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(
    db
      .prepare(
        `INSERT INTO users (phone_hash, real_name_enc, id_card_enc, auth_status, cert_type)
         VALUES ('h', ?, ?, '已实名', '身份证')`,
      )
      .run(encryptField('张三'), encryptField('110101199001011234')).lastInsertRowid,
  );
  caseId = Number(
    db
      .prepare(
        `INSERT INTO cases (user_id, title, stage, employed_from, monthly_wage_fen, position, contract_count)
         VALUES (?, '一个真有诉求的案子', '仲裁准备', '2020-03-01', 2500000, '后端工程师', '续签过一次')`,
      )
      .run(uid).lastInsertRowid,
  );
});

afterEach(() => db.close());

/** 登记一条诉求（金额 0，登记本身就够触发要件表了）。 */
function addClaim(kind: string) {
  db.prepare("INSERT INTO claims (case_id, kind, amount_fen, status) VALUES (?, ?, 0, 'draft')").run(caseId, kind);
}

function sections() {
  const r = getReport(db, { caseId, userId: uid });
  if (!r.ok) throw new Error('报告读不出来');
  return r.report;
}

describe('① 两节由要件表派生', () => {
  test('登记一条 2N 之后，「争议焦点」的条目就是这项诉求的要件（标记 id = 要件 id）', () => {
    addClaim('2N');
    const text = sections().sections[DISPUTES];
    const marks = issueMarkersIn(text);
    const wanted = (LABOR.elementCards ?? []).filter((c) => c.claimKind === '2N').map((c) => c.id);
    expect(marks.size, `派生出来的条目：${[...marks].join('、')}`).toBeGreaterThan(0);
    for (const id of marks) expect(wanted, `${id} 不是 2N 的要件`).toContain(id);
    // 每条都带下一步：只报争点不给出路等于把人堵在原地
    expect(text).toContain('下一步：');
  });

  test('「风险与未定项」只收还没立住的那几条（已成立的要件不是未定项）', () => {
    addClaim('欠薪');
    const s = sections();
    const risk = issueMarkersIn(s.sections[RISKS]);
    const dispute = issueMarkersIn(s.sections[DISPUTES]);
    expect(risk.size).toBeGreaterThan(0);
    // 未定项 ⊆ 争点（两节用同一套 id，风险节是争点的子集）
    for (const id of risk) expect([...dispute], `${id} 在风险节里却不在争点表里`).toContain(id);
  });

  test('对方的书面决定进档之后，已经「成立」但举证责任在对方的那一条仍留在争点表（规则三）', () => {
    addClaim('2N');
    // 传一份「公司文件」类的材料：领域包声明的 counterpartyDecisionSlot 就是它。
    const fileId = Number(
      db
        .prepare("INSERT INTO files (sha256, size, mime, enc_path) VALUES ('sha-1', 1, 'application/pdf', '/dev/null')")
        .run().lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO evidence (case_id, user_id, file_id, name, category, status)
       VALUES (?, ?, ?, '解除通知.pdf', '公司文件', '已上传')`,
    ).run(caseId, uid, fileId);
    // 报告是惰性生成的，重生成一份才看得到新档案
    db.prepare('DELETE FROM case_reports WHERE case_id = ?').run(caseId);
    const text = sections().sections[DISPUTES];

    // 【这一条是三条规则里唯一分得开的那个样本】2N-3（解除理由）的槽位就是那份公司文件，
    // 传进来之后它的状态变成「成立」——规则一不再捞它。它还留在表上，只可能是规则三捞的：
    // 举证责任在对方 ∧ 对方那份写着理由的纸已经在档 ⇒ 那张纸上写的理由就是要打的那一点。
    const card = (LABOR.elementCards ?? []).find((c) => c.id === '2N-3')!;
    expect(card.burden).toBe('reversed_interpretation');
    expect(text).toContain(`${issueMarker('2N-3')}`);
    // 而且它是以「成立」的状态留在表上的（不是又变回缺失）
    expect(text).toMatch(new RegExp(`${issueMarker('2N-3')}[^\\n]*成立`));

    // 【反臂】把那份材料作废掉（作废 = 从所有对外视图里摘出去），规则三的条件当场不成立：
    // 2N-3 退回「缺失」并改由规则一捞——两种情形下它都在表上，但**理由不同**，
    // 而"理由不同"正是这条判据要分辨的东西（合并成一个 boolean 就分不出来了）。
    db.prepare("UPDATE evidence SET voided_at = datetime('now'), void_reason = '测试作废' WHERE case_id = ?").run(caseId);
    db.prepare('DELETE FROM case_reports WHERE case_id = ?').run(caseId);
    expect(sections().sections[DISPUTES]).toMatch(new RegExp(`${issueMarker('2N-3')}[^\\n]*缺失`));
  });

  test('没有登记任何诉求时退回原写法，并明说这一节不是派生的', () => {
    const text = sections().sections[DISPUTES];
    expect(issueMarkersIn(text).size).toBe(0);
    expect(text).toContain('（档案里还没有这一项）');
  });
});

describe('② 派生集只许改措辞，不许增删条目', () => {
  test('把条目改写成人话、标记留着 ⇒ 放行', () => {
    addClaim('2N');
    const before = sections();
    const ids = [...issueMarkersIn(before.sections[DISPUTES])];
    const rewritten = ids.map((id) => `- ${issueMarker(id)} 这一条我用大白话重写了一遍，意思不变。`).join('\n');
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: DISPUTES,
      content: rewritten,
      reason: '把机械句式改成人话',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(r.ok, r.ok ? '' : `${r.errorCode}：${r.message}`).toBe(true);
  });

  test('多写一条争点 ⇒ REPORT_SECTION_DERIVED（发明争点）', () => {
    addClaim('2N');
    const before = sections();
    const content = `${before.sections[DISPUTES]}\n- ${issueMarker('我自己想出来的争点')}这条库里没有`;
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: DISPUTES,
      content,
      reason: '试图加一条',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('REPORT_SECTION_DERIVED');
    expect(r.status).toBe(400);
    expect(r.message).toContain('发明争点');
    // 拒了就必须**真的没写进去**：回一个错误码却照样落库，是这套东西最坏的形态
    expect(sections().sections[DISPUTES]).toBe(before.sections[DISPUTES]);
  });

  test('少写一条争点 ⇒ REPORT_SECTION_DERIVED（漏答）', () => {
    addClaim('2N');
    const before = sections();
    const ids = [...issueMarkersIn(before.sections[DISPUTES])];
    expect(ids.length).toBeGreaterThan(1);
    const content = ids.slice(1).map((id) => `- ${issueMarker(id)}留下的这几条`).join('\n');
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: DISPUTES,
      content,
      reason: '试图删一条',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('REPORT_SECTION_DERIVED');
    expect(r.message).toContain('漏答');
  });

  test('派生集为空时也要比对：本案一条派生争点都没有 ⇒ 写入自造争点被拒（变异：把闸改回 if (before.size > 0) → 红）', () => {
    // 【为什么这一格此前是空的】原来的闸只在"已存内容里 ≥1 个标记"时才启动。
    // 派生集为空的那一段（本案还没登记诉求，或要件全部成立）已存内容里一个标记都没有，
    // 于是模型可以往「争议焦点」里写三条自造争点、带上伪标记，200 落库。
    // **空集不是"这道闸不适用"，它是一个要对齐的集合。**
    // 这里用"还没登记诉求"这一形态：labor 的 2N-1/N-1 挂着 basics:employed_from（恒自述档），
    // 所以"要件全部成立"在本领域今天到不了，两者走的是同一个分支（before.size === 0）。
    const before = sections();
    expect(issueMarkersIn(before.sections[DISPUTES]).size, '这个案子不该有派生争点').toBe(0);
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: DISPUTES,
      content: `- ${issueMarker('我自己想出来的争点')}公司还涉嫌偷税漏税\n- ${issueMarker('2N-3')}解除理由存疑`,
      reason: '把我判断出来的争点写进去',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('REPORT_SECTION_DERIVED');
    expect(r.message).toContain('发明争点');
    expect(r.message, '没说清这一节此刻只能是空集').toContain('空集');
    expect(sections().sections[DISPUTES]).toBe(before.sections[DISPUTES]);
  });

  test('条目区里追加一条不带标记的 bullet ⇒ REPORT_SECTION_DERIVED（变异：删掉 strayDerivedBullets 那道闸 → 红）', () => {
    // 【为什么标记集合那把尺拦不住它】追加的那一条**没有标记**，所以增删比对一个字都没变，
    // 而页面上确实多了一条争点（复审 2026-09-10 第四条的第二个失败样本）。
    addClaim('2N');
    const before = sections();
    expect(issueMarkersIn(before.sections[DISPUTES]).size).toBeGreaterThan(0);
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: DISPUTES,
      content: `${before.sections[DISPUTES]}\n- 另外公司还涉嫌未足额缴纳公积金，这一点也要一起提`,
      reason: '顺手补一条',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('REPORT_SECTION_DERIVED');
    expect(r.message).toContain('不带 〔争点 …〕 标记');
    // 三段式：缺什么 / 为什么缺 / 怎么办
    for (const part of ['缺什么', '为什么缺', '怎么办']) {
      expect(r.message, `错误里没有「${part}」这一段`).toContain(part);
    }
    expect(sections().sections[DISPUTES]).toBe(before.sections[DISPUTES]);
  });

  test('反臂：说明写在第一条条目之前、或缩进成子行 ⇒ 放行（这道闸不是"派生节从此不许写字"）', () => {
    addClaim('2N');
    const before = sections();
    const ids = [...issueMarkersIn(before.sections[DISPUTES])];
    const content = [
      '- 这一节的条目由服务端从要件表派生，我只把措辞改成了人话。',
      ...ids.map((id) => `- ${issueMarker(id)} 用大白话重写的一条\n  - 下一步：先去把那份材料找出来`),
    ].join('\n');
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: DISPUTES,
      content,
      reason: '改写成人话，说明写在条目之前',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(r.ok, r.ok ? '' : `${r.errorCode}：${r.message}`).toBe(true);
  });

  test('「风险与未定项」也是派生节：初稿本身放行，节末追加无标记条目被拒', () => {
    // 风险节的初稿本来就以几行说明开头（固定条目、缺口清单），所以这道闸必须
    // 从**第一条带标记的条目**起算——整节数的形态是初稿自己就违规，闸从上线第一天起就得关掉。
    addClaim('欠薪');
    const before = sections();
    const passthrough = updateSection(db, {
      caseId,
      userId: uid,
      section: RISKS,
      content: before.sections[RISKS],
      reason: '原样写回，验证初稿自己不违规',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(passthrough.ok, passthrough.ok ? '' : `${passthrough.errorCode}：${passthrough.message}`).toBe(true);

    const now = sections();
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: RISKS,
      content: `${now.sections[RISKS]}\n- 另外我判断公司大概率会主张你自己辞职`,
      reason: '顺手补一条风险',
      baseVersion: now.version,
      updatedBy: 'agent',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('REPORT_SECTION_DERIVED');
  });

  test('不带标记的普通节照旧可改（这把尺只管派生集，不是把整份报告锁死）', () => {
    addClaim('2N');
    const before = sections();
    const other = LABOR.reportSections.find((s) => s.source === 'positions')!.title;
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: other,
      content: '- 目标：把四项一起提\n- 底线：不接受净身出户',
      reason: '补一下立场',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(r.ok, r.ok ? '' : `${r.errorCode}：${r.message}`).toBe(true);
  });
});

describe('③ 地板：初稿真的生成了（空报告会让上面每一条永远绿）', () => {
  test('bootstrap 之后两节都有内容', () => {
    addClaim('2N');
    const r = bootstrapReport(db, caseId);
    expect(r.ok).toBe(true);
    const s = sections();
    expect(s.sections[DISPUTES].length).toBeGreaterThan(50);
    expect(s.sections[RISKS].length).toBeGreaterThan(50);
  });
});
