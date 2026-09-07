// app/src/lib/__tests__/sensitive-exits.test.ts
// 敏感级出口二（设计稿 §16「分享/导出对来访者信息强制脱敏」）。
//
// 【它拦的是一句写在产物上的假话】声明了敏感级的领域，分享页与导出 PDF 上逐字印着
// `redactNotice`：「出现的化名或编号已替换为占位」。而在这一票之前，出口上一个字都没洗——
// 页面照常 200、正文完整、那句话还在。**读的人会把页面上那个真化名当成占位符**，
// 于是这句本意是保护第三人的说明，成了最有效的误导。
//
// 【为什么每一条都配一条缺省领域的对照】没有对照的形态是：把脱敏改成恒发生也照样全绿，
// 而那会让第一个领域的用户分享一份文书给对方律师时，正文里对面叫〔已脱敏〕。
import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as cases from '@/lib/cases';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS, DOMAINS_ENABLED_ENV } from '@/lib/domains/registry';
import { maskContacts, SENSITIVE_MASK, sensitivityOf, shareRedactorFor } from '@/lib/sensitive';
import { createShare, readShare } from '@/lib/shares';

const COUNSELING = DOMAINS.counseling;
const LABOR_PACK = DOMAINS[DEFAULT_DOMAIN];
/** 一个第三人的联系方式：这两串在任何一个出口露头都是事故。 */
const VISITOR_PHONE = '13900139001';
const VISITOR_ID = '110101199003074511';
/** 首诊那一格里填的来访化名（问法逐字写着「填化名或来访编号，不要填真实姓名」）。 */
const VISITOR_ALIAS = '来访甲乙丙';

let db: Database.Database;
let uid: number;

beforeAll(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
});

