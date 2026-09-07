// app/src/lib/__tests__/sensitive-exits.test.ts
// 敏感级的**三个出口**（设计稿 §16「敏感级」）：事实卡、分享/导出、转介包。
//
// 【这一组判据要拦的是同一类事故的三个化身】档案里写着**第三人**（来访者）的健康与心理
// 信息（个保法 §28）。它每经过一个出口就有一次泄露机会，而泄露的形态全是静默的：
//   · 分享页照常 200，页面上什么都不缺，只是多了一个手机号；
//   · 导出的 PDF 打开来一切正常，只是它现在在对方的电脑里；
//   · 转介包发到站外另一家机构，从此不在我们手里，而那个人从不知情。
// 三处各写一遍"记得脱敏"的形态是——**总有一个出口忘了**。所以三处读同一份声明
//（lib/sensitive.ts），本文件逐个出口验它真的读了。
//
// 【自证不空跑】每一条都配一条缺省领域（没有 sensitive 声明）的对照：
// 同样的输入在那边**逐字不变**。没有对照的形态是：把脱敏函数改成恒脱敏也照样全绿，
// 而那会让第一个领域的分享页从此把用户自己的手机号也洗掉。
import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as cases from '@/lib/cases';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS, DOMAINS_ENABLED_ENV } from '@/lib/domains/registry';
import { buildPacket } from '@/lib/referral/packet';
import { SENSITIVE_MASK, maskContacts, sensitivityOf, shareRedactorFor } from '@/lib/sensitive';
import { createShare, readShare } from '@/lib/shares';

const COUNSELING = DOMAINS.counseling;
/** 一个第三人的联系方式：这三串在任何一个出口露头都是事故。 */
const VISITOR_PHONE = '13900139001';
const VISITOR_ID = '110101199003074511';

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

// ───────────────────────── 声明本身 ─────────────────────────

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

  it('出口二的脱敏器把两类都洗：有形状的联系方式 + 本案登记的化名', () => {
    // 【为什么这两类要在同一个脱敏器里一起验】它们的来源不同——联系方式靠跨案件通用的
    // 规则认，化名靠**本案**登记的那份清单认。分成两处传参的形态是：某条出口只传了领域、
    // 忘了传化名清单，而它照常返回 200。这里验的是"拿到脱敏器就两类都洗"。
    const caseId = makeCase('counseling');
    db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?, ?)').run(caseId, '来访甲乙丙');
    const redactor = shareRedactorFor(db, caseId);
    const got = redactor.text(`来访甲乙丙的电话是 ${VISITOR_PHONE}`);
    expect(got.text).not.toContain('来访甲乙丙');
    expect(got.text).not.toContain(VISITOR_PHONE);
    expect(got.hits).toBe(2);
    expect(redactor.notice).toBe(COUNSELING.sensitive!.redactNotice);
  });

  it('长的化名先替：短名是长名的一截时不会把长名切碎', () => {
    // 「来访甲」与「来访甲乙丙」同案并存时，先替短的会在页面上留下「〔已脱敏〕乙丙」——
    // 那半截仍然指得到人，而两处都不报错。
    const caseId = makeCase('counseling');
    const ins = db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?, ?)');
    ins.run(caseId, '来访甲');
    ins.run(caseId, '来访甲乙丙');
    const got = shareRedactorFor(db, caseId).text('来访甲乙丙与来访甲不是同一个人');
    expect(got.text).not.toContain('乙丙');
    expect(got.text).toBe(`${SENSITIVE_MASK}与${SENSITIVE_MASK}不是同一个人`);
  });

  it('单字的登记名不参与替换（替了会把整份产物洗成读不成句）', () => {
    // 用户随手把对方记成「甲」时，替换会把正文里每一个「甲」都换掉：「甲方」→「〔已脱敏〕方」。
    // 漏掉一个单字化名的代价是它留在页面上；替掉它的代价是整份文书作废、且看起来像系统坏了。
    const caseId = makeCase('counseling');
    db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?, ?)').run(caseId, '甲');
    expect(shareRedactorFor(db, caseId).text('甲方与乙方').text).toBe('甲方与乙方');
  });
});

// ───────────────────────── 出口二：免登录分享 ─────────────────────────

