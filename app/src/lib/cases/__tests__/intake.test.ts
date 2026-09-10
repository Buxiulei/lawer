// app/src/lib/cases/__tests__/intake.test.ts
// 首诊提交必须**真的写进库**——这一组盯的是 P0 的第一层：
// 用户填完六步、点「进入驾驶舱」，此前服务器上一个字都没有。
// 所以这里不验「函数返回了 ok」，一律回头查表：字段落没落、时间线有没有、
// 三件事在不在、别人的案件能不能写。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { submitIntake } from '@/lib/cases';
import { submitIntakeInto } from '@/lib/cases/intake';
import { LABOR } from '@/lib/domains/labor';
// agent 侧的写法（按 name 收敛）——用它把「存量已有两行同角色」这个形态真造出来，
// 而不是手写 INSERT 假装 agent 写过
import { upsertCompanyProfile } from '@/lib/db/agent';
// listProfiles 就是 /api/v1/cases/{id}/dossier 喂给 pickRespondent 的那个读法（route.ts:61）。
// 换成 agent.ts 的同名列表函数会拿到另一个 CompanyProfileRow（少 reg_capital / investigated_at），
// 那不是被申请人这条链路上的读者。
import { listProfiles } from '@/lib/db/company-graph';
// pickRespondent 收的是 lib/db/company-graph 的那个 CompanyProfileRow（含 reg_capital /
// investigated_at 两列）；SELECT * 取回来的行本来就是它，用同一个类型才不会把断言放松掉
import type { CompanyProfileRow } from '@/lib/db/company-graph';
import { pickRespondent } from '@/lib/dossier/build';
import * as knowledge from '@/lib/knowledge';
import { makeFixture } from './fixtures';

/** 一份填满的首诊，字段名照 lib/cases 的入参 */
function fullIntake(over: Record<string, unknown> = {}) {
  return {
    stage: '已收通知',
    companyName: '华衡永泰供应链管理有限公司',
    employedFrom: '2021-04-12',
    monthlyWageFen: 2_200_000,
    position: '仓储主管',
    contractCount: '只签过一次',
    events: [
      { date: '2026-08-28', text: '部门开会说要优化' },
      { date: '2026-09-01', text: 'HR 约谈让我签自愿离职' },
      { date: '', text: '权限被收走' },
    ],
    freeText: '我没签。',
    companyDocs: { terminationNotice: '有', settlementAgreement: '没有', otherPaper: '不确定' },
    companyWording: 'HR 说公司要优化，让我主动辞职，给 N，三天内答复。',
    goals: ['违法解除赔偿金（2N）', '拖欠的工资'],
    bottomLine: '低于 2N 不签，工资必须结清。',
    now: new Date('2026-09-02T10:00:00+08:00'),
    ...over,
  };
}

