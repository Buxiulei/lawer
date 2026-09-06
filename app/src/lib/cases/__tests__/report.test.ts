// app/src/lib/cases/__tests__/report.test.ts
// 个案报告（设计稿 §4.3）的判据。要害五组：
//   ① 首次 get 惰性生成初稿，且有数据的节全部非空（"生成了一份全是空节的报告"与没生成同形）
//   ② 改写走乐观锁：base_version 对不上回 409 REPORT_VERSION_CONFLICT，且**没写进去**
//   ③ 八个触发点各一条：写完之后 stale_since / stale_reason 都有值（删掉任一处调用 ⇒ 对应那条红）
//   ④ 7 天未整理由读时判定（不落库，故用注入的 now 推时钟）
//   ⑤ 他人的案子一律 CASE_NOT_FOUND（与 lib/cases 同口径，不区分"不存在"和"不是你的"）
//
// 出证与内容提取那两条触发点要跑真链路：sidecar 打 fetch 假掉、文件库落到临时目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import BetterSqlite3, { type Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// 必须在任何加解密调用之前就位（crypto 首次调用时读 env 并缓存）
process.env.LAWER_DATA_KEY = Buffer.alloc(32, 9).toString('base64');

import { buildCaseFacts, buildFactsStatusLine, loadCaseSnapshot } from '@/lib/agent';
import { encryptField } from '@/lib/crypto';
import * as agentStore from '@/lib/db/agent';
import { runMigrations } from '@/lib/db/migrate';
import * as evidence from '@/lib/evidence';
import { setBriefGenerator } from '@/lib/evidence/brief';
import { enqueueExtraction, runOnce, type ExtractionHandler } from '@/lib/jobs/extraction-worker';

import * as cases from '..';
import { bootstrapReport, findReportRow, getReport, updateSection } from '../report';
import { markReportStale } from '../report-stale';

let db: Database;
let userA: number;
let userB: number;
let caseA: number;
let tmpDir: string;

const FAKE_TST = 'MIILAQYJKoZIhvcNAQcCoIIK8jCCCu4CAQMx';

