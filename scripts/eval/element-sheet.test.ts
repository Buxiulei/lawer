/**
 * **要件级断言夹具**（设计稿 §4.5-2、S6 判据二）：拿两个真剧本的档案跑要件表，
 * 与**预置的结构期望**逐条比对——比的是结构（要件 id → 状态 / 举证责任 / 缺哪几个槽），
 * 不是文本。
 *
 * 【为什么不比文本】剧本判据里那一批 judge 条目比的是模型写出来的话；要件表不是模型写的，
 * 它是服务端从档案推出来的。拿文本去比的形态是：某次措辞润色让十几条判据一起红，
 * 于是它们被顺手改绿——而真正该拦的事（某个要件的状态算错了）混在里面一起过了。
 *
 * 【为什么挑这两个剧本】它们是同一套机制的两个极端：
 *   · S05「被停权限架空」——公司什么文件都不给。**档案里几乎全是〔未记录〕**，
 *     所以它验的是"缺失 ≠ 不成立"：一个手上没有任何纸的人，要件表不许把他的诉求判死。
 *   · S07「工资被拖欠，想立刻辞职」——欠薪这条线，档案里有一条公司动作但没有任何书证，
 *     所以它验的是"自述撑起来的要件只能到『成立·待证』"，以及举证责任落在证据偏在那一档。
 *
 * 【变异臂】
 *   · 把 elements.ts 里「成立」的门槛从 ≥ 书证 改成 ≥ 自述 ⇒ S07 的期望当场红；
 *   · 把「有槽位不在档 ⇒ 缺失」改成「⇒ 不成立」⇒ S05 的红线断言红；
 *   · 删掉某个要件的 basis ⇒ 该行 burden 被压成 unverified ⇒ 举证责任那几行红；
 *   · 让某条争点的 nextStep 返回空串 ⇒ 链接率断言红。
 */
import { describe, expect, it } from 'vitest';

import { makeAgentFixture } from '../../app/src/lib/agent/__tests__/fixtures';
import { buildElementSheet, type ElementRow } from '../../app/src/lib/cases/elements';
import { buildIssueTable } from '../../app/src/lib/cases/issue-table';
import { DEFAULT_DOMAIN, DOMAINS } from '../../app/src/lib/domains/registry';
import { SCENARIOS } from './scenarios';

const LABOR = DOMAINS[DEFAULT_DOMAIN];

type Db = ReturnType<typeof makeAgentFixture>['db'];

/** 把剧本的 setup 跑进一个干净库，再按剧本的诉求登记 claims（要件表按诉求分组）。 */
function sheetFor(scenarioId: string, claimKinds: string[]) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`剧本 ${scenarioId} 不在 SCENARIOS 里——夹具指向了一个不存在的对照物`);
  const f = makeAgentFixture();
  scenario.setup(f.db as unknown as Parameters<typeof scenario.setup>[0], f.caseId);
  for (const kind of claimKinds) {
    f.db
      .prepare("INSERT INTO claims (case_id, kind, amount_fen, status) VALUES (?, ?, 0, 'draft')")
      .run(f.caseId, kind);
  }
  return { fixture: f, sheet: build(f.db, f.caseId, claimKinds) };
}

function build(db: Db, caseId: number, claimKinds: string[]) {
  const caseRow = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as Record<string, unknown>;
  return buildElementSheet(
    {
      case: {
        employed_from: (caseRow.employed_from as string) ?? null,
        position: (caseRow.position as string) ?? null,
        monthly_wage_fen: (caseRow.monthly_wage_fen as number) ?? null,
        contract_count: (caseRow.contract_count as string) ?? null,
      },
      claims: db.prepare('SELECT kind, source_tier FROM claims WHERE case_id = ?').all(caseId) as {
        kind: string;
        source_tier: string;
      }[],
      timeline: db.prepare('SELECT kind, source_tier FROM timeline_events WHERE case_id = ?').all(caseId) as {
        kind: string;
        source_tier: string;
      }[],
      companies: db.prepare('SELECT role, source_tier FROM company_profiles WHERE case_id = ?').all(caseId) as {
        role: string;
        source_tier: string;
      }[],
      evidence: db.prepare('SELECT category, voided_at FROM evidence WHERE case_id = ?').all(caseId) as {
        category: string;
        voided_at: string | null;
      }[],
    },
    LABOR.elementCards ?? [],
    claimKinds,
  );
}

