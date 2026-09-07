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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CitationGuard } from '@/lib/agent/citation-guard';
import { executeTool, newTurnState, type AgentToolContext } from '@/lib/agent/tools';
import * as cases from '@/lib/cases';
import { runMigrations } from '@/lib/db/migrate';
import {
  DEFAULT_DOMAIN,
  DOMAINS,
  DOMAINS_ENABLED_ENV,
  assertDomainPack,
  type DomainPack,
} from '@/lib/domains/registry';
import { buildPacket } from '@/lib/referral/packet';
import { SENSITIVE_MASK, maskContacts, sensitivityOf, shareRedactorFor } from '@/lib/sensitive';
import { createShare, readShare } from '@/lib/shares';

const COUNSELING = DOMAINS.counseling;

/**
 * 缺省领域（labor）在**改动前**（origin/main = 4098805）不点名角色时落哪一格。
 *
 * 【为什么不拿 DOMAINS[DEFAULT_DOMAIN].defaultCompanyRole 当判据】那是当前 HEAD 的字段，
 * 与被判定的实现同源：把包字段与判定一起改成另一个词，自比恒绿——判据在，行为已经变了。
 * 这里读的是从 4098805 副本逐字提取出来的常量（捕获器与提取方式见该文件 companyRole.说明）。
 */
const LABOR_COMPANY_ROLE_BASELINE = (
  JSON.parse(
    fs.readFileSync(
      path.join(
        fileURLToPath(new URL('.', import.meta.url)),
        '../domains/__tests__/labor-baseline.json',
      ),
      'utf-8',
    ),
  ) as {
    companyRole: {
      unnamedViaCases: string;
      unnamedViaAgentTool: string;
      unnamedAfterExistingOtherRole: string;
      invalidRoleViaAgentTool: string;
      nonStringRoleViaAgentTool: string;
      emptyStringRoleViaAgentTool: string;
      invalidRoleStillSavesRecord: boolean;
    };
  }
).companyRole;
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

  it('声明的 aliasRoles 必须是 company_profiles 真有的角色（打错一个字＝那一行永不匹配，化名从此不洗）', () => {
    // 这条钉的是"清单本身对不对得上表"：`role IN (...)` 里写了一个库里不存在的角色名时，
    // 查询照常返回 0 行、脱敏器照常构造出来、分享页照常 200 —— 只是从此一个化名都不洗，
    // 而页脚那句话仍然写着"化名或编号已替换为占位"。
    for (const pack of Object.values(DOMAINS)) {
      if (!pack.sensitive) continue;
      expect(pack.sensitive.aliasRoles.length, `${pack.key} 的 aliasRoles 是空的`).toBeGreaterThan(0);
      for (const role of pack.sensitive.aliasRoles) {
        expect(cases.COMPANY_ROLES as readonly string[], `${pack.key} 声明了不存在的角色「${role}」`).toContain(role);
      }
    }
  });

  it('同案登记的**机构全称**不洗，只洗脱敏对象那一格（变异：去掉 role 过滤 → 红）', () => {
    // 【它拦的是哪一次事故】这个领域的 company_profiles 一张表装两类东西：来访者的化名
    //（首诊写进「签约主体」）与平台/协会/监管这些**收件机构的全称**（登记成「关联」）。
    // 不分角色一律洗的形态是——用户导出一份要寄给平台的投诉答复函，
    // 抬头成了「致〔已脱敏〕」、抄送栏也是〔已脱敏〕，而 PDF 照常生成、HTTP 200，
    // 页脚还印着一句「出现的化名或编号已替换为占位」。产物废了，三处都说一切正常。
    const caseId = makeCase('counseling');
    const ins = db.prepare('INSERT INTO company_profiles (case_id, name, role) VALUES (?, ?, ?)');
    ins.run(caseId, '来访庚辛壬', '签约主体');
    ins.run(caseId, '简单心理平台', '关联');
    ins.run(caseId, '中国心理学会临床心理学注册工作委员会', '关联');
    const got = shareRedactorFor(db, caseId).text(
      '致简单心理平台：关于来访庚辛壬对本机构的投诉，现答复如下。' +
        '抄送：中国心理学会临床心理学注册工作委员会。',
    );
    expect(got.text, '来访者的化名没被洗').not.toContain('来访庚辛壬');
    expect(got.text, '收件机构的全称被一并洗掉了，这份答复函寄不出去').toContain('简单心理平台');
    expect(got.text).toContain('中国心理学会临床心理学注册工作委员会');
    expect(got.hits, '只该洗掉化名那一处').toBe(1);
  });

  it('单字的登记名不参与替换（替了会把整份产物洗成读不成句）', () => {
    // 用户随手把对方记成「甲」时，替换会把正文里每一个「甲」都换掉：「甲方」→「〔已脱敏〕方」。
    // 漏掉一个单字化名的代价是它留在页面上；替掉它的代价是整份文书作废、且看起来像系统坏了。
    const caseId = makeCase('counseling');
    db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?, ?)').run(caseId, '甲');
    expect(shareRedactorFor(db, caseId).text('甲方与乙方').text).toBe('甲方与乙方');
  });
});

