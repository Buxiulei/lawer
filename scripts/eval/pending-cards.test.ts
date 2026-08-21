// scripts/eval/pending-cards.test.ts
// 补卡闭环的执行物。清单本身也需要被测试守住——否则"我们有清单"会变成又一条
// 没有执行物的经验（见 README 开篇纪律）。
import { describe, expect, it } from 'vitest';

import { collectPending, PENDING_ESCALATE_BATCHES, updateStreaks } from './pending-cards';
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