/** 结构化投影：判据比的就是它。 */
const shape = (rows: readonly ElementRow[]) =>
  Object.fromEntries(rows.map((r) => [r.id, { status: r.status, burden: r.burden }]));

describe('S05 被停权限架空：公司什么文件都不给', () => {
  // 【预置期望】这个人手上一张纸都没有：首诊四项没填、证据库空的，只登记过对方主体。
  // 所以除了"劳动关系存在"（对方主体已登记、但入职日还空着 ⇒ 仍缺一格）之外全是缺失。
  const EXPECTED = {
    '2N-1': { status: '缺失', burden: 'claimant' },
    '2N-2': { status: '缺失', burden: 'claimant' },
    '2N-3': { status: '缺失', burden: 'reversed_interpretation' },
    '2N-4': { status: '成立·待证', burden: 'claimant' },
    '2N-5': { status: '缺失', burden: 'reversed_procedure_rules' },
  };

  const { sheet } = sheetFor('S05', ['2N']);

  it('要件表逐行与预置期望一致（结构比对，不比文本）', () => {
    expect(shape(sheet.rows)).toEqual(EXPECTED);
  });

  it('🔴 红线：〔未记录〕不许被算成「不成立」', () => {
    expect(sheet.rows.filter((r) => r.status === '不成立')).toEqual([]);
    // 而且缺的那几格必须点名——只说"缺失"不说缺哪一格，用户不知道该补什么
    for (const r of sheet.rows.filter((x) => x.status === '缺失')) {
      expect(r.missingSlots.length, `${r.id} 说自己缺，却说不出缺哪一格`).toBeGreaterThan(0);
      expect(r.unresolvedSlots, `${r.id} 有认不出来的槽位（配置错了）`).toEqual([]);
    }
  });

  it('争点 → 行动卡/追问 链接率 100%', () => {
    const table = buildIssueTable(sheet.rows, { counterpartyDecisionOnFile: false }, sheet.rendered);
    expect(table.rows.length).toBe(sheet.rows.filter((r) => r.status !== '成立').length);
    for (const row of table.rows) {
      expect(row.nextStep.trim(), `${row.id} 没有下一步`).not.toBe('');
      expect(row.anchors.length, `${row.id} 没有依据锚点`).toBeGreaterThan(0);
    }
  });
});

describe('S07 工资被拖欠：有一条公司动作，但一张书证都没有', () => {
  const EXPECTED = {
    '欠薪-1': { status: '缺失', burden: 'claimant' },
    '欠薪-2': { status: '缺失', burden: 'claimant' },
    '欠薪-3': { status: '缺失', burden: 'reversed_procedure_rules' },
    '欠薪-4': { status: '成立·待证', burden: 'claimant' },
  };

  const { fixture, sheet } = sheetFor('S07', ['欠薪']);

  it('要件表逐行与预置期望一致', () => {
    expect(shape(sheet.rows)).toEqual(EXPECTED);
  });

  it('把工资流水传进证据库之后，那一项从「缺失」翻成「成立」（自证上面不是恒缺失）', () => {
    // 证据行要挂一个真的 files 行（file_id NOT NULL）：这个剧本没上传过文件，先补一行。
    const fileId = Number(
      fixture.db
        .prepare("INSERT INTO files (sha256, size, mime, enc_path) VALUES ('sha-x', 1, 'application/pdf', '/dev/null')")
        .run().lastInsertRowid,
    );
    fixture.db
      .prepare(
        `INSERT INTO evidence (case_id, user_id, file_id, name, category, status)
         VALUES (?, ?, ?, '工资流水.pdf', '工资', '已上传')`,
      )
      .run(fixture.caseId, fixture.userId, fileId);
    const after = build(fixture.db, fixture.caseId, ['欠薪']);
    expect(after.rows.find((r) => r.id === '欠薪-3')?.status).toBe('成立');
  });
});

describe('地板：两份夹具指向的是真剧本、真要件卡', () => {
  it('S05 / S07 都在 SCENARIOS 里，且要件卡覆盖到这两项诉求', () => {
    for (const id of ['S05', 'S07']) {
      expect(SCENARIOS.map((s) => s.id), `${id} 不在剧本集里`).toContain(id);
    }
    for (const kind of ['2N', '欠薪']) {
      expect(
        (LABOR.elementCards ?? []).filter((c) => c.claimKind === kind).length,
        `${kind} 一个要件都没有`,
      ).toBeGreaterThan(0);
    }
  });
});