describe('出口二·免登录分享页：强制脱敏 + 印一句为什么', () => {
  /** 起一份带对方联系方式的文书。**内部件**（危机处置记录）省得再造发送后果那一栏。 */
  function draftWithPhone(caseId: number): number {
    const made = cases.writeDraft(db, {
      caseId,
      userId: uid,
      kind: '危机处置记录',
      title: '一份记录',
      body: `联系了 ${VISITOR_PHONE}，其身份证 ${VISITOR_ID}，未接。`,
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    return made.draft.id;
  }

  it('counseling 案件的文书分享：联系方式被换掉，且页面上带那句脱敏说明', () => {
    const caseId = makeCase('counseling');
    const draftId = draftWithPhone(caseId);
    const share = createShare(db, { userId: uid, draftId });
    if (!share.ok) throw new Error(JSON.stringify(share));

    const read = readShare(db, share.token);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.view.body, '来访者的手机号原样进了免登录分享页').not.toContain(VISITOR_PHONE);
    expect(read.view.body).not.toContain(VISITOR_ID);
    expect(read.view.body).toContain(SENSITIVE_MASK);
    // 【为什么脱敏之后还要印一句话】读的人看到一串占位却没有解释，会回头找当事人索要真值——
    // 脱敏挡住了数据，却把"索要真值"这件事推给了当事人本人。
    expect(read.view.redact_notice).toBe(COUNSELING.sensitive!.redactNotice);
  });

  it('缺省领域的同一份文书分享**逐字不变**，也不多印那句话（自证不是恒脱敏）', () => {
    const caseId = makeCase(DEFAULT_DOMAIN);
    const made = cases.writeDraft(db, {
      caseId,
      userId: uid,
      // 缺省领域里挑一份**不进对外清单**的（同上，省掉发送后果那一栏）
      kind: DOMAINS[DEFAULT_DOMAIN].docKinds.find(
        (k) => !DOMAINS[DEFAULT_DOMAIN].outboundDocKinds.includes(k),
      )!,
      title: '一份文书',
      body: `联系电话 ${VISITOR_PHONE}`,
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const share = createShare(db, { userId: uid, draftId: made.draft.id });
    if (!share.ok) throw new Error(JSON.stringify(share));
    const read = readShare(db, share.token);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.view.body).toContain(VISITOR_PHONE);
    expect(read.view.redact_notice).toBeNull();
  });

  // ───── 化名/编号这一格：notice 上写着它被替换了，那句话必须是真的 ─────
  //
  // 【为什么它单独占三条判据】这个领域的档案里，来访者的身份**就是那个化名或编号**
  //（§16：不收真实姓名，所以化名是唯一的身份标识）。分享页印的那句话逐字写着
  //「出现的化名或编号已替换为占位」——只洗联系方式不洗化名的形态是：
  // 页面上同时出现「来访甲乙丙」和一句声称它已被替换的说明，两边都不报错，
  // 而读的人会把这个真化名当成占位符。转介包那个出口早就在拦已登记的化名了
  //（走 companyTerms），三个出口里只有这一个漏着。
  it('已登记的来访化名在文书分享页上被换掉（notice 说它替换了，就必须真替换）', () => {
    const caseId = makeCase('counseling');
    db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?, ?)').run(caseId, '来访甲乙丙');
    const made = cases.writeDraft(db, {
      caseId,
      userId: uid,
      kind: '危机处置记录',
      title: '一份记录',
      body: '来访甲乙丙今天没有到场，电话未接。',
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const share = createShare(db, { userId: uid, draftId: made.draft.id });
    if (!share.ok) throw new Error(JSON.stringify(share));
    const read = readShare(db, share.token);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.view.body, '已登记的来访化名原样进了免登录分享页').not.toContain('来访甲乙丙');
    expect(read.view.body).toContain(SENSITIVE_MASK);
    expect(read.view.redact_notice).toBe(COUNSELING.sensitive!.redactNotice);
  });

  it('证据分享的材料名与明细里的化名同样被换掉（两条路读同一份化名清单）', () => {
    const caseId = makeCase('counseling');
    db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?, ?)').run(caseId, '来访甲乙丙');
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
        .run(caseId, uid, fileId, '与来访甲乙丙的通话录音', '录音', '已上传', '来访甲乙丙口头承认', '手机录音')
        .lastInsertRowid,
    );
    const share = createShare(db, { userId: uid, evidenceId: evId });
    if (!share.ok) throw new Error(JSON.stringify(share));
    const read = readShare(db, share.token);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.view.title, '材料名里的化名没被洗').not.toContain('来访甲乙丙');
    expect(JSON.stringify(read.view.meta)).not.toContain('来访甲乙丙');
  });

  it('缺省领域登记的对方名字**不洗**（自证这道化名替换不是恒发生）', () => {
    // 那个领域的对面是一家公司，公司名正是分享页要给对方看的东西——
    // 把它也洗掉的形态是：用户分享一份文书给对方律师，正文里对面叫〔已脱敏〕。
    const caseId = makeCase(DEFAULT_DOMAIN);
    db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?, ?)').run(caseId, '蓝海科技有限公司');
    const made = cases.writeDraft(db, {
      caseId,
      userId: uid,
      kind: DOMAINS[DEFAULT_DOMAIN].docKinds.find(
        (k) => !DOMAINS[DEFAULT_DOMAIN].outboundDocKinds.includes(k),
      )!,
      title: '一份文书',
      body: '蓝海科技有限公司至今没有答复。',
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const share = createShare(db, { userId: uid, draftId: made.draft.id });
    if (!share.ok) throw new Error(JSON.stringify(share));
    const read = readShare(db, share.token);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.view.body).toContain('蓝海科技有限公司');
  });

  it('证据分享：材料名与每一条明细都过同一道脱敏（变异：只洗明细不洗标题 → 红）', () => {
    const caseId = makeCase('counseling');
    const fileId = Number(
      db
        .prepare(
          `INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, ?, ?, ?)`,
        )
        .run('a'.repeat(64), 1, 'audio/mp4', '/dev/null').lastInsertRowid,
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
          `与 ${VISITOR_PHONE} 的通话录音`,
          '录音',
          '已上传',
          `对方（${VISITOR_PHONE}）口头承认`,
          '手机录音',
        ).lastInsertRowid,
    );
    const share = createShare(db, { userId: uid, evidenceId: evId });
    if (!share.ok) throw new Error(JSON.stringify(share));
    const read = readShare(db, share.token);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.view.title, '材料名里的号码没被洗').not.toContain(VISITOR_PHONE);
    expect(JSON.stringify(read.view.meta)).not.toContain(VISITOR_PHONE);
    expect(read.view.redact_notice).toBe(COUNSELING.sensitive!.redactNotice);
  });
});