beforeEach(() => {
  process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN},counseling`;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('sens').lastInsertRowid);
});

function makeCase(domain: string): number {
  const made = cases.ensureDefaultCase(db, uid, domain);
  if ('ok' in made) throw new Error(`建案失败：${JSON.stringify(made)}`);
  return made.caseId;
}

/**
 * **走真首诊**把对方称呼登记进去，不手写 company_profiles。
 *
 * 【为什么判据要接产线那条路】手写一行 `INSERT INTO company_profiles` 验出来的是
 * 「表里有这个名字就洗得掉」，而产线上没有人手写这张表：化名是首诊那一格
 *（`company_name`，问法逐字写着"填化名或来访编号"）落进来的。
 * 首诊哪天改成落在另一个角色位上，手写版判据照样绿，而分享页从此原样印着化名。
 */
function intakeWithAlias(caseId: number, domain: string, alias: string): void {
  const pack = DOMAINS[domain];
  const done = cases.submitIntake(db, {
    caseId,
    userId: uid,
    stage: pack.stages[0],
    companyName: alias,
    employedFrom: '2024-03-01',
    monthlyWageFen: 800000,
    goals: ['把这件事了结'],
  });
  if (!done.ok) throw new Error(`首诊失败：${JSON.stringify(done)}`);
}

/** 起一份**内部件**（不进对外清单，省掉「发送后果」那一栏）。 */
function writeInternalDraft(caseId: number, domain: string, body: string): number {
  const pack = DOMAINS[domain];
  const kind = pack.docKinds.find((k) => !pack.outboundDocKinds.includes(k));
  if (!kind) throw new Error(`${domain} 没有内部件可用`);
  const made = cases.writeDraft(db, { caseId, userId: uid, kind, title: '一份记录', body });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.draft.id;
}

function sharedBodyOf(draftId: number): { body: string | null; notice: string | null } {
  const share = createShare(db, { userId: uid, draftId });
  if (!share.ok) throw new Error(JSON.stringify(share));
  const read = readShare(db, share.token);
  if (read.state !== 'ok') throw new Error(`读分享失败：${read.state}`);
  return { body: read.view.body, notice: read.view.redact_notice };
}

// ───────────────────────── 声明与脱敏器本身 ─────────────────────────

describe('敏感级声明的读法', () => {
  it('声明了的领域取得到，没声明的回 null（不是抛错，也不是回一个空壳）', () => {
    expect(sensitivityOf('counseling')).toBe(COUNSELING.sensitive);
    expect(sensitivityOf(DEFAULT_DOMAIN)).toBeNull();
  });

  it('domain 写坏的行按缺省领域算（读路径不该让人连自己的分享都打不开）', () => {
    // 现行政策写在 lib/sensitive.sensitivityOf 的注释里：要改成"取不到就按最严处理"，改那一行。
    expect(sensitivityOf('从没注册过的领域')).toBeNull();
    expect(sensitivityOf(null)).toBeNull();
  });

  it('识别规则与出境脱敏同源：手机号的分段写法也认（变异：把分段那一种删掉 → 红）', () => {
    expect(maskContacts(`联系人 ${VISITOR_PHONE}`).text).not.toContain(VISITOR_PHONE);
    expect(maskContacts('联系人 139 0013 9001').text).toContain(SENSITIVE_MASK);
    expect(maskContacts(`身份证 ${VISITOR_ID}`).text).not.toContain(VISITOR_ID);
    // 只报条数不报值：报值等于在同一份产物里附上一张原文清单
    expect(maskContacts(`${VISITOR_PHONE} 与 ${VISITOR_ID}`).hits).toBe(2);
  });

  it('没声明敏感级的领域，同一段文本**逐字不变**（自证脱敏不是恒发生）', () => {
    const raw = `联系人 ${VISITOR_PHONE}`;
    const redactor = shareRedactorFor(db, makeCase(DEFAULT_DOMAIN));
    expect(redactor.text(raw).text).toBe(raw);
    expect(redactor.notice).toBeNull();
  });

  it('脱敏器把两类都洗：有形状的联系方式 + 首诊登记的化名', () => {
    // 【为什么两类要在同一个脱敏器里一起验】来源不同：联系方式靠跨案件通用的规则认，
    // 化名靠**本案**登记的那份清单认。分成两个参数各传一次的形态是：
    // 某条出口只传了领域、忘了传化名清单，而它照常返回 200。
    const caseId = makeCase('counseling');
    intakeWithAlias(caseId, 'counseling', VISITOR_ALIAS);
    const got = shareRedactorFor(db, caseId).text(`${VISITOR_ALIAS}的电话是 ${VISITOR_PHONE}`);
    expect(got.text).not.toContain(VISITOR_ALIAS);
    expect(got.text).not.toContain(VISITOR_PHONE);
    expect(got.hits).toBe(2);
  });

  it('首诊登记的化名落在 aliasRoles 覆盖得到的角色位上（变异：把 aliasRoles 改成别的角色 → 红）', () => {
    // 【为什么这条要单独钉】`aliasRoles` 是一份**按名字对**的清单：写了一个库里对不上的
    // 角色名时，`role IN (...)` 照常返回 0 行、脱敏器照常构造出来、分享页照常 200——
    // 只是从此一个化名都不洗，而页脚那句话仍写着"化名或编号已替换为占位"。
    const caseId = makeCase('counseling');
    intakeWithAlias(caseId, 'counseling', VISITOR_ALIAS);
    const row = db
      .prepare('SELECT role FROM company_profiles WHERE case_id = ? AND name = ?')
      .get(caseId, VISITOR_ALIAS) as { role: string } | undefined;
    expect(row, '首诊没有把对方称呼落进 company_profiles').toBeDefined();
    expect(
      COUNSELING.sensitive!.aliasRoles,
      `首诊把化名落在「${row?.role}」，而 aliasRoles 里没有这一格 ⇒ 化名从此不洗`,
    ).toContain(row!.role);
    // 声明的每一格都得是真存在的角色（打错一个字＝那一行永不匹配）
    for (const role of COUNSELING.sensitive!.aliasRoles) {
      expect(cases.COMPANY_ROLES as readonly string[]).toContain(role);
    }
  });

  it('同案登记在**别的角色位**上的名字不洗（变异：去掉 role 过滤 → 红）', () => {
    // 【它拦的是哪一次事故】不分角色一律洗的形态是——用户导出一份要寄给平台的投诉答复函，
    // 抬头成了「致〔已脱敏〕」、抄送栏也是〔已脱敏〕，而 PDF 照常生成、HTTP 200，
    // 页脚还印着一句「出现的化名或编号已替换为占位」。产物废了，三处都说一切正常。
    const caseId = makeCase('counseling');
    intakeWithAlias(caseId, 'counseling', VISITOR_ALIAS);
    const other = (cases.COMPANY_ROLES as readonly string[]).find(
      (r) => !COUNSELING.sensitive!.aliasRoles.includes(r),
    )!;
    const made = cases.upsertCompany(db, {
      caseId,
      userId: uid,
      name: '简单心理平台',
      role: other,
    });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const got = shareRedactorFor(db, caseId).text(
      `致简单心理平台：关于${VISITOR_ALIAS}的投诉，现答复如下。`,
    );
    expect(got.text, '来访者的化名没被洗').not.toContain(VISITOR_ALIAS);
    expect(got.text, '收件机构的全称被一并洗掉了，这份答复函寄不出去').toContain('简单心理平台');
    expect(got.hits, '只该洗掉化名那一处').toBe(1);
  });

  it('长的化名先替：短名是长名的一截时不会把长名切碎', () => {
    // 「来访甲」与「来访甲乙丙」同案并存时，先替短的会在页面上留下「〔已脱敏〕乙丙」——
    // 那半截仍然指得到人，而两处都不报错。
    const caseId = makeCase('counseling');
    intakeWithAlias(caseId, 'counseling', VISITOR_ALIAS);
    const role = COUNSELING.sensitive!.aliasRoles[0];
    db.prepare('INSERT INTO company_profiles (case_id, name, role) VALUES (?, ?, ?)').run(
      caseId,
      '来访甲',
      role,
    );
    const got = shareRedactorFor(db, caseId).text(`${VISITOR_ALIAS}与来访甲不是同一个人`);
    expect(got.text).not.toContain('乙丙');
    expect(got.text).toBe(`${SENSITIVE_MASK}与${SENSITIVE_MASK}不是同一个人`);
  });

  it('单字的登记名不参与替换（替了会把整份产物洗成读不成句）', () => {
    // 用户随手把对方记成「甲」时，替换会把正文里每一个「甲」都换掉：「甲方」→「〔已脱敏〕方」。
    // 漏掉一个单字化名的代价是它留在页面上；替掉它的代价是整份文书作废、且看起来像系统坏了。
    const caseId = makeCase('counseling');
    intakeWithAlias(caseId, 'counseling', '甲');
    expect(shareRedactorFor(db, caseId).text('甲方与乙方').text).toBe('甲方与乙方');
  });
});

// ───────────────────────── 出口二·免登录分享页 ─────────────────────────

describe('免登录分享页：强制脱敏 + 印一句为什么', () => {
  it('counseling 的文书分享：**首诊登记的化名**不出现在分享文本里（变异：拿掉 readShare 的脱敏 → 红）', () => {
    const caseId = makeCase('counseling');
    intakeWithAlias(caseId, 'counseling', VISITOR_ALIAS);
    const draftId = writeInternalDraft(
      caseId,
      'counseling',
      `${VISITOR_ALIAS}今天没有到场，电话 ${VISITOR_PHONE} 未接，身份证 ${VISITOR_ID}。`,
    );
    const got = sharedBodyOf(draftId);
    expect(got.body, '首诊登记的来访化名原样进了免登录分享页').not.toContain(VISITOR_ALIAS);
    expect(got.body, '来访者的手机号原样进了免登录分享页').not.toContain(VISITOR_PHONE);
    expect(got.body).not.toContain(VISITOR_ID);
    expect(got.body).toContain(SENSITIVE_MASK);
    // 【为什么脱敏之后还要印一句话】读的人看到一串占位却没有解释，会回头找当事人索要真值——
    // 脱敏挡住了数据，却把"索要真值"这件事推给了当事人本人。
    expect(got.notice).toBe(COUNSELING.sensitive!.redactNotice);
  });

  it('缺省领域的同一份文书分享**逐字不变**，也不多印那句话（自证不是恒脱敏）', () => {
    const caseId = makeCase(DEFAULT_DOMAIN);
    intakeWithAlias(caseId, DEFAULT_DOMAIN, '蓝海科技有限公司');
    const body = `蓝海科技有限公司的联系电话 ${VISITOR_PHONE}`;
    const draftId = writeInternalDraft(caseId, DEFAULT_DOMAIN, body);
    const got = sharedBodyOf(draftId);
    // 那个领域的对面是一家公司，公司名正是分享页要给对方看的东西——
    // 把它也洗掉的形态是：用户分享一份文书给对方律师，正文里对面叫〔已脱敏〕。
    expect(got.body).toBe(body);
    expect(got.notice).toBeNull();
  });

  it('证据分享的材料名与明细里的化名同样被换掉（两条路读同一份化名清单）', () => {
    const caseId = makeCase('counseling');
    intakeWithAlias(caseId, 'counseling', VISITOR_ALIAS);
    const fileId = Number(
      db
        .prepare('INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, ?, ?, ?)')
        .run('b'.repeat(64), 1, 'audio/mp4', '/dev/null').lastInsertRowid,
    );
    const evId = Number(
      db
        .prepare(
          `INSERT INTO evidence (case_id, user_id, file_id, name, category, status, prove_purpose, original_medium)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          caseId,
          uid,
          fileId,
          `与${VISITOR_ALIAS}的通话录音`,
          '录音',
          '已上传',
          `${VISITOR_ALIAS}口头承认`,
          '手机录音',
        ).lastInsertRowid,
    );
    const share = createShare(db, { userId: uid, evidenceId: evId });
    if (!share.ok) throw new Error(JSON.stringify(share));
    const read = readShare(db, share.token);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.view.title, '材料名里的化名没被洗').not.toContain(VISITOR_ALIAS);
    expect(JSON.stringify(read.view.meta)).not.toContain(VISITOR_ALIAS);
    expect(read.view.redact_notice).toBe(COUNSELING.sensitive!.redactNotice);
  });

  it('缺省领域的证据分享逐字不变（对照：材料名与明细都不许被动）', () => {
    const caseId = makeCase(DEFAULT_DOMAIN);
    intakeWithAlias(caseId, DEFAULT_DOMAIN, '蓝海科技有限公司');
    const fileId = Number(
      db
        .prepare('INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, ?, ?, ?)')
        .run('c'.repeat(64), 1, 'audio/mp4', '/dev/null').lastInsertRowid,
    );
    const evId = Number(
      db
        .prepare(
          `INSERT INTO evidence (case_id, user_id, file_id, name, category, status, prove_purpose, original_medium)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          caseId,
          uid,
          fileId,
          '与蓝海科技有限公司的通话录音',
          '录音',
          '已上传',
          '公司口头承认',
          '手机录音',
        ).lastInsertRowid,
    );
    const share = createShare(db, { userId: uid, evidenceId: evId });
    if (!share.ok) throw new Error(JSON.stringify(share));
    const read = readShare(db, share.token);
    if (read.state !== 'ok') throw new Error(read.state);
    expect(read.view.title).toBe('与蓝海科技有限公司的通话录音');
    expect(read.view.redact_notice).toBeNull();
  });

  it('LABOR 包没有敏感级声明（自证上面那几条对照不是"因为这个包也声明了"而绿）', () => {
    expect(LABOR_PACK.sensitive).toBeUndefined();
  });
});
