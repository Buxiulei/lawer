// app/src/lib/graph/__tests__/build.test.ts
// 库 → CompanyGraph 的取数与口径。
//
// 这组盯的不是"能不能拼出个对象"，而是几条**会静默说错话**的口径：
// 涉诉数按不按年限截断、圈层怎么定、认不出的置信度往哪边倒、叙事字段编不编。
// 每条都配了一句「改坏它会怎样」，那才是这条测试存在的理由。
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '@/lib/db/migrate';
import { mockCompanyGraph } from '@/app/_mock/company-graph';
import { buildCompanyGraph } from '../build';
import { GRAPH_TIER_LABELS } from '../contract';

let db: Database.Database;
let caseId: number;
let otherCaseId: number;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const userId = Number(
    db
      .prepare(
        "INSERT INTO users (phone_hash, auth_status, created_at) VALUES ('h1', '未认证', '2026-08-01T00:00:00.000Z')",
      )
      .run().lastInsertRowid,
  );
  const insertCase = db.prepare(
    "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, ?, '风声', '2026-08-01T00:00:00.000Z')",
  );
  caseId = Number(insertCase.run(userId, '本案').lastInsertRowid);
  otherCaseId = Number(insertCase.run(userId, '别的案').lastInsertRowid);
});

function addProfile(
  onCase: number,
  name: string,
  extra: Partial<{
    role: string;
    uscc: string;
    legal_rep: string;
    reg_capital: string;
    risk_notes: string;
    investigated_at: string;
  }> = {},
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO company_profiles
           (case_id, name, role, uscc, legal_rep, reg_capital, risk_notes, investigated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-08-02T00:00:00.000Z')`,
      )
      .run(
        onCase,
        name,
        extra.role ?? '签约主体',
        extra.uscc ?? null,
        extra.legal_rep ?? null,
        extra.reg_capital ?? null,
        extra.risk_notes ?? null,
        extra.investigated_at ?? null,
      ).lastInsertRowid,
  );
}

function addLitigation(profileId: number, caseNo: string, isLabor: number, judgedAt: string | null) {
  db.prepare(
    `INSERT INTO company_litigation (company_profile_id, case_no, is_labor, judged_at, created_at)
     VALUES (?, ?, ?, ?, '2026-08-02T00:00:00.000Z')`,
  ).run(profileId, caseNo, isLabor, judgedAt);
}