// ───────────────────────── 出口三：转介数据包 ─────────────────────────

describe('出口三·转介数据包：不含来访者信息', () => {
  /** 一个把原料原样抄回来的假模型——它就是"模型第十次照抄了号码"那一次。 */
  const parrotLlm = {
    chatJSON: async (msgs: { role: string; content: string }[]) =>
      JSON.stringify({ summary: `来访 ${VISITOR_PHONE} 情绪很差。${msgs[0].content.slice(0, 0)}` }),
  };

  it('模型把来访者手机号抄进摘要 ⇒ 出口这道脱敏照样把它挡下来', async () => {
    const caseId = makeCase('counseling');
    const packet = await buildPacket(db, {
      caseId,
      userId: uid,
      stage: COUNSELING.stages[1],
      reason: `对方（${VISITOR_PHONE}）投诉后我一直睡不好`,
      needs: [`想聊聊，联系我 ${VISITOR_PHONE}`],
      consentAt: '2026-09-07T00:00:00Z',
      llm: parrotLlm,
    });
    const whole = JSON.stringify(packet);
    expect(whole, '来访者的手机号进了发往站外的数据包').not.toContain(VISITOR_PHONE);
    expect(packet.emotion_summary).toContain(SENSITIVE_MASK);
  });

  it('已登记的来访化名也出不去（走既有的中立化过滤，不是本票新加的第二道）', async () => {
    const caseId = makeCase('counseling');
    db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?, ?)').run(caseId, '来访甲乙丙');
    const packet = await buildPacket(db, {
      caseId,
      userId: uid,
      stage: COUNSELING.stages[1],
      reason: '来访甲乙丙的事让我很焦虑',
      needs: [],
      consentAt: '2026-09-07T00:00:00Z',
      llm: { chatJSON: async () => JSON.stringify({ summary: '来访甲乙丙最近状态很差。' }) },
    });
    expect(JSON.stringify(packet)).not.toContain('来访甲乙丙');
  });

  it('敏感级案件的 system prompt 里多一句「不得出现第三人信息」（变异：删掉那段追加 → 红）', async () => {
    const caseId = makeCase('counseling');
    const seen: string[] = [];
    await buildPacket(db, {
      caseId,
      userId: uid,
      stage: COUNSELING.stages[0],
      reason: '想找人聊聊',
      needs: [],
      consentAt: '2026-09-07T00:00:00Z',
      llm: {
        chatJSON: async (msgs) => {
          seen.push(msgs[0].content);
          return JSON.stringify({ summary: '最近睡不好。' });
        },
      },
    });
    expect(seen[0]).toContain('本案属敏感级');
    // 称呼由领域包给，共用层不写死一个词
    expect(seen[0]).toContain(COUNSELING.sensitive!.subject);
  });

  it('缺省领域的案子：system prompt 不多那一句，摘要也不过第二道脱敏（自证不是恒发生）', async () => {
    const caseId = makeCase(DEFAULT_DOMAIN);
    const seen: string[] = [];
    const packet = await buildPacket(db, {
      caseId,
      userId: uid,
      stage: DOMAINS[DEFAULT_DOMAIN].stages[0],
      reason: '想找人聊聊',
      needs: [],
      consentAt: '2026-09-07T00:00:00Z',
      llm: {
        chatJSON: async (msgs) => {
          seen.push(msgs[0].content);
          return JSON.stringify({ summary: `随时打我 ${VISITOR_PHONE}。` });
        },
      },
    });
    expect(seen[0]).not.toContain('本案属敏感级');
    // 第一个领域这条链路逐字不变：号码是用户**自己的**，洗掉它反而让对方联系不上
    expect(packet.emotion_summary).toContain(VISITOR_PHONE);
  });
});
