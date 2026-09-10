// app/src/lib/cases/__tests__/elements.test.ts
// 要件三态与举证责任的判据（设计稿 §2 A3）。
//
// 【三态推导表：每格一条】四个状态 × 各自的成因各一条用例，合成一条大断言的形态是——
// 其中一格判反时整条仍然红（别的格还在报），于是没人发现坏的是哪一格。
//
// 【本票不含任何要件卡内容】卡片全部现造（S6 才写劳动要件卡），
// 这里测的是推导规则本身：同一份档案 + 同一批卡片恒得同一张表。
import { describe, expect, it } from 'vitest';

import {
  basisVerified,
  buildElementSheet,
  BURDENS,
  ELEMENT_STATUSES,
  resolveSlot,
  type ElementCard,
  type ElementFactsView,
} from '../elements';

/** 一份空档案。每条用例只往里塞它要的那几行，别的一律〔未记录〕。 */
function facts(over: Partial<ElementFactsView> = {}): ElementFactsView {
  return {
    case: { employed_from: null, position: null, monthly_wage_fen: null, contract_count: null },
    claims: [],
    timeline: [],
    companies: [],
    evidence: [],
    ...over,
  };
}

/** 一张最小要件卡。basis 默认**已核实**，好让 burden 那一格测得到卡片自报的值。 */
function card(over: Partial<ElementCard> = {}): ElementCard {
  return {
    id: 'e1',
    // S6 给要件卡加了「属于哪一项诉求」与「通常拿什么去证」两格：前者让要件表按诉求分组
    // （不过滤的形态见 buildElementSheet 注释），后者是「缺失」那一行的出路。
    // 本文件的用例只测三态与 burden 推导，所以两格都给一个中性缺省值。
    claimKind: '某诉求',
    name: '要件一',
    burden: 'claimant',
    basis: [{ anchor: 'law-x|art-1', verified: true }],
    satisfiedBy: ['claim:某项'],
    typicalEvidence: ['某种材料'],
    ...over,
  };
}

const only = (sheet: ReturnType<typeof buildElementSheet>) => sheet.rows[0];

describe('三态推导表：每格一条', () => {
  it('①〔成立〕satisfiedBy 全部在档且最弱一环 ≥ 书证（变异：把门槛改成 ≥ 自述 → 「成立·待证」那格失守）', () => {
    const sheet = buildElementSheet(
      facts({ claims: [{ kind: '某项', source_tier: '书证' }] }),
      [card()],
    );
    expect(only(sheet).status).toBe('成立');
    expect(only(sheet).missingSlots).toEqual([]);
    expect(only(sheet).selfReportedSlots).toEqual([]);
  });

  it('②〔成立·待证〕事实在档、但只有当事人的说法（变异：把纯自述判成「成立」 → 红）', () => {
    const sheet = buildElementSheet(
      facts({ claims: [{ kind: '某项', source_tier: '自述' }] }),
      [card()],
    );
    expect(only(sheet).status).toBe('成立·待证');
    // 「补哪张证」的清单就是它：不点名到槽，用户只知道"待证"、不知道待证的是哪一件
    expect(only(sheet).selfReportedSlots).toEqual(['claim:某项']);
  });

  it('②b 多个槽里只要有一个是自述，整条就降到「成立·待证」（变异：按最强档算 → 红）', () => {
    const sheet = buildElementSheet(
      facts({
        claims: [{ kind: '某项', source_tier: '书证' }],
        companies: [{ role: '某角色', source_tier: '自述' }],
      }),
      [card({ satisfiedBy: ['claim:某项', 'company:某角色'] })],
    );
    expect(only(sheet).status).toBe('成立·待证');
    expect(only(sheet).selfReportedSlots).toEqual(['company:某角色']);
  });

  it('③〔缺失〕槽里没有事实——**不是「不成立」**（变异：把缺失判成不成立 → 红，这是本设计的红线）', () => {
    // 设计稿 §1.2「未记录误判 = 0」：〔未记录〕被写成「没有/不适用/时效没问题」是零容忍项。
    const sheet = buildElementSheet(facts(), [card()]);
    expect(only(sheet).status).toBe('缺失');
    expect(only(sheet).status).not.toBe('不成立');
    expect(only(sheet).missingSlots).toEqual(['claim:某项']);
  });

  it('④〔不成立〕negatedBy 拿得出书证及以上的反证（变异：让自述档的反证也推翻 → 红）', () => {
    const withDoc = buildElementSheet(
      facts({
        claims: [{ kind: '某项', source_tier: '书证' }],
        timeline: [{ kind: '某反证', source_tier: '书证' }],
      }),
      [card({ negatedBy: ['timeline:某反证'] })],
    );
    expect(only(withDoc).status).toBe('不成立');

    // 只有对方口头说过（自述档）的反证推翻不了任何东西
    const selfReported = buildElementSheet(
      facts({
        claims: [{ kind: '某项', source_tier: '书证' }],
        timeline: [{ kind: '某反证', source_tier: '自述' }],
      }),
      [card({ negatedBy: ['timeline:某反证'] })],
    );
    expect(only(selfReported).status).toBe('成立');
  });

  it('④b 反证优先于正面推导：正面还缺着也照样是「不成立」（变异：把 negated 判在 missing 之后 → 红）', () => {
    const sheet = buildElementSheet(
      facts({ timeline: [{ kind: '某反证', source_tier: '裁审认定' }] }),
      [card({ negatedBy: ['timeline:某反证'] })],
    );
    expect(only(sheet).status).toBe('不成立');
  });

  it('四个状态一个不多一个不少（变异：往枚举加一档而推导里用不到 → 红）', () => {
    expect([...ELEMENT_STATUSES]).toEqual(['成立', '成立·待证', '缺失', '不成立']);
  });
});