function addWatch(onCase: number, profileId: number | null, tier: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO company_watches (case_id, company_profile_id, name, tier, status, created_at)
         VALUES (?, ?, 'w', ?, 'active', '2026-08-02T00:00:00.000Z')`,
      )
      .run(onCase, profileId, tier).lastInsertRowid,
  );
}

function addWatchEvent(watchId: number, kind: string, severity: string, detectedAt: string) {
  db.prepare(
    `INSERT INTO company_watch_events (watch_id, kind, severity, detail, detected_at, created_at)
     VALUES (?, ?, ?, '细节', ?, '2026-08-02T00:00:00.000Z')`,
  ).run(watchId, kind, severity, detectedAt);
}

describe('没有主体时返回 null，不是空图', () => {
  it('一个 company_profiles 都没有 ⇒ null', () => {
    expect(buildCompanyGraph(db, caseId)).toBeNull();
  });

  /**
   * 变异臂：把 `if (profiles.length === 0) return null` 改成返回空图，
   * 这条会红。它守的是界面——空图渲染成一张什么都没有的画布，
   * null 才走得到「公司调查完成后这里会生成关系图谱」那句指路。
   */
  it('null 与「空图」不是一回事：调用方要能区分', () => {
    addProfile(caseId, '甲公司');
    const graph = buildCompanyGraph(db, caseId);
    expect(graph).not.toBeNull();
    expect(graph!.nodes).toHaveLength(1);
  });
});

describe('涉诉计数：不按年限截断（少报比多报贵）', () => {
  it('judged_at 为空的劳动争议照样计入，非劳动争议不计入', () => {
    const p = addProfile(caseId, '甲公司');
    addLitigation(p, '(2019)京0105民初1号', 1, '2019-01-01'); // 五年以上，仍要算
    addLitigation(p, '(2026)京0105民初2号', 1, null); // 只有案号没有全文
    addLitigation(p, '(2026)京0105民初3号', 1, '2026-01-01');
    addLitigation(p, '(2026)京0105民初4号', 0, '2026-01-01'); // 非劳动争议

    const graph = buildCompanyGraph(db, caseId)!;
    expect(graph.nodes[0].litigationCount).toBe(3);
  });

  /**
   * 变异臂（这条是本文件最该活着的一条）：给 laborLitigationCounts 加一句
   * `AND l.judged_at >= date('now','-5 years')` —— 计数会掉到 1
   * （2019 那条被年限筛掉、judged_at 为空那条被 NULL 比较筛掉），
   * 即「涉诉多的公司显示得比实际干净」。这条断言会红。
   */
  it('五年前的、以及没有判决日期的，都不许被筛掉', () => {
    const p = addProfile(caseId, '甲公司');
    addLitigation(p, '(2015)京0105民初9号', 1, '2015-01-01');
    addLitigation(p, '(2026)京0105民初8号', 1, null);
    expect(buildCompanyGraph(db, caseId)!.nodes[0].litigationCount).toBe(2);
  });

  it('别的案件的主体不算进本案', () => {
    const mine = addProfile(caseId, '甲公司');
    const theirs = addProfile(otherCaseId, '乙公司');
    addLitigation(mine, 'A', 1, null);
    addLitigation(theirs, 'B', 1, null);
    addLitigation(theirs, 'C', 1, null);

    const graph = buildCompanyGraph(db, caseId)!;
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].litigationCount).toBe(1);
  });
});

describe('圈层', () => {
  it('daily/weekly/archive → 1/2/3，没有盯梢行 → 3', () => {
    const a = addProfile(caseId, '甲');
    const b = addProfile(caseId, '乙');
    const c = addProfile(caseId, '丙');
    addProfile(caseId, '丁'); // 不开盯
    addWatch(caseId, a, 'daily');
    addWatch(caseId, b, 'weekly');
    addWatch(caseId, c, 'archive');

    const tiers = buildCompanyGraph(db, caseId)!.nodes.map((n) => n.tier);
    expect(tiers).toEqual([1, 2, 3, 3]);
  });

  /**
   * 变异臂：把「取最强」改成「按行序取最后一行」，这条会红。
   * 圈层在界面上是"我们盯得多勤"的承诺，按插入顺序取会让同一份数据
   * 因为写入次序不同而显示成不同的承诺。
   */
  it('同一主体开了多个盯梢时取最强的那档，与插入顺序无关', () => {
    const a = addProfile(caseId, '甲');
    addWatch(caseId, a, 'daily');
    addWatch(caseId, a, 'archive'); // 后插入的是最弱档
    expect(buildCompanyGraph(db, caseId)!.nodes[0].tier).toBe(1);
  });

  it('圈层文案用 contract 的字典，且与 demo mock 逐字一致', () => {
    addProfile(caseId, '甲');
    expect(buildCompanyGraph(db, caseId)!.meta.tiers).toEqual(GRAPH_TIER_LABELS);
    // 演示图与真数据图不能对同一个圈层说两种话
    expect(mockCompanyGraph.meta.tiers).toEqual(GRAPH_TIER_LABELS);
  });
});

describe('事件', () => {
  it('urgent 只由 severity 决定；事件计数按主体分开', () => {
    const a = addProfile(caseId, '甲');
    const b = addProfile(caseId, '乙');
    const wa = addWatch(caseId, a, 'daily');
    addWatch(caseId, b, 'daily');
    addWatchEvent(wa, '简易注销公告', 'urgent', '2026-08-10T00:00:00.000Z');
    addWatchEvent(wa, '状态变更', 'info', '2026-08-09T00:00:00.000Z');

    const graph = buildCompanyGraph(db, caseId)!;
    expect(graph.nodes.map((n) => n.eventCount)).toEqual([2, 0]);
    expect(graph.events.map((e) => e.urgent)).toEqual([true, false]);
    expect(graph.events.every((e) => e.nodeId === String(a))).toBe(true);
  });

  it('挂不到主体的盯梢（company_profile_id 为空）不产出事件', () => {
    addProfile(caseId, '甲');
    const orphan = addWatch(caseId, null, 'daily');
    addWatchEvent(orphan, '状态变更', 'urgent', '2026-08-10T00:00:00.000Z');
    expect(buildCompanyGraph(db, caseId)!.events).toHaveLength(0);
  });
});

describe('关系边', () => {
  it('端点跨案的脏边不返回', () => {
    const mine = addProfile(caseId, '甲');
    const theirs = addProfile(otherCaseId, '乙');
    db.prepare(
      `INSERT INTO company_relations (case_id, from_profile_id, to_profile_id, relation, confidence, created_at)
       VALUES (?, ?, ?, '持股100%', '高', '2026-08-02T00:00:00.000Z')`,
    ).run(caseId, mine, theirs);
    const graph = buildCompanyGraph(db, caseId)!;
    expect(graph.edges).toHaveLength(0);
  });

  /**
   * 变异臂：把 normalizeConfidence 的兜底从 '低' 改成 '高'，这条会红。
   * 取不准时偏向报警：少信一条边只是少一条线索，
   * 多信一条边会让人拿着一条没证据的关系去开庭。
   */
  it('库里认不出的 confidence 一律降到「低」，不是抬到「高」', () => {
    const a = addProfile(caseId, '甲');
    const b = addProfile(caseId, '乙');
    db.prepare(
      `INSERT INTO company_relations (case_id, from_profile_id, to_profile_id, relation, confidence, created_at)
       VALUES (?, ?, ?, '同地址', 'unknown-value', '2026-08-02T00:00:00.000Z')`,
    ).run(caseId, a, b);
    expect(buildCompanyGraph(db, caseId)!.edges[0].confidence).toBe('低');
  });
});

describe('不编造', () => {
  /**
   * 变异臂：给 confidenceNote/updateNote 填一句通用话术（"数据来源可靠、持续更新中"
   * 这类），这条会红。这两个字段在 demo 里是调查员写的叙事，真数据没有对应来源；
   * 填上去读起来体面，但那是我们替用户签的字。
   */
  it('没有来源的叙事字段给空串，不拿通用话术填', () => {
    addProfile(caseId, '甲');
    const meta = buildCompanyGraph(db, caseId)!.meta;
    expect(meta.confidenceNote).toBe('');
    expect(meta.updateNote).toBe('');
  });

  it('没有 risk_notes 的主体，说清「没有」而不是留空引用块', () => {
    addProfile(caseId, '甲');
    const note = buildCompanyGraph(db, caseId)!.nodes[0].note;
    expect(note).not.toBe('');
    expect(note).toContain('还没有落进档案的判断说明');
  });

  it('工商字段缺失时给 undefined，不给空串', () => {
    addProfile(caseId, '甲');
    const node = buildCompanyGraph(db, caseId)!.nodes[0];
    expect(node.creditCode).toBeUndefined();
    expect(node.legalRep).toBeUndefined();
    expect(node.regCapital).toBeUndefined();
  });

  it('meta 的两个日期都是可解析的真日期，不会渲染成 Invalid Date', () => {
    const a = addProfile(caseId, '甲', { investigated_at: '2026-08-05T00:00:00.000Z' });
    const w = addWatch(caseId, a, 'daily');
    addWatchEvent(w, '状态变更', 'info', '2026-08-20T00:00:00.000Z');
    const meta = buildCompanyGraph(db, caseId)!.meta;
    expect(Number.isNaN(new Date(meta.generated).getTime())).toBe(false);
    expect(Number.isNaN(new Date(meta.updated).getTime())).toBe(false);
    // updated 要跟得上最新的事件，否则页脚那句「更新于」是旧的
    expect(meta.updated).toBe('2026-08-20T00:00:00.000Z');
  });
});
