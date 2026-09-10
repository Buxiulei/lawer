/**
 * **要件级断言夹具**（设计稿 §4.5-2、S6 判据二）：拿三个真剧本的档案跑要件表，
 * 与**预置的结构期望**逐条比对——比的是结构（要件 id → 状态 / 举证责任 / 缺哪几个槽），
 * 不是文本。
 *
 * 【为什么不比文本】剧本判据里那一批 judge 条目比的是模型写出来的话；要件表不是模型写的，
 * 它是服务端从档案推出来的。拿文本去比的形态是：某次措辞润色让十几条判据一起红，
 * 于是它们被顺手改绿——而真正该拦的事（某个要件的状态算错了）混在里面一起过了。
 *
 * 【为什么挑这三个剧本】它们是同一套机制的三个极端：
 *   · S05「被停权限架空」——公司什么文件都不给。**档案里几乎全是〔未记录〕**，
 *     所以它验的是"缺失 ≠ 不成立"：一个手上没有任何纸的人，要件表不许把他的诉求判死。
 *   · S07「工资被拖欠，想立刻辞职」——欠薪这条线，档案里有一条公司动作但没有任何书证，
 *     所以它验的是"自述撑起来的要件只能到『成立·待证』"，以及举证责任落在证据偏在那一档。
 *   · S16「风闻裁员，只传了一份员工手册」（S6 backlog ②）——档案里**有**一件材料，
 *     而它落在一个很宽的类别下。它验的是那次分三轮做的收窄：一份员工手册不算
 *    「公司作出过解除决定」。这个形态此前在跑批面一个样本都没有。
 *
 * 【变异臂】
 *   · 把 elements.ts 里「成立」的门槛从 ≥ 书证 改成 ≥ 自述 ⇒ S07 的期望当场红；
 *   · 把「有槽位不在档 ⇒ 缺失」改成「⇒ 不成立」⇒ S05 的红线断言红；
 *   · 把 N-2a 的 satisfiedBy 改回只认「evidence:公司文件」⇒ S16 的三态与档位断言红；
 *   · 删掉 N-2b 的 slotChecks ⇒ S16 的缺口点名断言红；
 *   · 删掉某个要件的 basis ⇒ 该行 burden 被压成 unverified ⇒ 举证责任那几行红；
 *   · 让某条争点的 nextStep 返回空串 ⇒ 链接率断言红。
 */
import { describe, expect, it } from 'vitest';

import { makeAgentFixture } from '../../app/src/lib/agent/__tests__/fixtures';
import { runClaimCalc } from '../../app/src/lib/cases/claims';
import { buildElementSheet, type ElementRow } from '../../app/src/lib/cases/elements';
import { buildIssueTable, counterpartyDecisionOnFile } from '../../app/src/lib/cases/issue-table';
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

/**
 * 档案的结构化子集。**要件表与争点表读的必须是同一份**——各取一次的形态是，
 * 规则三那半边与要件表用的不是同一把尺，于是要件表说「缺」的时候规则三说「在档」
 *（lib/cases/issue-table.ts 的 counterpartyDecisionOnFile 抬头就是这条）。
 */
function factsOf(db: Db, caseId: number) {
  const caseRow = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as Record<string, unknown>;
  return {
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
    // 【title / detail 必须一并取回】挂了取值判定的时间线槽读的就是这两段字
    //（lib/cases/elements.ts 的 ElementFactsView）。少取一列的形态是：判定读到一段空字符串、
    // 判不过、整条要件落「缺失」——方向保守，却没有任何一处说得出是因为那段字没取回来。
    timeline: db
      .prepare('SELECT kind, source_tier, title, detail FROM timeline_events WHERE case_id = ?')
      .all(caseId) as {
      kind: string;
      source_tier: string;
      title: string;
      detail: string | null;
    }[],
    companies: db.prepare('SELECT role, source_tier FROM company_profiles WHERE case_id = ?').all(caseId) as {
      role: string;
      source_tier: string;
    }[],
    evidence: db.prepare('SELECT category, voided_at FROM evidence WHERE case_id = ?').all(caseId) as {
      category: string;
      voided_at: string | null;
    }[],
  };
}