/** sidecar 全程假掉：出证不依赖真 TSA / 签名证书 */
function mockSidecarOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/signer')) {
        return new Response(
          JSON.stringify({ signer_cn: '某某公司', signer_org: null, not_before: null, not_after: null, serial: 'x' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.endsWith('/tsa')) {
        return new Response(
          JSON.stringify({
            tst_b64: FAKE_TST,
            gen_time: '2026-09-05T03:42:58+00:00',
            serial: '128227905932707484420972403472307',
            tsa_url: 'http://tsa.example/tsa',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.endsWith('/evidence-pdf')) return new Response(new Uint8Array(Buffer.from('%PDF unsigned')), { status: 200 });
      if (u.endsWith('/pades')) return new Response(new Uint8Array(Buffer.from('%PDF signed')), { status: 200 });
      throw new Error(`未预期的 sidecar 调用: ${u}`);
    }),
  );
}

function staleOf(caseId = caseA) {
  const row = findReportRow(db, caseId);
  return { since: row?.stale_since ?? null, reason: row?.stale_reason ?? null };
}

/** 把过期标记清空，好让下一条触发点判据从"不过期"起跑 */
function clearStale(caseId = caseA) {
  db.prepare('UPDATE case_reports SET stale_since = NULL, stale_reason = NULL WHERE case_id = ?').run(caseId);
}

/** 先有一份初稿（version=1、不过期），触发点判据都从这个起点出发 */
function seedReport(caseId = caseA) {
  const r = bootstrapReport(db, caseId);
  if (!r.ok) throw new Error('初稿没生成出来');
  clearStale(caseId);
}

function mkEvidence(name = '解除通知.jpg') {
  const r = evidence.uploadEvidence(db, {
    caseId: caseA,
    userId: userA,
    bytes: Buffer.from(`${name} 的正文`),
    name,
    mime: 'image/jpeg',
    category: '公司文件',
    provePurpose: '证明公司单方解除',
    originalMedium: '手机拍照',
  });
  if (!r.ok) throw new Error(`造样本失败：${r.errorCode}`);
  return r.evidence.id;
}

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const insertUser = db.prepare(
    `INSERT INTO users (phone_hash, real_name_enc, id_card_enc, auth_status, cert_type)
     VALUES (?, ?, ?, '已实名', '身份证')`,
  );
  userA = Number(
    insertUser.run('h-a', encryptField('张三'), encryptField('110101199001011234')).lastInsertRowid,
  );
  userB = Number(
    insertUser.run('h-b', encryptField('李四'), encryptField('110101199001015678')).lastInsertRowid,
  );
  caseA = Number(
    db
      .prepare(
        `INSERT INTO cases (user_id, title, stage, goal, bottom_line, employed_from, monthly_wage_fen, position, contract_count)
         VALUES (?, '甲的案子', '风声', '拿到应得的钱', '不接受净身出户', '2020-03-01', 2500000, '后端工程师', '续签过一次')`,
      )
      .run(userA).lastInsertRowid,
  );
  db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, '乙的案子', '风声')").run(userB);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-report-'));
  process.env.FILES_DIR = tmpDir;
  setBriefGenerator((input) => ({ 能证明什么: `${input.name} 的要点` }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setBriefGenerator(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  db.close();
});

// ========== ① 初稿 ==========

describe('首次 get：惰性生成初稿', () => {
  test('库里本来没有报告行；get 一次之后有了，version=1、作者 system', () => {
    expect(findReportRow(db, caseA)).toBeUndefined();

    const r = getReport(db, { caseId: caseA, userId: userA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.version).toBe(1);
    expect(r.report.updated_by).toBe('system');
    expect(findReportRow(db, caseA)).toBeDefined();
  });

  /**
   * 【为什么要逐节断言非空】"生成了一份报告"这句话，在一份**每节都是空串**的报告面前
   * 照样成立——而页面上它与"还没生成"长得一模一样。所以这条钉的是每一节都有字。
   */
  test('有数据时各节非空，且十节标题一个不少（变异：让某一节返回空串 → 红）', () => {
    cases.addTimelineEvent(db, {
      caseId: caseA,
      userId: userA,
      happenedAt: '2026-08-01T10:00:00+08:00',
      kind: '公司动作',
      title: 'HR 约谈，要求主动离职',
    });
    agentStore.upsertClaim(db, {
      caseId: caseA,
      kind: '2N',
      amountFen: 15_000_00,
      calcJson: null,
      basis: '第八十七条',
      status: 'draft',
    });
    agentStore.insertDeadline(db, {
      caseId: caseA,
      kind: '仲裁时效',
      dueDate: '2027-08-01',
      derivedFrom: '解除之日起一年',
    });
    agentStore.insertActionItem(db, {
      caseId: caseA,
      title: '去打社保记录',
      detail: null,
      dueAt: '2026-09-10T18:00:00+08:00',
      priority: 1,
      sourceMessageId: null,
    });
    mkEvidence();

    const r = getReport(db, { caseId: caseA, userId: userA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.report.section_order).toEqual([
      '基本盘',
      '案情主线',
      '争议焦点',
      '各方立场与谈判纪律',
      '证据地图',
      '时间线摘要',
      '期限',
      '待办与下一步',
      '风险与未定项',
      '变更日志',
    ]);
    for (const title of r.report.section_order) {
      expect(r.report.sections[title]?.trim(), `「${title}」这一节是空的`).toBeTruthy();
    }
    // 渲染稿里十节标题一个不少，且真数据进去了
    for (const title of r.report.section_order) {
      expect(r.report.rendered_md).toContain(`## ${title}`);
    }
    expect(r.report.rendered_md).toContain('HR 约谈');
    expect(r.report.rendered_md).toContain('解除通知.jpg');
    expect(r.report.rendered_md).toContain('拿到应得的钱');
  });

  test('只要某一节（section=…），不在骨架里的节名回 REPORT_SECTION_NOT_FOUND', () => {
    const one = getReport(db, { caseId: caseA, userId: userA, section: '基本盘' });
    expect(one.ok).toBe(true);
    if (one.ok) expect(one.section?.content).toContain('甲的案子');

    const bad = getReport(db, { caseId: caseA, userId: userA, section: '没有这一节' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errorCode).toBe('REPORT_SECTION_NOT_FOUND');
  });
});

// ========== ② 乐观锁 ==========

describe('updateSection：乐观锁', () => {
  test('版本对得上就写进去，版本 +1，变更日志自动多一行', () => {
    const first = getReport(db, { caseId: caseA, userId: userA });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const done = updateSection(db, {
      caseId: caseA,
      userId: userA,
      section: '争议焦点',
      content: '公司主张协商一致解除，我方主张违法解除。',
      reason: '第一次谈完之后梳理',
      baseVersion: first.report.version,
      updatedBy: 'agent:7',
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.report.version).toBe(first.report.version + 1);
    expect(done.report.updated_by).toBe('agent:7');
    expect(done.report.sections['争议焦点']).toContain('违法解除');
    expect(done.report.sections['变更日志']).toContain('agent:7');
    expect(done.report.sections['变更日志']).toContain('第一次谈完之后梳理');
    expect(done.report.rendered_md).toContain('违法解除');
  });

  /**
   * 【这条是本工单的核心红线】没有这把锁，两个 agent 同时整理同一份报告时，
   * 后写的那次会把先写的那次整节盖掉——两边都返回 200，用户永远不知道自己丢了一段。
   * 变异：把 updateSection 里的版本比较删掉 ⇒ 本条当场红（回 ok:true，且内容被盖成第二份）。
   */
  test('版本对不上 ⇒ 409 REPORT_VERSION_CONFLICT，且那一节的内容一个字都没被改', () => {
    const first = getReport(db, { caseId: caseA, userId: userA });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const v0 = first.report.version;

    const a = updateSection(db, {
      caseId: caseA,
      userId: userA,
      section: '争议焦点',
      content: '甲 agent 写的版本',
      reason: 'A 整理',
      baseVersion: v0,
      updatedBy: 'agent:1',
    });
    expect(a.ok).toBe(true);

    // 乙拿着**同一个旧版本号**来写（它是在 A 之前读的）
    const b = updateSection(db, {
      caseId: caseA,
      userId: userA,
      section: '争议焦点',
      content: '乙 agent 写的版本',
      reason: 'B 整理',
      baseVersion: v0,
      updatedBy: 'agent:2',
    });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.status).toBe(409);
    expect(b.errorCode).toBe('REPORT_VERSION_CONFLICT');

    const after = getReport(db, { caseId: caseA, userId: userA });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.report.sections['争议焦点']).toBe('甲 agent 写的版本');
    expect(after.report.version).toBe(v0 + 1); // 冲突那次没有把版本推上去
  });

  test('整理过之后过期标记清掉（"先整理再回答"这句话才有出口）', () => {
    seedReport();
    markReportStale(db, caseA, '新证据');
    expect(staleOf().since).not.toBeNull();

    const cur = getReport(db, { caseId: caseA, userId: userA });
    expect(cur.ok).toBe(true);
    if (!cur.ok) return;
    const done = updateSection(db, {
      caseId: caseA,
      userId: userA,
      section: '证据地图',
      content: '新到的两份材料已经归位。',
      reason: '整理新证据',
      baseVersion: cur.report.version,
      updatedBy: 'web',
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.report.stale.state).toBeNull();
    expect(staleOf().since).toBeNull();
  });

  test('变更日志那一节不接受直接改写（它只由服务端追加）', () => {
    const cur = getReport(db, { caseId: caseA, userId: userA });
    expect(cur.ok).toBe(true);
    if (!cur.ok) return;
    const r = updateSection(db, {
      caseId: caseA,
      userId: userA,
      section: '变更日志',
      content: '（清空）',
      reason: '想抹掉记录',
      baseVersion: cur.report.version,
      updatedBy: 'web',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('REPORT_SECTION_READONLY');
  });
});

// ========== ③ 八个触发点 ==========
//
// 每条的形状都一样：先有一份不过期的初稿 → 走那个写入口 → stale_since 与 stale_reason 都有值。
// 一条一个 test，是为了让「哪一处的调用被删了」直接从失败的用例名上读出来，
// 而不是看到一条"触发点全都要标过期"红了之后还要自己去猜是哪一个。

describe('过期触发点（逐个一条；删掉任一处的 markReportStale ⇒ 对应那条红）', () => {
  test('timeline_add：追加一条时间线事件', () => {
    seedReport();
    const r = cases.addTimelineEvent(db, {
      caseId: caseA,
      userId: userA,
      happenedAt: '2026-08-02T10:00:00+08:00',
      kind: '公司动作',
      title: '第二次约谈',
    });
    expect(r.ok).toBe(true);
    const s = staleOf();
    expect(s.since).not.toBeNull();
    expect(s.reason).toContain('时间线');
  });

  test('timeline_add 去重命中时**不**标过期（没有新事实就不该催人整理）', () => {
    const first = cases.addTimelineEvent(db, {
      caseId: caseA,
      userId: userA,
      happenedAt: '2026-08-02T10:00:00+08:00',
      kind: '公司动作',
      title: '第二次约谈',
      clientRef: 'ref-1',
    });
    expect(first.ok).toBe(true);
    seedReport();
    const again = cases.addTimelineEvent(db, {
      caseId: caseA,
      userId: userA,
      happenedAt: '2026-08-02T10:00:00+08:00',
      kind: '公司动作',
      title: '第二次约谈',
      clientRef: 'ref-1',
    });
    expect(again.ok && again.deduped).toBe(true);
    expect(staleOf().since).toBeNull();
  });

  test('stage 变更', () => {
    seedReport();
    const r = cases.updateCase(db, { caseId: caseA, userId: userA, stage: '仲裁准备' });
    expect(r.ok).toBe(true);
    const s = staleOf();
    expect(s.since).not.toBeNull();
    expect(s.reason).toContain('阶段变更');
  });

  test('只改 goal（不动 stage）不标过期——常驻过期与从不过期是同一个信息量', () => {
    seedReport();
    const r = cases.updateCase(db, { caseId: caseA, userId: userA, goal: '换个说法' });
    expect(r.ok).toBe(true);
    expect(staleOf().since).toBeNull();
  });

  test('证据登记', () => {
    seedReport();
    mkEvidence('工资流水.pdf');
    const s = staleOf();
    expect(s.since).not.toBeNull();
    expect(s.reason).toContain('新证据');
  });

  test('证据出证', async () => {
    const evidenceId = mkEvidence('解除通知.jpg');
    seedReport();
    mockSidecarOk();
    const r = await evidence.attestEvidence(db, { evidenceId, userId: userA });
    expect(r.ok).toBe(true);
    const s = staleOf();
    expect(s.since).not.toBeNull();
    expect(s.reason).toContain('证据出证');
  });

  test('内容提取完成', async () => {
    const evidenceId = mkEvidence('录音.m4a');
    seedReport();
    enqueueExtraction(db, { evidenceId, caseId: caseA, userId: userA, mode: 'asr', quoteId: null, cost: 0 });
    const handler: ExtractionHandler = async () => ({ text: '录音里说：这个月就走人。' });
    const verdict = await runOnce(db, { handlers: { ocr: handler, asr: handler, video: handler } });
    expect(verdict).toBe('done');
    const s = staleOf();
    expect(s.since).not.toBeNull();
    expect(s.reason).toContain('材料内容提取');
  });

  test('deadline 登记', () => {
    seedReport();
    agentStore.insertDeadline(db, {
      caseId: caseA,
      kind: '仲裁时效',
      dueDate: '2027-08-01',
      derivedFrom: '解除之日起一年',
    });
    const s = staleOf();
    expect(s.since).not.toBeNull();
    expect(s.reason).toContain('期限');
  });

  test('deadline 了结', () => {
    const row = agentStore.insertDeadline(db, {
      caseId: caseA,
      kind: '举证期限',
      dueDate: '2026-10-01',
      derivedFrom: '通知书指定',
    });
    seedReport();
    expect(agentStore.resolveDeadline(db, caseA, row.id)).toBe(true);
    const s = staleOf();
    expect(s.since).not.toBeNull();
    expect(s.reason).toContain('期限了结');
  });

  test('claims upsert（claims_upsert 与 claim_calc 共用这一个写入口）', () => {
    seedReport();
    agentStore.upsertClaim(db, {
      caseId: caseA,
      kind: '2N',
      amountFen: 15_000_00,
      calcJson: null,
      basis: '第八十七条',
      status: 'draft',
    });
    const s = staleOf();
    expect(s.since).not.toBeNull();
    expect(s.reason).toContain('金额主张');
  });

  /**
   * upsertClaim 有两条落点（首次插入 / 改金额），**两条各测一次**：
   * 只测其中一条时，删掉另一条的 markReportStale 判据照样全绿——
   * 而"改了一次金额报告没标过期"正是最常发生的那一种（金额是谈判过程中反复变的）。
   */
  test('claims upsert 改金额那条路（同 kind 第二次写）', () => {
    agentStore.upsertClaim(db, {
      caseId: caseA,
      kind: '2N',
      amountFen: 15_000_00,
      calcJson: null,
      basis: '第八十七条',
      status: 'draft',
    });
    seedReport();
    const again = agentStore.upsertClaim(db, {
      caseId: caseA,
      kind: '2N',
      amountFen: 18_000_00,
      calcJson: null,
      basis: '第八十七条',
      status: 'draft',
    });
    expect(again.created).toBe(false);
    const s = staleOf();
    expect(s.since).not.toBeNull();
    expect(s.reason).toContain('金额主张');
  });

  test('action_create（新建行动卡）', () => {
    seedReport();
    agentStore.insertActionItem(db, {
      caseId: caseA,
      title: '去打社保记录',
      detail: null,
      dueAt: '2026-09-10T18:00:00+08:00',
      priority: 1,
      sourceMessageId: null,
    });
    const s = staleOf();
    expect(s.since).not.toBeNull();
    expect(s.reason).toContain('待办');
  });

  test('多次变动累加计数，且 stale_since 停在第一条那一刻不被刷新', () => {
    seedReport();
    db.prepare(
      "UPDATE case_reports SET stale_since = '2026-09-01 08:00:00', stale_reason = '{\"新证据\":2}' WHERE case_id = ?",
    ).run(caseA);
    markReportStale(db, caseA, '新证据');
    markReportStale(db, caseA, '时间线');
    const s = staleOf();
    expect(s.since).toBe('2026-09-01 08:00:00');
    expect(JSON.parse(s.reason!)).toEqual({ 新证据: 3, 时间线: 1 });
  });

  test('还没有报告的案子也照样留痕：占位行 version=0，之后 get 仍会生成初稿', () => {
    expect(findReportRow(db, caseA)).toBeUndefined();
    markReportStale(db, caseA, '新证据');
    expect(findReportRow(db, caseA)?.version).toBe(0);

    const r = getReport(db, { caseId: caseA, userId: userA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.version).toBe(1);
    // 初稿吃的是此刻的档案，之前攒的那几条已经在里面了
    expect(r.report.stale.state).toBeNull();
  });
});

// ========== ④ 7 天判定 ==========

describe('7 天未整理', () => {
  test('第 6 天不算过期，第 7 天算（读时判定，库里不写 stale_since）', () => {
    seedReport();
    db.prepare("UPDATE case_reports SET updated_at = '2026-09-01 00:00:00' WHERE case_id = ?").run(caseA);

    const day6 = getReport(db, { caseId: caseA, userId: userA, now: new Date('2026-09-06T23:00:00Z') });
    expect(day6.ok && day6.report.stale.state).toBeNull();

    const day7 = getReport(db, { caseId: caseA, userId: userA, now: new Date('2026-09-08T01:00:00Z') });
    expect(day7.ok).toBe(true);
    if (!day7.ok) return;
    expect(day7.report.stale.state).toBe('idle');
    expect(day7.report.stale.detail).toContain('7 天');
    // 判定不落库：这一档是算出来的，不是某个定时任务写进去的
    expect(staleOf().since).toBeNull();
  });

  test('有具体变动时报变动那一档，不报"太久没整理"（说得出多了哪几条更有用）', () => {
    seedReport();
    db.prepare("UPDATE case_reports SET updated_at = '2026-09-01 00:00:00' WHERE case_id = ?").run(caseA);
    markReportStale(db, caseA, '新证据');
    const r = getReport(db, { caseId: caseA, userId: userA, now: new Date('2026-09-20T00:00:00Z') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.stale.state).toBe('changed');
  });
});

// ========== ⑤ 事实卡首行三态 ==========

describe('事实卡首行状态区（唯一函数 buildFactsStatusLine）', () => {
  test('过期态：说清自哪天起、几条变动、分别是什么，并要求先整理', () => {
    const line = buildFactsStatusLine({
      report: { state: 'changed', since: '2026-09-01', changes: 3, detail: '新证据 2、时间线 1' },
      basicsMissing: 0,
    });
    expect(line).toContain('报告过期：自 2026-09-01 起 3 条变动（新证据 2、时间线 1）');
    expect(line).toContain('先整理再回答');
  });

  test('基本盘缺项态', () => {
    const line = buildFactsStatusLine({
      report: { state: null, since: null, changes: 0, detail: '' },
      basicsMissing: 2,
    });
    expect(line).toContain('基本盘缺 2 项');
    expect(line).not.toContain('报告过期');
  });

  test('正常态整行省略（常驻的"一切正常"会被当模板噪音跳过去，真出事那次也一起跳过）', () => {
    expect(
      buildFactsStatusLine({
        report: { state: null, since: null, changes: 0, detail: '' },
        basicsMissing: 0,
      }),
    ).toBeNull();
  });

  test('extra 里的标记原样追加（R2 的危机标记走这里，不再各写一个三元）', () => {
    const line = buildFactsStatusLine({
      report: { state: null, since: null, changes: 0, detail: '' },
      basicsMissing: 0,
      extra: ['近 72h 危机标记'],
    });
    expect(line).toContain('近 72h 危机标记');
  });

  /**
   * 【端到端那一半】上面四条钉的是函数本身，这条钉的是它**真的接在事实卡上**——
   * 变异：把 buildCaseFacts 里那句状态区拼接删掉 ⇒ 本条红，而上面四条仍然全绿。
   */
  test('过期时事实卡首行真的带这句话（变异：不把状态区拼进 header ⇒ 红）', () => {
    seedReport();
    markReportStale(db, caseA, '新证据');
    const card = buildCaseFacts(loadCaseSnapshot(db, caseA));
    expect(card.header.split('\n')[0]).toContain('报告过期');
    expect(card.header).toContain('新证据 1');
  });

  test('不过期且基本盘齐全时，事实卡首行不多这一句', () => {
    seedReport();
    const card = buildCaseFacts(loadCaseSnapshot(db, caseA));
    expect(card.header).not.toContain('报告过期');
    expect(card.header).not.toContain('基本盘缺');
  });

  test('快照只读报告、不惰性生成（每轮对话都写一份没人要过的报告是不行的）', () => {
    expect(findReportRow(db, caseA)).toBeUndefined();
    loadCaseSnapshot(db, caseA);
    expect(findReportRow(db, caseA)).toBeUndefined();
  });
});

// ========== ⑥ 归属 ==========

describe('别人的案子', () => {
  test('读：CASE_NOT_FOUND（不区分"不存在"与"不是你的"），且不会给他生成一份初稿', () => {
    const r = getReport(db, { caseId: caseA, userId: userB });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.errorCode).toBe('CASE_NOT_FOUND');
    }
    expect(findReportRow(db, caseA)).toBeUndefined();
  });

  test('写：CASE_NOT_FOUND，且甲的报告一个字没动', () => {
    const mine = getReport(db, { caseId: caseA, userId: userA });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    const before = mine.report.sections['争议焦点'];

    const r = updateSection(db, {
      caseId: caseA,
      userId: userB,
      section: '争议焦点',
      content: '乙塞进来的内容',
      reason: '越权',
      baseVersion: mine.report.version,
      updatedBy: 'agent:9',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('CASE_NOT_FOUND');

    const after = getReport(db, { caseId: caseA, userId: userA });
    expect(after.ok && after.report.sections['争议焦点']).toBe(before);
  });

  test('不存在的案件 id 与别人的案件回同一个码', () => {
    const r = getReport(db, { caseId: 9999, userId: userA });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('CASE_NOT_FOUND');
  });
});
