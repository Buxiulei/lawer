// scripts/eval/pending-cards.test.ts
// 补卡闭环的执行物。清单本身也需要被测试守住——否则"我们有清单"会变成又一条
// 没有执行物的经验（见 README 开篇纪律）。
import { describe, expect, it } from 'vitest';

import { classifyPending, collectPending, PENDING_ESCALATE_BATCHES, updateStreaks } from './pending-cards';
import { nearestLaw } from './assertions';
import type { Verdict } from './assertions';

const pendingVerdict = (article: string): Verdict => ({
  id: `X-待补卡-${article}`,
  pass: true,
  na: true,
  naKind: 'pending_card',
  pendingArticle: article,
  detail: `${article} 在知识库里没有逐字原文`,
});

describe('补卡需求清单：汇总与跨批追踪', () => {
  it('只收 pending_card 类，决策点类 N/A 不混进来', () => {
    const got = collectPending([
      { scenarioId: 'S02', verdict: pendingVerdict('第二十七条') },
      // 决策点类 N/A：处置完全不同，混进补卡清单会让真缺口沉底
      { scenarioId: 'S02', verdict: { id: 'S02-决定权交还', pass: true, na: true, naKind: 'no_decision_point', detail: '' } },
      { scenarioId: 'S03', verdict: { id: 'S03-x', pass: false, detail: '' } },
    ]);
    expect([...got.keys()]).toEqual(['第二十七条']);
  });

  it('同一条文跨剧本合并，场次与次数都记下来', () => {
    const got = collectPending([
      { scenarioId: 'S02', verdict: pendingVerdict('第二十七条') },
      { scenarioId: 'S04', verdict: pendingVerdict('第二十七条') },
      { scenarioId: 'S04', verdict: pendingVerdict('第二十七条') },
    ]);
    const v = got.get('第二十七条')!;
    expect([...v.scenarios].sort()).toEqual(['S02', 'S04']);
    expect(v.hits).toBe(3);
  });

  it('连续未补则计数累加，到阈值触发升级告警', () => {
    let st = { streak: {} as Record<string, number> };
    for (let i = 1; i <= PENDING_ESCALATE_BATCHES; i++) st = updateStreaks(st, ['第二十七条'], `run-${i}`);
    expect(st.streak['第二十七条']).toBe(PENDING_ESCALATE_BATCHES);
  });

  // 【这条最容易漏】补上了却还在涨的计数，会把已解决的问题一直顶在告警里，
  // 而那正是"长期红灯"的另一种造法。
  it('**补卡到位后计数清零**，不再继续告警', () => {
    let st = updateStreaks({ streak: {} }, ['第二十七条'], 'run-1');
    st = updateStreaks(st, ['第二十七条'], 'run-2');
    expect(st.streak['第二十七条']).toBe(2);
    st = updateStreaks(st, [], 'run-3'); // 本批清单里已无此条 = 补上了
    expect(st.streak['第二十七条']).toBeUndefined();
  });

  it('同一批重复调用不重复累加', () => {
    const a = updateStreaks({ streak: {} }, ['第二十七条'], 'run-1');
    const b = updateStreaks(a, ['第二十七条'], 'run-1');
    expect(b.streak['第二十七条']).toBe(1);
  });
});

describe('清单机检预分拣：两栏按法域分', () => {
  const LIB = new Set(['劳动合同法', '劳动争议调解仲裁法']);

  it('该法在库、此条无原文 → 疑似真缺卡', () => {
    expect(classifyPending('劳动合同法', LIB)).toBe('missing_card');
  });

  // 【第二栏才是重点信号】该法整部不在库 = 模型往域外引，比缺卡严重得多，
  // 这类问题补卡是补不完的——该查的是模型为什么引到域外去。
  it('该法整部不在库 → 疑似引用不当（优先人核）', () => {
    expect(classifyPending('公司法', LIB)).toBe('out_of_domain');
  });

  it('取不到法名 → 法域未知，并入优先核而不是当作真缺卡', () => {
    expect(classifyPending(undefined, LIB)).toBe('law_unbound');
  });

  it('书名号与空格不影响归类', () => {
    expect(classifyPending('《劳动合同法》', LIB)).toBe('missing_card');
  });
});

describe('就近取法名', () => {
  it('取条号前最近的《法律名》', () => {
    const t = '依据《劳动合同法》第八十七条，公司应当支付赔偿金。';
    expect(nearestLaw(t, t.indexOf('第八十七条'))).toBe('劳动合同法');
  });

  it('前面有多部法时取**最近**那部（不是第一部）', () => {
    const t = '《劳动争议调解仲裁法》讲时效；《劳动合同法》第八十七条讲赔偿金。';
    expect(nearestLaw(t, t.indexOf('第八十七条'))).toBe('劳动合同法');
  });

  it('取不到就返回 null——宁可标"法域未知"，不猜', () => {
    const t = '第八十七条规定……';
    expect(nearestLaw(t, t.indexOf('第八十七条'))).toBeNull();
  });
});