function build(db: Db, caseId: number, claimKinds: string[]) {
  return buildElementSheet(factsOf(db, caseId), LABOR.elementCards ?? [], claimKinds);
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

describe('S16 只传了员工手册：一份「公司文件」不算公司作出过解除决定', () => {
  /**
   * 【它对应 S6 台账里的哪几条裁决】「公司确实作出过那个解除/终止决定」认哪些槽，是分三轮
   * 收窄的（labor.ts 的 COUNTERPARTY_DECISION_SLOTS）：第二轮收 N-2a、第三轮收
   * counterpartyDecisionSlot 与 2N-3、第四轮收 2N-2 并把四处提成一个常量。
   * 加上 backlog ①（N-2b 的那条「我方动作」要过取值判定），这四张卡此刻判的是同一件事。
   *
   * 【为什么这个形态此前在跑批面一个样本都没有】S05 手上一张纸都没有（连「公司文件」都没有），
   * S07 走的是欠薪线。也就是说，把这几张卡改回单槽，整个剧本集照旧全绿——
   * 最贵的那次收窄没有任何一处跑批判据在守它。
   */
  const { fixture, sheet } = sheetFor('S16', ['N', '2N']);

  // 【预置期望】风闻裁员、只传了一份员工手册、时间线上一条公司动作都没有、首诊四项没填。
  const EXPECTED = {
    'N-1': { status: '缺失', burden: 'claimant' },
    'N-2a': { status: '缺失', burden: 'reversed_interpretation' },
    'N-2b': { status: '缺失', burden: 'claimant' },
    'N-3': { status: '缺失', burden: 'reversed_procedure_rules' },
    'N-4': { status: '成立·待证', burden: 'claimant' },
    '2N-1': { status: '缺失', burden: 'claimant' },
    '2N-2': { status: '缺失', burden: 'claimant' },
    '2N-3': { status: '缺失', burden: 'reversed_interpretation' },
    '2N-4': { status: '成立·待证', burden: 'claimant' },
    '2N-5': { status: '缺失', burden: 'reversed_procedure_rules' },
  };
  /** 判的是同一件事的那四张卡：一份员工手册**一张都抬不动**。 */
  const DECISION_ROWS = ['N-2a', 'N-2b', '2N-2', '2N-3'] as const;

  it('要件表逐行与预置期望一致（变异：把 N-2a 的 satisfiedBy 改回只认「公司文件」 → 红）', () => {
    expect(shape(sheet.rows)).toEqual(EXPECTED);
  });

  it('🔴 那四张判同一件事的卡全是「缺失」，且缺口点名的是那条记录、不是那份文件', () => {
    for (const id of DECISION_ROWS) {
      const row = sheet.rows.find((r) => r.id === id)!;
      expect(row.status, `${id} 被一份员工手册抬成了 ${row.status}`).toBe('缺失');
      expect(row.unresolvedSlots, `${id} 有认不出来的槽位（配置错了）`).toEqual([]);
    }
    // 「公司文件」这个槽已经被员工手册填上了，所以三张公司决定卡缺的只剩那条时间线记录；
    // 它同样按 missingAs 点名（2026-09-10「公司动作」票：那个槽也过取值判定了）——
    // 沿用槽串的形态是用户读到「还差 timeline:公司动作」，而他刚记过一条公司动作（约谈、调岗）。
    // N-2b 缺的是它自己那两格（沟通记录 + 那份被迫解除通知，后者同样按 missingAs 点名）。
    const missingOf = (id: string) => sheet.rows.find((r) => r.id === id)!.missingSlots;
    const COMPANY_DECISION_MISSING = '公司的解除/终止决定（请把公司作出这个决定的那一刻记成一条时间线事件）';
    expect(missingOf('N-2a')).toEqual([COMPANY_DECISION_MISSING]);
    expect(missingOf('2N-2')).toEqual([COMPANY_DECISION_MISSING]);
    expect(missingOf('2N-3')).toEqual([COMPANY_DECISION_MISSING]);
    expect(missingOf('N-2b'), 'N-2b 的缺口没点名那份被迫解除通知').toEqual([
      'evidence:沟通记录',
      '被迫解除通知（请把发出通知这件事记成一条时间线事件）',
    ]);
  });

  it('🔴 规则三不许触发：这四行的 reasons 里没有 burden_on_other_side', () => {
    // 【它守什么】规则三给的出路是「把公司那份书面决定与上面写的理由原样固定下来」。
    // 档案里根本没有那份决定时报这一条，用户照着做只能空转（issue-table.ts 的
    // counterpartyDecisionOnFile 抬头）。而"举证责任在对方"本身是常态，不是触发条件。
    const onFile = counterpartyDecisionOnFile(LABOR.counterpartyDecision, factsOf(fixture.db, fixture.caseId));
    expect(onFile, '一份员工手册就让"对方那份书面决定在档"成立了').toBe(false);
    const table = buildIssueTable(sheet.rows, { counterpartyDecisionOnFile: onFile }, sheet.rendered);
    for (const id of DECISION_ROWS) {
      const row = table.rows.find((r) => r.id === id)!;
      expect(row, `${id} 不在争点表上——「缺失」的要件恰恰最该摆出来`).toBeTruthy();
      expect(row.reasons, `${id} 报了规则三，而档案里没有那份书面决定`).toEqual(['element_unsettled']);
      expect(row.nextStep.trim(), `${id} 没有下一步`).not.toBe('');
    }
  });

  it('🔴 风险档位是「依据不足」（变异：让任一条解除路径靠员工手册成立 → 档位抬到「需补证后可主张」，红）', () => {
    // 走的是产品自己那条路（claim_calc → riskBandOf），不在判据里另写一份档位推导：
    // 另写一份的形态是两把尺分叉，而分叉的表现是这条判据变绿。
    // 【这三个数是本条判据的入参，不是剧本档案】它们只决定上限那个金额，不影响档位。
    const res = runClaimCalc(
      { kind: 'N', avg_monthly_wage_fen: 2_000_000, employed_from: '2021-05-01', terminated_at: '2026-09-30' },
      { db: fixture.db, caseId: fixture.caseId, calculatorKinds: LABOR.calculatorKinds },
    );
    expect(res.ok, '算钱没跑成功，这条判据什么都没验到').toBe(true);
    const band = (res as { payload: Record<string, unknown> }).payload.risk_band as Record<string, unknown>;
    expect(band, '本领域有要件卡，risk_band 不该是 null').toBeTruthy();
    expect(band.band).toBe('依据不足');
    expect(
      (band.gaps as { element_id: string }[]).map((g) => g.element_id),
      '两条解除路径都没走通，两条都该留在缺口里',
    ).toEqual(expect.arrayContaining(['N-2a', 'N-2b']));
  });

  it('第二幕：补一份《解除劳动合同通知书》+ 一条书证档「公司动作」⇒ N-2a 与 2N-3 成立、规则三触发', () => {
    // 【为什么要有第二幕】只钉第一幕的话，把这几张卡的 satisfiedBy 写成恒不成立也是绿的——
    // 那样每个人的解除路径都永远「缺失」，而"缺失"读起来和"还没传材料"一模一样。
    const fileId = Number(
      fixture.db
        .prepare("INSERT INTO files (sha256, size, mime, enc_path) VALUES ('sha-s16-notice', 1, 'application/pdf', '/dev/null')")
        .run().lastInsertRowid,
    );
    fixture.db
      .prepare(
        `INSERT INTO evidence (case_id, user_id, file_id, name, category, status)
         VALUES (?, ?, ?, '解除劳动合同通知书.pdf', '公司文件', '已上传')`,
      )
      .run(fixture.caseId, fixture.userId, fileId);
    // 书证档 = 由文件提取写回时间线的那条路（source-tier.ts 的 DOC_EXTRACT_ORIGIN）。
    fixture.db
      .prepare(
        `INSERT INTO timeline_events (case_id, happened_at, kind, title, source_tier, asserted_by)
         VALUES (?, datetime('2026-09-08 02:00:00'), '公司动作', '公司送达《解除劳动合同通知书》', '书证', 'doc_extract')`,
      )
      .run(fixture.caseId);

    const after = build(fixture.db, fixture.caseId, ['N', '2N']);
    expect(after.rows.find((r) => r.id === 'N-2a')!.status).toBe('成立');
    expect(after.rows.find((r) => r.id === '2N-3')!.status).toBe('成立');
    expect(after.rows.find((r) => r.id === '2N-2')!.status).toBe('成立');
    // 路径二没走（他发的不是被迫解除通知）⇒ 照旧「缺失」，但它不再是本组代表行
    expect(after.rows.find((r) => r.id === 'N-2b')!.status).toBe('缺失');

    const onFile = counterpartyDecisionOnFile(
      LABOR.counterpartyDecision,
      factsOf(fixture.db, fixture.caseId),
    );
    expect(onFile, '那份书面决定已在档，规则三的第二个条件该成立了').toBe(true);
    const table = buildIssueTable(after.rows, { counterpartyDecisionOnFile: onFile }, after.rendered);
    for (const id of ['N-2a', '2N-3']) {
      const row = table.rows.find((r) => r.id === id)!;
      expect(row, `${id} 成立之后没被规则三捞进争点表`).toBeTruthy();
      expect(row.reasons, `${id} 没报规则三`).toContain('burden_on_other_side');
    }
    // 走通了路径一 ⇒ 路径二的「缺失」不再进争点表（用户不该去补一份他没发过的通知）
    expect(
      table.rows.map((r) => r.id),
      '路径一已经走通，路径二的「缺失」还挂在争点表上',
    ).not.toContain('N-2b');
  });
});

describe('地板：三份夹具指向的是真剧本、真要件卡', () => {
  it('S05 / S07 / S16 都在 SCENARIOS 里，且要件卡覆盖到这几项诉求', () => {
    for (const id of ['S05', 'S07', 'S16']) {
      expect(SCENARIOS.map((s) => s.id), `${id} 不在剧本集里`).toContain(id);
    }
    for (const kind of ['2N', 'N', '欠薪']) {
      expect(
        (LABOR.elementCards ?? []).filter((c) => c.claimKind === kind).length,
        `${kind} 一个要件都没有`,
      ).toBeGreaterThan(0);
    }
  });
});