describe('首诊落库', () => {
  it('六步内容确实进了这个人的案件：字段、公司、时间线、三件事', () => {
    const f = makeFixture();
    const res = submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake() });
    expect(res.ok).toBe(true);

    const row = f.db.prepare('SELECT * FROM cases WHERE id = ?').get(f.caseA) as Record<string, unknown>;
    expect(row.stage).toBe('已收通知');
    expect(row.employed_from).toBe('2021-04-12');
    expect(row.monthly_wage_fen).toBe(2_200_000);
    expect(row.position).toBe('仓储主管');
    expect(row.contract_count).toBe('只签过一次');
    expect(row.goal).toBe('违法解除赔偿金（2N）、拖欠的工资');
    expect(row.bottom_line).toBe('低于 2N 不签，工资必须结清。');

    // 公司名 = 仲裁里的被申请人，落 company_profiles
    const profiles = f.db
      .prepare('SELECT name, role FROM company_profiles WHERE case_id = ?')
      .all(f.caseA) as { name: string; role: string }[];
    expect(profiles).toEqual([
      { name: '华衡永泰供应链管理有限公司', role: '签约主体' },
    ]);

    // 三条事件 + 整段自述 + 公司说法 + 公司给过哪些文件 = 6 条
    const timeline = f.db
      .prepare('SELECT kind, title, detail, happened_at FROM timeline_events WHERE case_id = ? ORDER BY id')
      .all(f.caseA) as { kind: string; title: string; detail: string | null; happened_at: string }[];
    expect(timeline).toHaveLength(6);
    expect(timeline.map((t) => t.title)).toContain('HR 约谈让我签自愿离职');
    expect(timeline.map((t) => t.title)).toContain('我把经过整段记了下来');
    expect(timeline.map((t) => t.title)).toContain('公司口头给的说法');
    expect(timeline.find((t) => t.title === '公司已经给过哪些文件')?.detail).toContain(
      '《解除劳动合同通知书》：有',
    );
    // 带日期的事件按用户填的那天记，不是按提交时刻；且**库里的日期部分就是用户填的那天**
    // （落零点会因为 UTC 归一变成前一天，见 intake.ts 的 dayNoonIso）
    expect(timeline.find((t) => t.title === '部门开会说要优化')?.happened_at).toBe(
      '2026-08-28 04:00:00',
    );
    expect(timeline.some((t) => t.kind === '我方动作')).toBe(true);

    // 「现在做这三件事」= 库里的三张行动卡，不只是屏幕上的三行字。
    // 【这一条钉的是接线，不是内容】比的是「库里落下的 == 包里声明的」，两边同源：
    // 把某个阶段的种子整段删成 []，这一句照样绿。内容逐字不变由
    // lib/domains/__tests__/labor-zero-change.test.ts ⑩ 比基线钉住。
    const actions = f.db
      .prepare('SELECT title, due_at, priority FROM action_items WHERE case_id = ? AND title != ? ORDER BY priority DESC')
      .all(f.caseA, '去打社保记录') as { title: string; due_at: string | null; priority: number }[];
    expect(actions.map((a) => a.title)).toEqual(
      LABOR.intakeStageActions['已收通知'].map((s) => s.title),
    );
    // 种子表里越靠前越急 → priority 越大；驾驶舱「只推一件事」推的就是它
    expect(actions[0].priority).toBeGreaterThan(actions[2].priority);
    expect(actions[0].due_at).not.toBeNull();
  });

  it('仲裁时效按记下的**最早**那件事起算（偏早＝偏保守），并写明起算点是暂定的', () => {
    const f = makeFixture();
    f.db.prepare('DELETE FROM deadlines WHERE case_id = ?').run(f.caseA);
    const res = submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake() });
    expect(res.ok && res.result.deadlinesAdded).toBe(1);

    const dl = f.db
      .prepare("SELECT kind, due_at, derived_from FROM deadlines WHERE case_id = ? AND kind = '仲裁时效'")
      .get(f.caseA) as { kind: string; due_at: string; derived_from: string };
    // 2026-08-28 起一年 → 2027-08-28（周六，顺延到周一 08-30）
    expect(dl.due_at.slice(0, 10)).toBe('2027-08-30');
    expect(dl.derived_from).toContain('2026-08-28');
    expect(dl.derived_from).toContain('保守估计');
  });

  it('一条日期都没记时**不落仲裁时效**——绝不拿"今天"当起算点，那会把到期日算晚', () => {
    const f = makeFixture();
    f.db.prepare('DELETE FROM deadlines WHERE case_id = ?').run(f.caseA);
    const res = submitIntake(f.db, {
      caseId: f.caseA,
      userId: f.userA,
      ...fullIntake({ events: [{ date: '', text: '权限被收走' }] }),
    });
    expect(res.ok && res.result.deadlinesAdded).toBe(0);
    expect(
      f.db.prepare('SELECT COUNT(*) n FROM deadlines WHERE case_id = ?').get(f.caseA),
    ).toEqual({ n: 0 });
  });

  it('风声 / 约谈中 阶段也不落仲裁时效：还没有可指认的侵害日', () => {
    const f = makeFixture();
    f.db.prepare('DELETE FROM deadlines WHERE case_id = ?').run(f.caseA);
    submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake({ stage: '约谈中' }) });
    expect(
      f.db.prepare('SELECT COUNT(*) n FROM deadlines WHERE case_id = ?').get(f.caseA),
    ).toEqual({ n: 0 });
  });

  it('别人的案件写不进去，且回的是"不存在"而不是 403', () => {
    const f = makeFixture();
    const res = submitIntake(f.db, { caseId: f.caseB, userId: f.userA, ...fullIntake() });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.status).toBe(404);
    expect(res.ok === false && res.errorCode).toBe('CASE_NOT_FOUND');
    // 乙的案子一个字都没被动
    expect(
      f.db.prepare('SELECT COUNT(*) n FROM timeline_events WHERE case_id = ?').get(f.caseB),
    ).toEqual({ n: 0 });
  });

  it('重复提交不长出第二套行动卡；**公司名改一次**也只订正那一行（时间线相反，只追加）', () => {
    const f = makeFixture();
    // 第一次凭记忆写成全角括号，第二次照营业执照订正成半角。这是同一个被申请人的两种写法，
    // 不是两家公司——按 name 收敛的话这里会留下两行「签约主体」。
    const first = '华衡永泰供应链管理（北京）有限公司';
    const fixed = '华衡永泰供应链管理(北京)有限公司';
    submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake({ companyName: first }) });
    const again = submitIntake(f.db, {
      caseId: f.caseA,
      userId: f.userA,
      ...fullIntake({ companyName: fixed }),
    });
    expect(again.ok && again.result.actionsAdded).toBe(0);

    const profiles = f.db
      .prepare('SELECT * FROM company_profiles WHERE case_id = ? ORDER BY id')
      .all(f.caseA) as CompanyProfileRow[];
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe(fixed);

    // 光看「只有一行」还不够：真正会被写进仲裁申请书的是 pickRespondent 取的那一行，
    // 它同档取 id 最早的一条。改名后它必须指向改后的名字，不能还指着用户刚划掉的错名。
    expect(pickRespondent(profiles)?.name).toBe(fixed);

    expect(
      f.db.prepare('SELECT COUNT(*) n FROM timeline_events WHERE case_id = ?').get(f.caseA),
    ).toEqual({ n: 12 });
  });

  // 上一条只有一行签约主体，取最早还是取最晚都会碰到同一行——它证不了
  // upsertCompanyProfileByRole 的 `ORDER BY id`（升序）。这条把存量形态补上：
  // agent 的 company_profile_upsert 按 name 收敛，用户换个写法说公司名就会再长一行
  // 签约主体。此时「改哪一行」才有区别，而下游 pickRespondent 只读 id 最早的那行。
  it('同案已有两行签约主体（agent 背调另写过一行）→ 首诊改名仍要落在下游读的那一行上', () => {
    const f = makeFixture();
    // 第一次首诊：凭记忆写了个错名，落成 id 最早的那行签约主体
    const wrong = '华衡永泰供应链管理（北京）有限公司';
    submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake({ companyName: wrong }) });

    // agent 背调时按另一个写法登记 → 按 name 收敛，长出第二行同角色
    upsertCompanyProfile(f.db, {
      caseId: f.caseA,
      name: '华衡永泰供应链管理有限公司',
      uscc: null,
      role: '签约主体',
      legalRep: null,
      riskNotes: null,
      sourcesJson: null,
    });
    expect(listProfiles(f.db, f.caseA).filter((p) => p.role === '签约主体')).toHaveLength(2);

    // 用户回首诊，照营业执照把公司名订正成半角括号的工商全称
    const fixed = '华衡永泰供应链管理(北京)有限公司';
    submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake({ companyName: fixed }) });

    // 真正会被写进仲裁申请书的是 pickRespondent 取的那一行（同档取 id 最早）。
    // 改到最晚那行的话：库里确实有 fixed、函数也返回成功，而这里读到的仍是用户刚划掉的错名。
    const profiles = listProfiles(f.db, f.caseA);
    expect(pickRespondent(profiles)?.name).toBe(fixed);
    expect(pickRespondent(profiles)?.name).not.toBe(wrong);
    // 只改不删：背调那行还在，没被首诊顺手抹掉
    expect(profiles.filter((p) => p.role === '签约主体')).toHaveLength(2);
  });

  it('中途写失败 → 一个字都不留：首诊落库全程一个事务', () => {
    const f = makeFixture();
    f.db.prepare('DELETE FROM deadlines WHERE case_id = ?').run(f.caseA);
    // 故障注入：写行动卡这一步崩掉。它排在第 4 步——案件字段、公司、时间线都已经写过了，
    // 正是「半截档案」会留在库里的那个位置。
    f.db.exec(
      "CREATE TRIGGER intake_action_boom BEFORE INSERT ON action_items " +
        "BEGIN SELECT RAISE(ABORT, '注入故障：写行动卡时崩了'); END",
    );
    expect(() =>
      submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake() }),
    ).toThrow(/注入故障/);
    f.db.exec('DROP TRIGGER intake_action_boom');

    // 写了一半的档案比没写更糟：用户看到时间线有、诉求没有，会以为是自己漏填了
    const row = f.db.prepare('SELECT * FROM cases WHERE id = ?').get(f.caseA) as Record<string, unknown>;
    expect(row.stage).toBe('风声');
    expect(row.employed_from).toBeNull();
    expect(row.monthly_wage_fen).toBeNull();
    expect(row.goal).toBeNull();
    expect(row.bottom_line).toBeNull();
    for (const table of ['timeline_events', 'company_profiles', 'deadlines']) {
      expect(
        f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE case_id = ?`).get(f.caseA),
      ).toEqual({ n: 0 });
    }
  });
});

describe('必填项：服务端才是权威（前端那道可以被绕过）', () => {
  const bad: [string, Record<string, unknown>, string][] = [
    ['阶段不在词表里', { stage: '随便写' }, 'INVALID_STAGE'],
    ['公司名空着', { companyName: '   ' }, 'INVALID_COMPANY_NAME'],
    ['入职日期空着', { employedFrom: '' }, 'INVALID_EMPLOYED_FROM'],
    ['入职日期不是真日子', { employedFrom: '2026-02-31' }, 'INVALID_EMPLOYED_FROM'],
    ['入职日期在未来', { employedFrom: '2027-01-01' }, 'INVALID_EMPLOYED_FROM'],
    ['月工资不是正整数分', { monthlyWageFen: 0 }, 'INVALID_MONTHLY_WAGE'],
    ['月工资传了字符串', { monthlyWageFen: '22000' }, 'INVALID_MONTHLY_WAGE'],
    ['一项诉求都没选', { goals: [] }, 'INVALID_GOALS'],
  ];

  for (const [name, over, code] of bad) {
    it(`${name} → ${code}，且库里一个字都不写`, () => {
      const f = makeFixture();
      const res = submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake(over) });
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.errorCode).toBe(code);
      const row = f.db.prepare('SELECT * FROM cases WHERE id = ?').get(f.caseA) as Record<string, unknown>;
      expect(row.employed_from).toBeNull();
      expect(row.monthly_wage_fen).toBeNull();
      expect(
        f.db.prepare('SELECT COUNT(*) n FROM timeline_events WHERE case_id = ?').get(f.caseA),
      ).toEqual({ n: 0 });
    });
  }
});

/**
 * 首诊落的这条仲裁时效，它的 derived_from 会原样渲染给用户（驾驶舱期限卡）、逐字进 agent 的
 * system context、进引用块。所以这里盯的不是「有没有写依据」，而是**写进去的是不是真依据**——
 * 一句「依据卡未取到，以上为代码内置副本，可能已陈旧」在卡好端端在库里的时候出现，
 * 就是我们自己对用户说的假话，而它长得和尽责的免责声明一模一样。
 */
describe('仲裁时效的推算依据：两态都要对', () => {
  /** __tests__ → cases → lib → src → app → 仓库根 */
  const REAL_KNOWLEDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..', 'knowledge');
  const ORIGINAL_ENV = process.env.LAWER_KNOWLEDGE_DIR;
  let tempDir: string | null = null;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.LAWER_KNOWLEDGE_DIR;
    else process.env.LAWER_KNOWLEDGE_DIR = ORIGINAL_ENV;
    knowledge.__resetForTest();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  /** 落一条仲裁时效并把它的 derived_from 取回来 */
  function derivedFromOfLimitation(): string {
    const f = makeFixture();
    f.db.prepare('DELETE FROM deadlines WHERE case_id = ?').run(f.caseA);
    const res = submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake() });
    expect(res.ok && res.result.deadlinesAdded).toBe(1);
    return (
      f.db
        .prepare("SELECT derived_from FROM deadlines WHERE case_id = ? AND kind = '仲裁时效'")
        .get(f.caseA) as { derived_from: string }
    ).derived_from;
  }

  it('卡在库里 → 写的是卡里的逐字条文，不含「依据卡未取到」', () => {
    process.env.LAWER_KNOWLEDGE_DIR = REAL_KNOWLEDGE_DIR;
    knowledge.__resetForTest();
    const derived = derivedFromOfLimitation();

    // 这两句只在**卡**里有，代码内置副本没有；用它们区分两态，光看「不含未取到」区分不出来
    expect(derived).toContain('期间包括法定期间和人民法院指定的期间');
    expect(derived).toContain('仲裁期间包括法定期间和仲裁委员会指定期间');
    // 【为什么这里从「待核实」改成「原文核实」】2026-09-07 核实闭卷：这张期间通则卡
    // 已追到 ssf.gov.cn 的官方原件并逐字核过，confidence 随之升档。
    // 这条判据钉的是"把卡里的 confidence 如实带出来"，不是那个具体档位——
    // 所以顺着卡走，别把当时的档位写死成期望。
    expect(derived).toContain('依据卡 statute-qijian-jisuan-tongze，可信度：原文核实');
    expect(derived).not.toContain('依据卡未取到');
    expect(derived).not.toContain('可能已陈旧');
  });

  it('卡真的不在了 → 才回落内置副本，并明说它可能已陈旧', () => {
    // 知识库是好的（index 能读、有别的卡），单单缺期间计算通则那一张
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-knowledge-'));
    fs.mkdirSync(path.join(tempDir, 'packs'));
    fs.writeFileSync(path.join(tempDir, 'packs', 'other.md'), '---\nid: other-card\n---\n无关卡\n');
    fs.writeFileSync(
      path.join(tempDir, 'index.json'),
      JSON.stringify([
        {
          id: 'other-card',
          type: '法条卡',
          title: '一张无关的卡',
          keywords: [],
          applies_to: [],
          region: '全国',
          sources: [],
          confidence: '待核实',
          updated: '2026-08-19',
          path: 'packs/other.md',
        },
      ]),
    );
    process.env.LAWER_KNOWLEDGE_DIR = tempDir;
    knowledge.__resetForTest();
    const derived = derivedFromOfLimitation();

    // 读不到卡不能让期限推算停摆，但也不能假装依据是新的
    expect(derived).toContain('依据卡未取到');
    expect(derived).toContain('可能已陈旧');
    expect(derived).toContain('第八十五条');
    // 到期日照算不误
    expect(derived).toContain('2027-08-30');
  });
});

/**
 * **首诊自动落档：说得死才定型，其余一律留 null**（2026-09-10/11 台账「结构化决定」票）。
 *
 * 【它守什么】首诊是绝大多数用户唯一一次批量写时间线的机会，而它走的是直落库那条路
 *（store.insertTimelineEvent），不经 timeline_add 那道校验。两个方向的错都要拦住：
 *   · 该定的没定 —— 用户在首诊里明确答过"公司给过《解除劳动合同通知书》"，
 *     那条记录却仍要靠谓词去猜，而谓词认得的正是这一格里最不像自然语言的一段拼接文本；
 *   · 不该定的硬定 —— 类型一旦落下就**压过**谓词、连兜底都不再跑，
 *     猜错一次比没有类型更贵（用户以为自己已经说清楚了）。
 *
 * 【变异臂】把 laborIntakeEventType 的 counterpartDocs 分支整段删掉 ⇒ ①②③ 红；
 * 把 docAnswerAffirmative 的否定式前置判断去掉（「没有」里含「有」）⇒ ② 红；
 * 把认不准判定移回否定式**后面** ⇒ ⑦⑧ 红（「无法确定」以否定字开头，会被读成"没给"）；
 * 把 answers/counterpartWording 也定型 ⇒ ④ 红。
 */
describe('首诊落档的事件类型', () => {
  const typesOf = (f: ReturnType<typeof makeFixture>) =>
    Object.fromEntries(
      (
        f.db
          .prepare('SELECT title, event_type FROM timeline_events WHERE case_id = ? ORDER BY id')
          .all(f.caseA) as { title: string; event_type: string | null }[]
      ).map((r) => [r.title, r.event_type]),
    );

  it('① 答「有」的那份解除通知书 ⇒ 那条聚合记录落 company_termination', () => {
    const f = makeFixture();
    submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake() });
    expect(typesOf(f)[LABOR.copy.site.intakeCounterpartDocsTitle]).toBe('company_termination');
  });

  it('🔴 ② 三格全答「没有」⇒ company_other，不再被谓词当成公司作出了解除决定', () => {
    // 【这是一处真的误判】那条记录的正文逐格写着「《解除劳动合同通知书》：没有」，
    // 而谓词按小句判时，否定词落在决定动作**后面**、未定态那条压不住——
    // 于是一个明确说"公司什么纸都没给"的人，三条要件当场写着「成立·待证」。
    const f = makeFixture();
    submitIntake(f.db, {
      caseId: f.caseA,
      userId: f.userA,
      ...fullIntake({
        companyDocs: { terminationNotice: '没有', settlementAgreement: '没有', otherPaper: '没有' },
      }),
    });
    expect(typesOf(f)[LABOR.copy.site.intakeCounterpartDocsTitle]).toBe('company_other');
  });

  it('③ 只答了协商解除协议 ⇒ company_negotiation（协商是提议，不是单方决定）', () => {
    const f = makeFixture();
    submitIntake(f.db, {
      caseId: f.caseA,
      userId: f.userA,
      ...fullIntake({
        companyDocs: { terminationNotice: '没有', settlementAgreement: '有', otherPaper: '没有' },
      }),
    });
    expect(typesOf(f)[LABOR.copy.site.intakeCounterpartDocsTitle]).toBe('company_negotiation');
  });

  it('🔴 ④ 认不准的那几格一律 null：用户自己记的那几句、对方口头说法、有一格「不确定」', () => {
    const f = makeFixture();
    submitIntake(f.db, {
      caseId: f.caseA,
      userId: f.userA,
      ...fullIntake({
        companyDocs: { terminationNotice: '不确定', settlementAgreement: '没有', otherPaper: '没有' },
      }),
    });
    const types = typesOf(f);
    expect(types['HR 约谈让我签自愿离职'], '用户自己记的那一句是自由叙事，不许替他挑').toBeNull();
    expect(types[LABOR.copy.site.intakeCounterpartWordingTitle], '对方口头说法认不准').toBeNull();
    expect(types[LABOR.copy.site.intakeCounterpartDocsTitle], '有一格答不出是有是无就别定').toBeNull();
  });

  it('⑤ 整段自述落 my_other：它是叙事不是事件记录（沿用裁定，不参与判定）', () => {
    const f = makeFixture();
    submitIntake(f.db, { caseId: f.caseA, userId: f.userA, ...fullIntake() });
    expect(typesOf(f)[LABOR.copy.site.intakeFreeTextTitle]).toBe('my_other');
  });

  it('🔴 ⑦ 「无法确定」是认不准，不是「没给」⇒ 落 null 回落到谓词', () => {
    // 【它与 ② 只差一格的字】「无法确定」「没法确定」「未必」都以否定字开头，
    // 而否定式先判的形态是：它们被读成明确的"没给"，这条记录当场落 company_other——
    // 一个说自己记不清的人，被系统替他答成了"公司什么纸都没给"，
    // 而类型一旦落下就压过谓词、连兜底都不再跑。MCP 那条路收的是自由文本，这几句正是它的常见写法。
    const f = makeFixture();
    submitIntake(f.db, {
      caseId: f.caseA,
      userId: f.userA,
      ...fullIntake({
        companyDocs: { terminationNotice: '无法确定', settlementAgreement: '没有', otherPaper: '没有' },
      }),
    });
    expect(typesOf(f)[LABOR.copy.site.intakeCounterpartDocsTitle]).toBeNull();
  });

  it('🔴 ⑧ 三态逐句直探：认不准 ⇒ null、明确没给 ⇒ company_other、明确给过 ⇒ company_termination', () => {
    // 逐句探的是**取值口径本身**，不经首诊那条落库路：③⑦ 各钉一句，这里钉的是整张表。
    const docType = (terminationNotice: string) =>
      LABOR.intakeEventType?.({
        source: 'counterpartDocs',
        kind: '公司动作',
        title: LABOR.copy.site.intakeCounterpartDocsTitle,
        answers: { terminationNotice, settlementAgreement: '没有', otherPaper: '没有' },
      }) ?? null;

    for (const s of ['不确定', '无法确定', '没法确定', '未必', '说不清', '记不清', '不记得']) {
      expect(docType(s), `「${s}」是认不准，不是"没给"`).toBeNull();
    }
    for (const s of ['没有', '没', '未收到', '无']) {
      expect(docType(s), `「${s}」是明确的"没给"`).toBe('company_other');
    }
    for (const s of ['有', '给过', '收到了', '签了']) {
      expect(docType(s), `「${s}」是明确的"给过"`).toBe('company_termination');
    }
  });

  it('🔴 ⑥ 包里的定型函数回了一个没声明过的 id ⇒ 落 null 并点名，不是带着它进库', () => {
    // 首诊走的是直落库那条路（store.insertTimelineEvent），不经 timeline_add 那道校验。
    // 不核的形态是：那条记录带着一个谁都不认的取值进库——判定既不按类型走
    //（不在任何 acceptsType 里）、也不回落到谓词（它"有类型"），这个槽从此恒缺，
    // 而首诊回包 201、每一行都读得通。落 null 是回到定型之前的行为，方向保守；
    // 但它不许静默——静默与"这一格本来就定不下来"完全同形。
    const f = makeFixture();
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      const res = submitIntakeInto(
        f.db,
        f.caseA,
        { ...fullIntake(), userId: f.userA } as never,
        { ...LABOR, intakeEventType: () => '压根没声明过的取值' },
      );
      expect(res.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(Object.values(typesOf(f)).every((v) => v === null), '一个没声明过的取值被落进了库').toBe(true);
    expect(errors.length, '落 null 了，却一句话都没说').toBeGreaterThan(0);
    expect(String(errors[0][0])).toContain('压根没声明过的取值');
  });
});
