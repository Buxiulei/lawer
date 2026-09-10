// app/src/lib/cases/__tests__/issue-table.test.ts
// 争点表派生的判据（S6 判据三）。三条规则各一条正样本 + 一条反样本，外加两条红线：
//   · **争点 → 行动卡/追问 链接率 100%**：每一行的 nextStep 都非空（禁令配出路）；
//   · **〔未记录〕≠ 不成立**：缺失行的措辞里不许出现"不成立/不满足/你没有"。
//
// 【变异矩阵】把 buildIssueTable 里任一条规则的判断删掉或反向，都会有一条在这里红：
//   · 删「status !== 成立」⇒「缺失的要件进表」红；
//   · 把「有对方主张才算」改成恒真 ⇒「成立且无人主张的要件不进表」红；
//   · 删 counterpartyDecisionOnFile 这个条件 ⇒「对方书面决定不在档时不进表」红；
//   · 让 nextStep 在某条分支上返回空串 ⇒ 链接率那条红。
import { describe, expect, it } from 'vitest';

import type { ElementFactsView, ElementRow } from '../elements';
import {
  buildIssueTable,
  counterpartyDecisionOnFile,
  issueMarker,
  issueMarkersIn,
} from '../issue-table';

/** 一行要件表。默认是"已经成立、我方举证、什么都不缺"——最不该进争点表的那一行。 */
function row(over: Partial<ElementRow> = {}): ElementRow {
  return {
    id: 'e1',
    claimKind: '某诉求',
    name: '要件一',
    status: '成立',
    burden: 'claimant',
    burdenForced: false,
    missingSlots: [],
    selfReportedSlots: [],
    unresolvedSlots: [],
    typicalEvidence: ['某种材料'],
    basis: [{ anchor: '某法|第一条', verified: true }],
    ...over,
  };
}

describe('三条规则各自成立', () => {
  it('规则一：状态不是「成立」的要件进表（变异：删掉这条判断 → 红）', () => {
    for (const status of ['成立·待证', '缺失', '不成立'] as const) {
      const table = buildIssueTable([row({ status })]);
      expect(table.rows.map((r) => r.id), status).toEqual(['e1']);
      expect(table.rows[0].reasons, status).toContain('element_unsettled');
    }
  });

  it('规则二：对方就这个要件主张过什么，即使要件已成立也进表', () => {
    const table = buildIssueTable([row()], { counterpartyAssertions: { e1: '公司说这是协商一致' } });
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].reasons).toEqual(['counterparty_asserted']);
    // 对方的原话要出现在争点里：只写要件名的形态是——用户读到"争点：要件一"，
    // 而真正要打的是对方那句话。
    expect(table.rows[0].issue).toContain('公司说这是协商一致');
  });

  it('规则二反样本：主张槽位是空串时不进表（空字符串与"没主张过"是同一件事）', () => {
    expect(buildIssueTable([row()], { counterpartyAssertions: { e1: '   ' } }).rows).toEqual([]);
  });

  it('规则三：举证责任**整条**在对方 + 对方的书面决定已在档 ⇒ 进表', () => {
    for (const burden of ['respondent', 'reversed_interpretation'] as const) {
      const table = buildIssueTable([row({ burden })], { counterpartyDecisionOnFile: true });
      expect(table.rows.map((r) => r.reasons), burden).toEqual([['burden_on_other_side']]);
    }
  });

  it('规则三反样本三：证据偏在型不进表（复审 2026-09-10 第三条 b；把它加回 DECISION_BURDENS → 红）', () => {
    // 【为什么偏在型不算】规则三给的下一步是「把他那份书面决定与上面写的理由原样固定下来」。
    // 偏在讲的是另一件事：一般规则仍是谁主张谁举证，只是那份**记录**在对方手里。
    // 一起捞进来的形态是：档案里随便有一份对方的书面决定，「计算基数」也被挂上争点表
    // 并指示用户去固定那份决定——而那张纸上一个字都不会写工资基数。
    const table = buildIssueTable([row({ burden: 'reversed_procedure_rules' })], {
      counterpartyDecisionOnFile: true,
    });
    expect(table.rows).toEqual([]);
  });

  it('规则三反样本一：举证责任在对方、但书面决定不在档 ⇒ 不进表（否则这几行永远挂着，争点表读不完）', () => {
    const table = buildIssueTable([row({ burden: 'reversed_interpretation' })], {
      counterpartyDecisionOnFile: false,
    });
    expect(table.rows).toEqual([]);
  });

  it('规则三反样本二：书面决定在档、但举证责任在我方 ⇒ 不进表', () => {
    const table = buildIssueTable([row({ burden: 'claimant' })], { counterpartyDecisionOnFile: true });
    expect(table.rows).toEqual([]);
  });

  it('三条都不命中的要件不进表（自证上面几条不是"什么都进表"）', () => {
    expect(buildIssueTable([row()]).rows).toEqual([]);
  });

  it('一行可以同时命中多条规则，reasons 逐条留痕（合并成一个 boolean 就说不清该干什么）', () => {
    const table = buildIssueTable([row({ status: '缺失', burden: 'reversed_interpretation', missingSlots: ['evidence:某类'] })], {
      counterpartyAssertions: { e1: '公司说材料早就给过你了' },
      counterpartyDecisionOnFile: true,
    });
    expect(table.rows[0].reasons).toEqual([
      'element_unsettled',
      'counterparty_asserted',
      'burden_on_other_side',
    ]);
  });
});