// ───────────────── 真实调用路径：登记机构的那一行落在哪个角色位 ─────────────────

/**
 * 上面那条「机构全称不洗」的判据是**直接往表里插 role='关联'** 验的，
 * 而真实产线上没有人手写这张表：登记对方主体只有一个工具面（company_profile_upsert），
 * 它此前**不带 role 就一律落签约主体**——正好是本领域 aliasRoles 那一格。
 * 于是上面那条判据绿着，产线上照样复现原事故：
 *   `company_profile_upsert(name='简单心理平台')` → 落进化名位 →
 *   分享/导出把「致简单心理平台」洗成「致〔已脱敏〕」，PDF 照常生成、HTTP 200。
 *
 * 【所以这一组只走工具面，一行 SQL 都不写】判据要接的是产线判据，不是我们自己造的那张表。
 */
describe('登记对方主体的两条工具路：不点名角色时落在哪一格', () => {
  /** 站内 agent 那条路（lib/agent/tools.ts）的最小上下文。 */
  function agentCtx(caseId: number, domain: string): AgentToolContext {
    return {
      db,
      caseId,
      userId: uid,
      domain,
      threadId: 1,
      sourceMessageId: null,
      citations: new CitationGuard(),
      crisisCardAlreadyGiven: false,
      state: newTurnState(),
      emit: () => {},
    };
  }

  function rolesOf(caseId: number): Record<string, string> {
    const rows = db
      .prepare('SELECT name, role FROM company_profiles WHERE case_id = ? ORDER BY id')
      .all(caseId) as { name: string; role: string }[];
    return Object.fromEntries(rows.map((r) => [r.name, r.role]));
  }

  it('MCP 那条路：不带 role 登记一家机构 → 不落化名位，答复函的抬头与抄送逐字留着', () => {
    const caseId = makeCase('counseling');
    const made = cases.upsertCompany(db, { caseId, userId: uid, name: '简单心理平台' });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    expect(rolesOf(caseId)['简单心理平台']).toBe(COUNSELING.defaultCompanyRole);
    expect(
      COUNSELING.sensitive!.aliasRoles,
      '缺省角色落进了化名位——这正是原事故',
    ).not.toContain(COUNSELING.defaultCompanyRole);

    const got = shareRedactorFor(db, caseId).text('致简单心理平台：关于来访庚辛壬的投诉，现答复如下。');
    expect(got.text, '收件机构的全称被洗掉了，这份答复函寄不出去').toContain('简单心理平台');
  });

  it('站内 agent 那条路读同一份口径（两条路各写一遍 `?? 缺省` 的形态是，改一处漏一处）', () => {
    const caseId = makeCase('counseling');
    const out = executeTool('company_profile_upsert', JSON.stringify({ name: '简单心理平台' }), agentCtx(caseId, 'counseling'));
    expect(out.ok, out.content).toBe(true);
    expect(rolesOf(caseId)['简单心理平台']).toBe(COUNSELING.defaultCompanyRole);
    expect(shareRedactorFor(db, caseId).text('致简单心理平台').text).toContain('简单心理平台');
  });

  it('已经登记在化名位上的名字，**不带 role 的补充不会把它挪走**（挪走＝这个人从此不脱敏；变异：counseling 包的 inheritCompanyRoleOnUnnamed 改成 false → 红）', () => {
    // store.upsertCompanyProfile 按 (case_id, name) 收敛，而它对 role 是直接赋值不是 COALESCE：
    // 少了「不点名就沿用已有角色」这条，给来访者补一句备注就会把他搬出化名位——
    // 回包 created=false、HTTP 200，页面上那一行还在，而分享页从此原样印着他的化名。
    const caseId = makeCase('counseling');
    const first = cases.upsertCompany(db, {
      caseId,
      userId: uid,
      name: '来访庚辛壬',
      role: COUNSELING.sensitive!.aliasRoles[0],
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);

    const again = cases.upsertCompany(db, { caseId, userId: uid, name: '来访庚辛壬', note: '第三次爽约' });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(rolesOf(caseId)['来访庚辛壬']).toBe(COUNSELING.sensitive!.aliasRoles[0]);
    expect(shareRedactorFor(db, caseId).text('来访庚辛壬第三次爽约').text).not.toContain('来访庚辛壬');
  });

  it('缺省领域**逐字不变**：不带 role 落 4098805 那一格（两条路各验一遍；比的是基线常量不是当前包字段）', () => {
    const viaCases = makeCase(DEFAULT_DOMAIN);
    const made = cases.upsertCompany(db, { caseId: viaCases, userId: uid, name: '某某科技有限公司' });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    expect(rolesOf(viaCases)['某某科技有限公司']).toBe(LABOR_COMPANY_ROLE_BASELINE.unnamedViaCases);

    const viaAgent = makeCase(DEFAULT_DOMAIN);
    const out = executeTool(
      'company_profile_upsert',
      JSON.stringify({ name: '某某科技有限公司' }),
      agentCtx(viaAgent, DEFAULT_DOMAIN),
    );
    expect(out.ok, out.content).toBe(true);
    expect(rolesOf(viaAgent)['某某科技有限公司']).toBe(
      LABOR_COMPANY_ROLE_BASELINE.unnamedViaAgentTool,
    );
  });

  /**
   * 【这一条守的是第②条不许溢到缺省领域】4098805 的两条产线路都是 `role ?? '签约主体'`，
   * 函数体里一次同名行查询都没有——也就是说基线下，一个已经登记在「用工主体」位上的公司，
   * 只要下一次不带 role 补充一句备注，就会被**搬回签约位**。
   * 「不点名就沿用已有角色」这条规则本身是为敏感级行当加的；无条件打开的形态是：
   * 缺省领域这一串调用的落点悄悄换了一格，回包 created=false、HTTP 200、页面上那一行还在，
   * 而 pickRespondent 从此取到另一家。所以这里钉的是**基线值**，不是"哪个更合理"。
   */
  it('缺省领域**逐字不变**：已在别的角色位上、不点名补充仍落基线那一格（变异：labor 包的 inheritCompanyRoleOnUnnamed 改成 true → 红）', () => {
    const caseId = makeCase(DEFAULT_DOMAIN);
    const first = cases.upsertCompany(db, {
      caseId,
      userId: uid,
      name: '某某科技有限公司',
      role: '用工主体',
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(rolesOf(caseId)['某某科技有限公司']).toBe('用工主体');

    const again = cases.upsertCompany(db, {
      caseId,
      userId: uid,
      name: '某某科技有限公司',
      note: '欠薪两个月',
    });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(rolesOf(caseId)['某某科技有限公司']).toBe(
      LABOR_COMPANY_ROLE_BASELINE.unnamedAfterExistingOtherRole,
    );

    // 站内 agent 那条路读同一份口径：漏掉其中一条的形态是两条路落点不同，而两边都 200
    const viaAgent = makeCase(DEFAULT_DOMAIN);
    const seed = cases.upsertCompany(db, {
      caseId: viaAgent,
      userId: uid,
      name: '某某科技有限公司',
      role: '用工主体',
    });
    expect(seed.ok, JSON.stringify(seed)).toBe(true);
    const out = executeTool(
      'company_profile_upsert',
      JSON.stringify({ name: '某某科技有限公司', risk_notes: '欠薪两个月' }),
      agentCtx(viaAgent, DEFAULT_DOMAIN),
    );
    expect(out.ok, out.content).toBe(true);
    expect(rolesOf(viaAgent)['某某科技有限公司']).toBe(
      LABOR_COMPANY_ROLE_BASELINE.unnamedAfterExistingOtherRole,
    );
  });

  it('缺省领域声明的缺省角色**就是** 4098805 那个词（包字段被顺手改掉时这里红，不等到产物里才发现）', () => {
    expect(DOMAINS[DEFAULT_DOMAIN].defaultCompanyRole).toBe(
      LABOR_COMPANY_ROLE_BASELINE.unnamedViaCases,
    );
    expect(
      DOMAINS[DEFAULT_DOMAIN].inheritCompanyRoleOnUnnamed,
      '缺省领域开了「沿用已有角色」——基线没有这条分支，落点会变',
    ).toBe(false);
  });

  it('点了名的 role 照旧原样落，不合法的照旧拒收（这一层没被改宽）', () => {
    const caseId = makeCase('counseling');
    const ok1 = cases.upsertCompany(db, { caseId, userId: uid, name: '某协会', role: '用工主体' });
    expect(ok1.ok).toBe(true);
    expect(rolesOf(caseId)['某协会']).toBe('用工主体');

    const bad = cases.upsertCompany(db, { caseId, userId: uid, name: '某机构', role: '不存在的角色' });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errorCode).toBe('INVALID_COMPANY_ROLE');
  });

  /**
   * 【经理 2026-09-07 裁决（台账在案）：工具面保持 4098805 的宽松语义】
   * 基线那一行是 `inEnum(args.role, COMPANY_ROLES) ?? '签约主体'`——不合法 / 空串 / 非字符串
   * 一律当「没点名」，整条登记照常落档。W3 把两条路收敛成 resolveCompanyRole 时，
   * 顺带把这一格也改成了拒收，于是**缺省领域的对外行为变了**：
   * 模型把角色位拼错一个字，用户刚说出口的公司全称、统一社会信用代码、风险备注
   * 一个字都不进档案，而用户只看到下一轮追问——这正是 P4 说好的「labor 零变化」不许发生的事。
   *
   * 【为什么钉的是基线常量而不是当前包字段】同 unnamedViaAgentTool 那条：
   * 拿 DOMAINS[DEFAULT_DOMAIN].defaultCompanyRole 当期望值是自比恒绿。
   * 【变异确认（集成 2026-09-07）】把 tools.ts 那句 `inEnum(args.role, COMPANY_ROLES)` 去掉、
   * 恢复成把 args.role 原样递给 resolveCompanyRole ⇒ 本条三个子断言当场红（回包 ok=false）。
   */
  it('缺省领域**逐字不变**：工具面递一个不合法 role，落签约主体位且公司名/备注照常落档（变异：把工具面那道 inEnum 去掉 → 红）', () => {
    const caseId = makeCase(DEFAULT_DOMAIN);
    const out = executeTool(
      'company_profile_upsert',
      JSON.stringify({
        name: '某某科技有限公司',
        role: '不存在的角色',
        uscc: '91110105MA01ABCD2X',
        risk_notes: '欠薪两个月',
      }),
      agentCtx(caseId, DEFAULT_DOMAIN),
    );
    expect(out.ok, out.content).toBe(LABOR_COMPANY_ROLE_BASELINE.invalidRoleStillSavesRecord);
    expect(rolesOf(caseId)['某某科技有限公司']).toBe(
      LABOR_COMPANY_ROLE_BASELINE.invalidRoleViaAgentTool,
    );
    // 【为什么还要读回这两列】只验角色位的形态是：把整条登记改成"只落一个空壳行"也照样绿，
    // 而用户真正丢掉的是这两格（公司全称之外，正是他刚说出口的那两句）。
    const row = db
      .prepare('SELECT uscc, risk_notes FROM company_profiles WHERE case_id = ? AND name = ?')
      .get(caseId, '某某科技有限公司') as { uscc: string | null; risk_notes: string | null };
    expect(row.uscc).toBe('91110105MA01ABCD2X');
    expect(row.risk_notes).toBe('欠薪两个月');

    // 非字符串与空串是同一类坏值，基线对三者一视同仁；漏掉其中一种的形态是
    // 模型传 role: null / role: 0 时又回到拒收，而这两种恰恰是模型最常传的
    const viaNonString = makeCase(DEFAULT_DOMAIN);
    const n = executeTool(
      'company_profile_upsert',
      JSON.stringify({ name: '另一家公司', role: 123 }),
      agentCtx(viaNonString, DEFAULT_DOMAIN),
    );
    expect(n.ok, n.content).toBe(true);
    expect(rolesOf(viaNonString)['另一家公司']).toBe(
      LABOR_COMPANY_ROLE_BASELINE.nonStringRoleViaAgentTool,
    );

    const viaEmpty = makeCase(DEFAULT_DOMAIN);
    const e = executeTool(
      'company_profile_upsert',
      JSON.stringify({ name: '第三家公司', role: '' }),
      agentCtx(viaEmpty, DEFAULT_DOMAIN),
    );
    expect(e.ok, e.content).toBe(true);
    expect(rolesOf(viaEmpty)['第三家公司']).toBe(
      LABOR_COMPANY_ROLE_BASELINE.emptyStringRoleViaAgentTool,
    );
  });

  it('第二个领域同一条口径：不合法 role 也不拒收，落本领域的缺省位——而不是化名位', () => {
    // 【为什么这条要单列】宽松语义是按「不点名」处理的，而不点名在这个领域会走沿用/缺省两条。
    // 落进化名位的形态是：机构全称从此在分享页上被洗成占位符，答复函寄不出去。
    const caseId = makeCase('counseling');
    const out = executeTool(
      'company_profile_upsert',
      JSON.stringify({ name: '简单心理平台', role: '不存在的角色' }),
      agentCtx(caseId, 'counseling'),
    );
    expect(out.ok, out.content).toBe(true);
    expect(rolesOf(caseId)['简单心理平台']).toBe(COUNSELING.defaultCompanyRole);
    expect(COUNSELING.sensitive!.aliasRoles).not.toContain(rolesOf(caseId)['简单心理平台']);
    expect(shareRedactorFor(db, caseId).text('致简单心理平台').text).toContain('简单心理平台');
  });

  /**
   * 【经理 2026-09-07 裁决（台账在案）：读路径口径也管 upsertCompany】
   * 这个案子早已建好、领域早已选过，登记一个公司名只需要定一个角色位。
   * 走 packForCase 的形态是：一行 cases.domain 写坏、或某个包被摘下线，
   * 用户往自己的档案里补一个公司名就收到 500 UNKNOWN_DOMAIN——
   * 而这条 500 什么也保护不了（角色词表本来就跨领域同一套）。
   * UNKNOWN_DOMAIN 留给**建案/选领域**那条路：那里的领域是调用方这一次给的。
   */
  it('domain 写坏的老案件仍能登记公司，角色回落缺省领域那一格（变异：把 upsertCompany 改回 packForCase → 红）', () => {
    const caseId = makeCase(DEFAULT_DOMAIN);
    db.prepare('UPDATE cases SET domain = ? WHERE id = ?').run('从没注册过的领域', caseId);

    const made = cases.upsertCompany(db, { caseId, userId: uid, name: '某某科技有限公司', note: '欠薪两个月' });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    expect(rolesOf(caseId)['某某科技有限公司']).toBe(DOMAINS[DEFAULT_DOMAIN].defaultCompanyRole);
    // 与 lib/sensitive.sensitivityOf 同一条读路径口径：取不到包按缺省领域算，不按最严处理
    expect(sensitivityOf('从没注册过的领域')).toBeNull();
  });

  it('对照：**建案**那条路遇到不认识的领域照旧拒（自证上一条放宽的只是读路径）', () => {
    const other = Number(
      db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('sens-unknown').lastInsertRowid,
    );
    const made = cases.ensureDefaultCase(db, other, '从没注册过的领域');
    expect('ok' in made && made.ok === false).toBe(true);
    if (!('ok' in made)) return;
    expect(made.errorCode).toBe('UNKNOWN_DOMAIN');
  });
});

// ───────────────── 结构守卫：缺省角色不许与化名位重叠 ─────────────────

describe('装载时就拦住「缺省角色 = 化名位」的包（设计稿 §16 敏感级）', () => {
  it('每个包的 defaultCompanyRole 都是真存在的角色位（打错一个字 = 每一行都落到一个不存在的位上）', () => {
    for (const pack of Object.values(DOMAINS)) {
      expect(
        cases.COMPANY_ROLES as readonly string[],
        `${pack.key} 的 defaultCompanyRole「${pack.defaultCompanyRole}」不在角色词表里`,
      ).toContain(pack.defaultCompanyRole);
    }
  });

  it('声明了敏感级的包，缺省角色不在 aliasRoles 里（变异：把 counseling 的缺省改成化名位 → 装载即抛）', () => {
    for (const pack of Object.values(DOMAINS)) {
      if (!pack.sensitive) continue;
      expect(
        pack.sensitive.aliasRoles,
        `${pack.key}：不点名角色的登记会被当成脱敏对象，机构全称在产物里变成占位符`,
      ).not.toContain(pack.defaultCompanyRole);
    }
    // 判据自证有牙：把两者指到同一格的包**装不进来**，而不是等到某一份文书寄不出去才发现。
    const broken: DomainPack = { ...COUNSELING, defaultCompanyRole: COUNSELING.sensitive!.aliasRoles[0] };
    expect(() => assertDomainPack(broken)).toThrow(/defaultCompanyRole/);
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