describe('举证责任：条号没核实就一律「待核实」', () => {
  it('basis 全核实过 ⇒ 用卡片自报的那一方（变异：无条件压成 unverified → 红）', () => {
    const sheet = buildElementSheet(
      facts({ claims: [{ kind: '某项', source_tier: '书证' }] }),
      [card({ burden: 'respondent' })],
    );
    expect(only(sheet).burden).toBe('respondent');
    expect(only(sheet).burdenForced).toBe(false);
  });

  it.each([
    ['basis 为空数组', [] as ElementCard['basis']],
    ['锚点存在但没核实', [{ anchor: 'law-x@art-1@2026', verified: false }]],
    ['锚点是空串', [{ anchor: '   ', verified: true }]],
    ['两条里有一条没核实', [
      { anchor: 'a@1@2026', verified: true },
      { anchor: 'b@2@2026', verified: false },
    ]],
  ])(
    '%s ⇒ 强制压成 unverified，卡片自报什么都不算（变异：删掉这一句强制 → 红）',
    (_label, basis) => {
      // 举证责任讲反是本产品最贵的一类错：用户据此决定"这件事我不用证"，
      // 而开庭那天没人替他证。条号没核实过就填一个方向的形态是——那个方向读起来和核实过的一模一样。
      const sheet = buildElementSheet(
        facts({ claims: [{ kind: '某项', source_tier: '书证' }] }),
        [card({ burden: 'reversed_interpretation', basis })],
      );
      expect(only(sheet).burden).toBe('unverified');
      expect(only(sheet).burdenForced).toBe(true);
      // 状态**不受影响**：条号没核实不代表事实不成立，两件事分开
      expect(only(sheet).status).toBe('成立');
    },
  );

  it('卡片本来就填 unverified 时不算"被压过"（变异：把 burdenForced 写成恒 true → 红）', () => {
    const sheet = buildElementSheet(
      facts({ claims: [{ kind: '某项', source_tier: '书证' }] }),
      [card({ burden: 'unverified', basis: [] })],
    );
    expect(only(sheet).burdenForced).toBe(false);
  });

  it('举证责任是中立编码，五档（变异：往枚举里写一个行当名词 → 领域中立性失守）', () => {
    expect([...BURDENS]).toEqual([
      'claimant',
      'respondent',
      'reversed_interpretation',
      'reversed_procedure_rules',
      'unverified',
    ]);
    for (const b of BURDENS) expect(b).toMatch(/^[a-z_]+$/);
  });

  it('basisVerified 单测（变异：把空数组判成已核实 → 红）', () => {
    expect(basisVerified([])).toBe(false);
    expect(basisVerified([{ anchor: 'a@1@2026', verified: true }])).toBe(true);
  });
});

describe('事实槽的寻址', () => {
  const full = facts({
    claims: [{ kind: '欠款', source_tier: '对方认可' }],
    timeline: [
      { kind: '对方动作', source_tier: '自述' },
      { kind: '对方动作', source_tier: '书证' },
    ],
    companies: [{ role: '某角色', source_tier: '自述' }],
    evidence: [
      { category: '合同', voided_at: null },
      { category: '录音', voided_at: '2026-09-01 00:00:00' },
    ],
    case: { employed_from: '2020-01-01', position: '  ', monthly_wage_fen: 0, contract_count: null },
  });

  it('claim / company 按最弱算，timeline 按最强算（变异：两处方向对调 → 红）', () => {
    expect(resolveSlot('claim:欠款', full)).toBe('对方认可');
    expect(resolveSlot('company:某角色', full)).toBe('自述');
    // 同一件事记了两遍（一遍自述、一遍由提取写入）：按最弱算等于把已有的书证当没有
    expect(resolveSlot('timeline:对方动作', full)).toBe('书证');
  });

  it('证据在档即书证；已作废的不算数（变异：不过滤 voided_at → 红）', () => {
    expect(resolveSlot('evidence:合同', full)).toBe('书证');
    expect(resolveSlot('evidence:录音', full)).toBe(null);
  });

  it('basics 填了是自述、没填是〔未记录〕；空串与 0 都算没填（变异：只判 != null → 红）', () => {
    expect(resolveSlot('basics:employed_from', full)).toBe('自述');
    expect(resolveSlot('basics:position', full)).toBe(null); // 空白串
    expect(resolveSlot('basics:monthly_wage_fen', full)).toBe(null); // 0 不算填了
    expect(resolveSlot('basics:contract_count', full)).toBe(null);
  });

  it('认不出的寻址串回 undefined，与「没有这条事实」分开报（变异：合成同一个 null → 红）', () => {
    for (const bad of ['claim', ':x', 'ghost:x', 'basics:not_a_column', 'claim:']) {
      expect(resolveSlot(bad, full), bad).toBeUndefined();
    }
  });

  it('不认识的槽会把状态压成缺失，并在 unresolvedSlots 里点名（变异：静默当缺失 → 红）', () => {
    const sheet = buildElementSheet(full, [card({ satisfiedBy: ['ghost:x'] })]);
    expect(only(sheet).status).toBe('缺失');
    expect(only(sheet).unresolvedSlots).toEqual(['ghost:x']);
    expect(only(sheet).missingSlots).toEqual(['ghost:x']);
  });
});