describe('红线：每条争点都有出路，且〔未记录〕不许写成不成立', () => {
  const all = buildIssueTable(
    [
      row({ id: 'a', status: '缺失', missingSlots: ['evidence:某类'] }),
      row({ id: 'b', status: '成立·待证', selfReportedSlots: ['basics:某项'] }),
      row({ id: 'c', status: '不成立' }),
      row({ id: 'd', burden: 'reversed_interpretation' }),
      row({ id: 'e' }),
    ],
    { counterpartyAssertions: { e: '对方的说法' }, counterpartyDecisionOnFile: true },
  );

  it('🔒 地板：确实派生出了一批行（空表会让下面两条永远绿）', () => {
    expect(all.rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('链接率 100%：每一条争点都带一句非空的下一步（变异：让某条分支返回空串 → 红）', () => {
    for (const r of all.rows) {
      expect(r.nextStep.trim(), `${r.id} 没有下一步`).not.toBe('');
      // 出路必须**具体**：只说"补证据"等于没说。这里要求它带上要件卡给的那句材料清单。
      expect(r.nextStep, `${r.id} 的下一步没给具体补什么`).toContain('某种材料');
    }
  });

  it('〔未记录〕≠ 不成立：缺失那一行的措辞里不许出现「不成立 / 不满足 / 你没有」', () => {
    const missing = all.rows.find((r) => r.id === 'a')!;
    for (const banned of ['不成立', '不满足', '你没有']) {
      expect(missing.nextStep, `缺失行说了「${banned}」`).not.toContain(banned);
    }
    // 反过来，它必须明说"档案里还没有这一项"这层意思——只说"补什么"仍然会被读成"你没有"
    expect(missing.nextStep).toContain('不是"没有这回事"');
  });

  it('锚点原样透传（争点要能点回到那一条原文）', () => {
    for (const r of all.rows) expect(r.anchors).toEqual(['某法|第一条']);
  });
});

describe('「对方的书面决定在不在档」的唯一入口', () => {
  // 【为什么它要有自己的判据】此前报告与要件族能力里各写了一遍同形的三行判断，
  // 而没有任何东西钉住它们：把其中一份换成常量 true，两侧的既有判据全绿（复审第三条）。
  // 现在两边都调这一个函数，这里把它的四种入参各钉一条。
  const withEvidence = (categories: string[]): ElementFactsView => ({
    case: { employed_from: null, position: null, monthly_wage_fen: null, contract_count: null },
    claims: [],
    timeline: [],
    companies: [],
    evidence: categories.map((category) => ({ category })),
  });

  it('槽位没声明 ⇒ 恒 false（规则三整条不生效，而不是恒成立）', () => {
    expect(counterpartyDecisionOnFile(undefined, withEvidence(['某类']))).toBe(false);
  });

  it('档案里有那一类材料 ⇒ true', () => {
    expect(counterpartyDecisionOnFile('evidence:某类', withEvidence(['某类']))).toBe(true);
  });

  it('有书证、但**不是**那一类 ⇒ false（变异：改成 evidence.length > 0 → 红）', () => {
    expect(counterpartyDecisionOnFile('evidence:某类', withEvidence(['别的类', '再一类']))).toBe(false);
  });

  it('档案里什么都没有 ⇒ false（变异：改成常量 true → 红）', () => {
    expect(counterpartyDecisionOnFile('evidence:某类', withEvidence([]))).toBe(false);
  });
});

describe('不渲染时整表不渲染（不是"没有争点"）', () => {
  it('要件表 rendered=false ⇒ 争点表 rendered=false 且零行', () => {
    const table = buildIssueTable([row({ status: '缺失' })], {}, false);
    expect(table).toEqual({ rows: [], rendered: false });
  });
});

describe('派生标记：措辞可改、条目不可增删的那把尺', () => {
  it('标记能写出来也认得回来', () => {
    const text = `- ${issueMarker('2N-3')}解除理由这一项在争\n- ${issueMarker('N-1')}关系起点`;
    expect(issueMarkersIn(text)).toEqual(new Set(['2N-3', 'N-1']));
  });

  it('把整句话改写成人话，标记还在 ⇒ 认得出是同一条（这正是它要允许的事）', () => {
    const before = `- ${issueMarker('2N-3')}解除不具备法定理由：缺失`;
    const after = `${issueMarker('2N-3')} 公司到底凭哪一条把你辞了，这一点现在是空的。`;
    expect(issueMarkersIn(after)).toEqual(issueMarkersIn(before));
  });

  it('没有标记的文本回空集合（旧报告、非派生节不受这把尺约束）', () => {
    expect(issueMarkersIn('- 一段普通正文，提到了争点两个字')).toEqual(new Set());
  });
});
