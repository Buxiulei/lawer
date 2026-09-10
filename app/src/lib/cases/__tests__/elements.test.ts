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
  representativeElementIds,
  resolveSlot,
  type ElementCard,
  type ElementFactsView,
} from '../elements';

/** 时间线一行；`title` / `detail` 只有挂了取值判定的用例才写，其余省略。 */
type TimelineRow = ElementFactsView['timeline'][number];

/**
 * 一份空档案。每条用例只往里塞它要的那几行，别的一律〔未记录〕。
 *
 * 【时间线那两格为什么在这里补缺省】`title` / `detail` 只给 slotChecks 的取值判定用
 *（见 elements.ts 的 ElementFactsView），而本文件绝大多数用例测的是三态推导、一条判定都不挂。
 * 让它们逐个把这两格写出来，只会把每条用例真正在说的那件事淹掉。
 */
function facts(
  over: Partial<Omit<ElementFactsView, 'timeline'>> & {
    timeline?: readonly (Pick<TimelineRow, 'kind' | 'source_tier'> & Partial<TimelineRow>)[];
  } = {},
): ElementFactsView {
  return {
    case: { employed_from: null, position: null, monthly_wage_fen: null, contract_count: null },
    claims: [],
    companies: [],
    evidence: [],
    ...over,
    timeline: (over.timeline ?? []).map((e) => ({ title: '', detail: null, ...e })),
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

describe('槽位取值判定：时间线那一类槽（一个类别下可以有好几条记录）', () => {
  // 【它守什么】`timeline:` 在 resolveSlot 里只判**这个类别下有没有记录**。于是一条
  // 与本要件无关的同类事件（记的是另一件事）照样把这个要件抬起来。领域包给了判定之后，
  // 只有**那条记录自带的那段字**说得上本要件时才算数。共享层不认识任何一个行当的词，
  // 判定函数由领域包给——本文件的判定全部现造。
  const checked = (accepts: (raw: string) => boolean = (raw) => raw.includes('那件事')) =>
    card({
      satisfiedBy: ['timeline:某类动作'],
      slotChecks: { 'timeline:某类动作': { accepts, missingAs: '那件事的记录' } },
    });

  it('同类别下任意一条过了判定就算有支撑（变异：改成"每条都要过" → 红）', () => {
    const sheet = buildElementSheet(
      facts({
        timeline: [
          { kind: '某类动作', source_tier: '自述', title: '别的事' },
          { kind: '某类动作', source_tier: '自述', title: '那件事' },
        ],
      }),
      [checked()],
    );
    expect(only(sheet).status).toBe('成立·待证');
    expect(only(sheet).missingSlots).toEqual([]);
  });

  it('🔴 档位只从**过了判定的那几条**里取（变异：从全部条目里取最强 → 红）', () => {
    // 【这条最贵】过了判定的那条只有当事人自己说，旁边那条带着书证的记的是另一件事。
    // 从全部条目里取档位的形态是：这个槽显示成书证档 ⇒ 整条要件写着「成立」，
    // 而那份书证证的根本不是这件事。
    const sheet = buildElementSheet(
      facts({
        timeline: [
          { kind: '某类动作', source_tier: '书证', title: '别的事' },
          { kind: '某类动作', source_tier: '自述', title: '那件事' },
        ],
      }),
      [checked()],
    );
    expect(only(sheet).status).toBe('成立·待证');
    expect(only(sheet).selfReportedSlots).toEqual(['timeline:某类动作']);
  });

  it('过了判定的那条是书证档 ⇒「成立」（自证上面不是恒「待证」）', () => {
    const sheet = buildElementSheet(
      facts({ timeline: [{ kind: '某类动作', source_tier: '书证', title: '那件事' }] }),
      [checked()],
    );
    expect(only(sheet).status).toBe('成立');
  });

  it('一条都没过（或这个类别下一条记录都没有）⇒「缺失」，用卡片给的名字点名', () => {
    const none = buildElementSheet(
      facts({ timeline: [{ kind: '某类动作', source_tier: '书证', title: '别的事' }] }),
      [checked()],
    );
    expect(only(none).status).toBe('缺失');
    expect(only(none).missingSlots).toEqual(['那件事的记录']);
    // 这个类别下一条记录都没有时是同一句话——用户读到的都是该补什么，不是一串槽串
    const empty = buildElementSheet(facts(), [checked()]);
    expect(only(empty).missingSlots).toEqual(['那件事的记录']);
  });

  it('title 与 detail 之间是换行，不是直接相接（变异：接在一起 → 红）', () => {
    // 【为什么钉它】接在一起的形态是：上一段的末尾与下一段的开头凑出一个谁都没写过的词，
    // 而判定按那个词判过了。领域包要不要把两段当一句连续的话读，是它自己的事。
    const seen: string[] = [];
    const sheet = buildElementSheet(
      facts({ timeline: [{ kind: '某类动作', source_tier: '自述', title: '前段', detail: '后段' }] }),
      [
        checked((raw) => {
          seen.push(raw);
          return false;
        }),
      ],
    );
    expect(seen).toEqual(['前段\n后段']);
    expect(only(sheet).status).toBe('缺失');
  });

  it('档位认不出来的行跳过，不当作"有支撑"（与 weakestTier / strongestTier 同一条纪律）', () => {
    const sheet = buildElementSheet(
      facts({ timeline: [{ kind: '某类动作', source_tier: '道听途说', title: '那件事' }] }),
      [checked()],
    );
    expect(only(sheet).status).toBe('缺失');
    expect(only(sheet).missingSlots).toEqual(['那件事的记录']);
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


describe('「任选其一」分组：走通一条就算走通', () => {
  // 【它守什么】有些要件是互斥的几条路径（同一项诉求，走通任一条即可）。
  // 没有这一格的形态是：要件表按诉求列全，另一条路那张卡恒是「缺失」，
  // 于是风险区间见「缺失」就落到最低那一档，争点表还多出一条让用户去补的材料——
  // 一个材料齐全的案子被告知"依据不足"，并被指去准备一份根本不存在的文件。
  const two = (a: Partial<ElementCard>, b: Partial<ElementCard>) => [
    card({ id: 'p1', alternativeGroup: 'g', satisfiedBy: ['claim:甲'], ...a }),
    card({ id: 'p2', alternativeGroup: 'g', satisfiedBy: ['claim:乙'], ...b }),
  ];

  it('组内有一条「成立」⇒ 只有它是代表行（变异：把分组当作不存在 → 红）', () => {
    const sheet = buildElementSheet(facts({ claims: [{ kind: '甲', source_tier: '书证' }] }), two({}, {}));
    expect(sheet.rows.map((r) => r.status)).toEqual(['成立', '缺失']);
    // 两行都还在表上：另一条路是什么、用户走没走它，得让他自己看得到
    expect(sheet.rows.length).toBe(2);
    expect([...representativeElementIds(sheet.rows)]).toEqual(['p1']);
  });

  it('组内最好的是「成立·待证」⇒ 代表行是它，同组的「缺失」不参与', () => {
    const sheet = buildElementSheet(facts({ claims: [{ kind: '甲', source_tier: '自述' }] }), two({}, {}));
    expect(sheet.rows.map((r) => r.status)).toEqual(['成立·待证', '缺失']);
    expect([...representativeElementIds(sheet.rows)]).toEqual(['p1']);
  });

  it('两条都还没走通 ⇒ 两条都是代表行（这道分组不是"藏起一条"）', () => {
    const sheet = buildElementSheet(facts(), two({}, {}));
    expect([...representativeElementIds(sheet.rows)]).toEqual(['p1', 'p2']);
  });

  it('「缺失」与「不成立」并列在最低那一档：两条都留着（变异：给不成立排一个高低 → 红）', () => {
    // 一条被反证推翻、另一条只是〔未记录〕，对"这条路走没走通"给的是同一个答案。
    // 排出高低的形态是：其中一条从争点表上消失——要么用户读不到那条缺失行的出路，
    // 要么档案里那份指向相反结论的材料不再被提起。
    const sheet = buildElementSheet(
      facts({ claims: [{ kind: '丙', source_tier: '书证' }] }),
      two({ negatedBy: ['claim:丙'] }, {}),
    );
    expect(sheet.rows.map((r) => r.status)).toEqual(['不成立', '缺失']);
    expect([...representativeElementIds(sheet.rows)]).toEqual(['p1', 'p2']);
  });

  it('没有分组的行恒是代表行（不用这一格的领域一个字都不该变）', () => {
    const sheet = buildElementSheet(facts(), [card({ id: 'a' }), card({ id: 'b', satisfiedBy: ['claim:乙'] })]);
    expect([...representativeElementIds(sheet.rows)]).toEqual(['a', 'b']);
  });
});
