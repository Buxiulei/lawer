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

import { NEXT_STEP_FIX_DECISION, issueMarker, issueMarkersIn } from '../issue-table';
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

/** 传一份某个类别的材料进证据库（要件表与 counterpartyDecisionSlot 都按类别认它）。 */
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

/** 报告是惰性生成的：改完档案要把上一份丢掉，下次读才看得到新的初稿。 */
function regenerate() {
  db.prepare('DELETE FROM case_reports WHERE case_id = ?').run(caseId);
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
    // 领域包声明的 counterpartyDecisionSlot 是**两个槽**（第四轮 2026-09-10）：
    // 那张纸（「公司文件」类的材料）+ 公司确实作出过这个决定（时间线上的「公司动作」）。
    // 只传前者的形态见下面那条判据：一份员工手册也归「公司文件」，不该算作解除决定。
    addEvidence('公司文件', '解除通知.pdf');
    addTimeline('公司动作', '收到《解除劳动合同通知书》');
    // 报告是惰性生成的，重生成一份才看得到新档案
    regenerate();
    const text = sections().sections[DISPUTES];

    // 【这一条是三条规则里唯一分得开的那个样本】2N-3（解除理由）的槽位就是那两格，
    // 都到位之后它的状态变成「成立」——规则一不再捞它。它还留在表上，只可能是规则三捞的：
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
    regenerate();
    expect(sections().sections[DISPUTES]).toMatch(new RegExp(`${issueMarker('2N-3')}[^\\n]*缺失`));
  });

  test('一份员工手册不是解除决定：只有「公司文件」而没有那条公司动作 ⇒ 2N-3 仍是「缺失」，正文不印「把他那份书面决定固定下来」（第四轮 2026-09-10）', () => {
    // 【它守什么】「公司文件」是个很宽的类别（员工手册、规章制度、工资结构表都在它下面）。
    // 收窄成双槽之前，这一份手册让 2N-3 整条「成立」并恒进争点表，正文跟着让用户去固定
    // 一份档案里根本不存在的解除决定——报告返回 200，每一行都读得通。
    // 【变异臂】counterpartyDecisionSlot 改回单槽 ⇒ 下面那句 NEXT_STEP_FIX_DECISION 红；
    //          2N-3 的 satisfiedBy 去掉 timeline:公司动作 ⇒ 「缺失」那句红（它会变成「成立」）。
    addClaim('2N');
    addEvidence('公司文件', '员工手册.pdf');
    regenerate();
    const text = sections().sections[DISPUTES];
    expect(text, '一份员工手册把「解除不具备法定理由」顶成了成立').toMatch(
      new RegExp(`${issueMarker('2N-3')}[^\\n]*缺失`),
    );
    expect(text, '档案里没有那份解除决定，正文却让用户去把它「原样固定下来」').not.toContain(
      NEXT_STEP_FIX_DECISION,
    );

    // 【正臂】把那条「公司动作」补上（书证档），两格齐了：状态翻「成立」、那句话当场出现。
    // 没有这一臂，"规则三根本没接上"也会让上面两句绿。
    addTimeline('公司动作', '收到《解除劳动合同通知书》');
    regenerate();
    const after = sections().sections[DISPUTES];
    expect(after).toMatch(new RegExp(`${issueMarker('2N-3')}[^\\n]*成立`));
    expect(after).toContain(NEXT_STEP_FIX_DECISION);
  });

  test('自述档的公司动作只把 2N-3 抬到「成立·待证」（第四轮口径的报告层这一面）', () => {
    // 双槽取**最弱**的那一档：那张纸是书证、而"公司确实作出过这个决定"只有当事人自己说，
    // 于是这一条停在「成立·待证」——那句话是实话。
    //
    // 【口径本身的牙不在这一层，记在这里】规则三在自述档下该不该触发，观察点是争点行的
    // `reasons`（burden_on_other_side 在不在），而 reasons 只在 MCP 回包那一面原样露出；
    // 报告层只印措辞，且状态一旦是「成立·待证」，nextStep 就走「只有你自己的说法」那一支，
    // NEXT_STEP_FIX_DECISION 本来就印不出来——在这里写一句 not.toContain 是**空跑**。
    // 那条判据落在 lib/capabilities/__tests__/elements-family.test.ts（同名用例）。
    addClaim('2N');
    addEvidence('公司文件', '解除通知.pdf');
    addTimeline('公司动作', 'HR 口头通知我被裁了', '自述');
    regenerate();
    expect(
      sections().sections[DISPUTES],
      '两个槽里最弱的那一档是自述，这一条就该停在「成立·待证」',
    ).toMatch(new RegExp(`${issueMarker('2N-3')}[^\\n]*成立·待证`));
  });

  test('规则三这根线在报告层是接着的：对方那份书面决定不在档时 N-2a 不进「争议焦点」（变异：report.ts 的 onFile 改成常量 true → 红）', () => {
    // 【为什么钉 N-2a，而不是上面那条用例里的 2N-3】2N-3 的 satisfiedBy 就是领域包声明的
    // counterpartyDecisionSlot 那两个槽，于是"它成立"与"那份决定在档"永远同真同假：
    // 它恒在争点表上（不是被规则一捞的就是被规则三捞的），把 onFile 换成常量 true
    // 一个字都不会变。N-2a 不一样——它属于「任选其一」分组，同组那条路走通时它**不是代表行**，
    // 规则一捞不到它；这时它进不进表，只由规则三这一个条件决定。
    // **本用例的变异臂就落在下面那句 `not.toContain('N-2a')` 上**：onFile 恒真时它当场进表。
    addClaim('N');
    // 这个案子走的是路径二：沟通记录 + 时间线上「我方动作」（发出被迫解除通知）
    addEvidence('沟通记录', '与HR的聊天记录.pdf');
    addTimeline('我方动作', '发出被迫解除通知', '自述');
    regenerate();
    const text = sections().sections[DISPUTES];
    const marks = [...issueMarkersIn(text)];
    expect(marks, '前提不成立：路径二没走通，N-2a 就还是代表行').toContain('N-2b');
    expect(marks, '公司那份书面决定不在档，N-2a 却进了争点表').not.toContain('N-2a');
    expect(text, '没有那份决定，正文却印着「把他那份书面决定固定下来」').not.toContain(
      NEXT_STEP_FIX_DECISION,
    );

    // 【正臂】把那份决定与「公司动作」一并落档：路径一走通、由规则三留在表上，那句话当场出现。
    // 没有这一臂，"这条规则根本没接上"也会让上面两句绿。
    addEvidence('公司文件', '解除通知.pdf');
    addTimeline('公司动作', '收到解除通知');
    regenerate();
    const after = sections().sections[DISPUTES];
    expect([...issueMarkersIn(after)]).toContain('N-2a');
    expect(after).toContain(NEXT_STEP_FIX_DECISION);
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

  test('条目区里追加一条不带标记的 bullet ⇒ REPORT_SECTION_DERIVED（变异：删掉 derivedBulletStrays 那两把尺 → 红）', () => {
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

  test('反臂：说明写成正文、或缩进成子行 ⇒ 放行（这道闸不是"派生节从此不许写字"）', () => {
    addClaim('2N');
    const before = sections();
    const ids = [...issueMarkersIn(before.sections[DISPUTES])];
    const content = [
      '这一节的条目由服务端从要件表派生，我只把措辞改成了人话。',
      ...ids.map((id) => `- ${issueMarker(id)} 用大白话重写的一条\n  - 下一步：先去把那份材料找出来`),
    ].join('\n');
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: DISPUTES,
      content,
      reason: '改写成人话，说明写成正文',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(r.ok, r.ok ? '' : `${r.errorCode}：${r.message}`).toBe(true);
  });

  test('反臂：初稿原样写回恒放行（这一条塌了，上面每一条闸都得关掉）', () => {
    // 【为什么必须有这一条】这道闸的基线是"服务端此刻会生成的那份初稿"。
    // 基线取错的形态是：初稿自己就违规——那时唯一的收场是把闸关掉。
    // 三种形态各走一遍：有派生条目的、一条派生条目都没有的、以及本案诉求没有要件卡的。
    for (const [label, kind] of [
      ['有派生条目', '2N'],
      ['没有诉求', ''],
      ['诉求没有要件卡（labor 的年假）', '年假'],
    ] as const) {
      db.prepare('DELETE FROM claims WHERE case_id = ?').run(caseId);
      db.prepare('DELETE FROM case_reports WHERE case_id = ?').run(caseId);
      if (kind) addClaim(kind);
      for (const title of [DISPUTES, RISKS]) {
        const before = sections();
        const r = updateSection(db, {
          caseId,
          userId: uid,
          section: title,
          content: before.sections[title],
          reason: '原样写回，验证初稿自己不违规',
          baseVersion: before.version,
          updatedBy: 'agent',
        });
        expect(r.ok, r.ok ? '' : `${label}／${title}：${r.errorCode} ${r.message}`).toBe(true);
      }
    }
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

  test('派生集为空时写入**不带标记**的自造争点 ⇒ 拒（第二轮复审 2026-09-10 第一条：A 样本）', () => {
    // 【这一格此前是全开的】上一版的 stray 闸"从第一条带标记的条目起算"：
    // 一条带标记的条目都没有时（本案还没登记诉求）它直接返回空，标记集合比对又是 ∅==∅，
    // 于是模型往「争议焦点」里写两条不带标记的自造争点，200 落库。
    const before = sections();
    expect(issueMarkersIn(before.sections[DISPUTES]).size, '这个案子不该有派生争点').toBe(0);
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: DISPUTES,
      content: '- 公司还涉嫌偷税漏税，这一点也要一起提\n- 公司还涉嫌未足额缴纳公积金',
      reason: '把我判断出来的争点写进去',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('REPORT_SECTION_DERIVED');
    expect(r.message).toContain('不带 〔争点 …〕 标记');
    expect(sections().sections[DISPUTES]).toBe(before.sections[DISPUTES]);
  });

  test('把无标记条目插在第一条派生条目**之前** ⇒ 拒（第二轮复审 2026-09-10 第一条：B 样本）', () => {
    // 上一版从第一条带标记的条目起算，于是插在它前面的那一条跑掉了。
    addClaim('2N');
    const before = sections();
    expect(issueMarkersIn(before.sections[DISPUTES]).size).toBeGreaterThan(0);
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: DISPUTES,
      content: `- 公司还涉嫌偷税漏税，这一点也要一起提\n${before.sections[DISPUTES]}`,
      reason: '在最前面补一条',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('REPORT_SECTION_DERIVED');
    expect(r.message, '没说清它比初稿多').toContain('比服务端初稿里的还多');
    expect(sections().sections[DISPUTES]).toBe(before.sections[DISPUTES]);
  });

  test('「风险与未定项」在一条派生条目都没有时追加一条 ⇒ 拒（第二轮复审 2026-09-10 第一条：D 样本）', () => {
    // 风险节的初稿本来就带着几行顶格说明（固定条目、缺口清单），所以基线不是"零条"，
    // 而是**初稿里有几条**。多出一条就是发明争点，哪怕这一节此刻一个标记都没有。
    const before = sections();
    expect(issueMarkersIn(before.sections[RISKS]).size).toBe(0);
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: RISKS,
      content: `${before.sections[RISKS]}\n- 我判断公司会主张你自己辞职`,
      reason: '顺手补一条风险',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('REPORT_SECTION_DERIVED');
    expect(sections().sections[RISKS]).toBe(before.sections[RISKS]);
  });

  test('删掉一行说明、同时在节末追加一条自造条目 ⇒ 仍然拒（总数没变，靠"第一条条目之后"那把尺）', () => {
    // 【为什么要单钉这一条】"比初稿多"那把尺按条数比，条数一样它就不响。
    // 只有它的形态是：模型删掉一行说明、腾出一个名额，再在条目区里塞一条自造争点，200 落库。
    addClaim('2N');
    const before = sections();
    const lines = before.sections[DISPUTES].split('\n');
    const firstExplain = lines.findIndex((l) => /^-\s/.test(l) && !l.includes('〔争点'));
    expect(firstExplain, '初稿里没有顶格的说明行，这条用例的前提不成立').toBeGreaterThanOrEqual(0);
    const content = [
      ...lines.filter((_, i) => i !== firstExplain),
      '- 另外公司还涉嫌未足额缴纳公积金，这一点也要一起提',
    ].join('\n');
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: DISPUTES,
      content,
      reason: '删一行说明、补一条争点',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('REPORT_SECTION_DERIVED');
    expect(r.message, '报的不是"落在第一条派生条目之后"这把尺').toContain('第一条派生条目之后');
  });

  test('本案诉求没有要件卡时，这一节退回金额清单——照抄放行、多一条被拒', () => {
    // 【为什么不能按"整节里顶格无标记的行 >0 就拒"办】本领域有要件卡、而本案登记的诉求
    // 恰好没有要件卡（labor 的年假 / 加班费 / 年终奖都是这一类）时，这一节退回去印的是
    // 一份**顶格的金额清单**。整节计数 >0 就拒的形态是：这一节从上线第一天起就改不动。
    addClaim('年假');
    const before = sections();
    const ok = updateSection(db, {
      caseId,
      userId: uid,
      section: DISPUTES,
      content: before.sections[DISPUTES],
      reason: '原样写回',
      baseVersion: before.version,
      updatedBy: 'agent',
    });
    expect(ok.ok, ok.ok ? '' : `${ok.errorCode}：${ok.message}`).toBe(true);

    const now = sections();
    const r = updateSection(db, {
      caseId,
      userId: uid,
      section: DISPUTES,
      content: `${now.sections[DISPUTES]}\n- 另外公司还涉嫌未足额缴纳公积金`,
      reason: '顺手补一条',
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