describe('槽位取值判定：字段有值 ≠ 事实成立', () => {
  // 【它守什么】复审 2026-09-10 第二条：`basics:` 在 resolveSlot 里只判**填没填**，
  // 于是任何非空取值都算这个要件有自述支撑。领域包给了 slotChecks 的槽，取值说了不算数时
  // 要按〔未记录〕走，并以卡片给的名字点名——否则用户明说"签过两次合同"，
  // 要件表还写着「仍没有订立书面合同：成立·待证」。
  const checked = (over: Partial<ElementCard> = {}) =>
    card({
      satisfiedBy: ['basics:contract_count'],
      slotChecks: { 'basics:contract_count': { accepts: (raw) => raw.includes('没'), missingAs: '无合同期间' } },
      ...over,
    });

  it('取值判得过 ⇒ 照旧「成立·待证」（首诊那几项恒是自述档）', () => {
    const sheet = buildElementSheet(facts({ case: { employed_from: null, position: null, monthly_wage_fen: null, contract_count: '没签' } }), [checked()]);
    expect(only(sheet).status).toBe('成立·待证');
    expect(only(sheet).missingSlots).toEqual([]);
    expect(only(sheet).selfReportedSlots).toEqual(['basics:contract_count']);
  });

  it('取值判不过 ⇒「缺失」，且 missingSlots 点的是卡片给的那个名字（变异：只判填没填 → 红）', () => {
    const sheet = buildElementSheet(facts({ case: { employed_from: null, position: null, monthly_wage_fen: null, contract_count: '2 次' } }), [checked()]);
    expect(only(sheet).status).toBe('缺失');
    expect(only(sheet).missingSlots).toEqual(['无合同期间']);
    // 它是〔未记录〕不是〔不成立〕：这一格填了字，只是填的不是这件事
    expect(only(sheet).selfReportedSlots).toEqual([]);
  });

  it('这一格还空着 ⇒ 同样用卡片给的名字点名（沿用槽串的形态是用户读到 basics:contract_count）', () => {
    const sheet = buildElementSheet(facts(), [checked()]);
    expect(only(sheet).status).toBe('缺失');
    expect(only(sheet).missingSlots).toEqual(['无合同期间']);
  });

  it('判定挂在一个没有"取值"的槽上 = 配置错误，点名不静默（变异：当作判过了 → 红）', () => {
    const sheet = buildElementSheet(
      facts({ claims: [{ kind: '某项', source_tier: '书证' }] }),
      [card({ satisfiedBy: ['claim:某项'], slotChecks: { 'claim:某项': { accepts: () => true, missingAs: '某物' } } })],
    );
    expect(only(sheet).status).toBe('缺失');
    expect(only(sheet).unresolvedSlots).toEqual(['claim:某项']);
    expect(only(sheet).missingSlots).toEqual(['claim:某项']);
  });

  it('没给 slotChecks 的槽一个字都不变（变异：对所有 basics 槽都跑判定 → 红）', () => {
    const sheet = buildElementSheet(
      facts({ case: { employed_from: null, position: null, monthly_wage_fen: null, contract_count: '2 次' } }),
      [card({ satisfiedBy: ['basics:contract_count'] })],
    );
    expect(only(sheet).status).toBe('成立·待证');
  });
});

describe('空要件卡的降级', () => {
  it('没有卡片 ⇒ rendered=false 且零行（变异：回 rendered:true → 用户读到"要件：（空）"，像"一个要件都不成立"）', () => {
    const sheet = buildElementSheet(facts(), []);
    expect(sheet.rendered).toBe(false);
    expect(sheet.rows).toEqual([]);
  });

  it('有卡片就渲染，行数与卡数一一对应（变异：过滤掉「缺失」的行 → 红：缺失恰恰是最该显示的）', () => {
    const sheet = buildElementSheet(facts(), [card({ id: 'a' }), card({ id: 'b' })]);
    expect(sheet.rendered).toBe(true);
    expect(sheet.rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('纯函数：同样的入参跑两次结果逐字相同（变异：往里塞一个 Date.now / 随机数 → 红）', () => {
    const f = facts({ claims: [{ kind: '某项', source_tier: '自述' }] });
    const cards = [card()];
    expect(buildElementSheet(f, cards)).toEqual(buildElementSheet(f, cards));
  });
});
