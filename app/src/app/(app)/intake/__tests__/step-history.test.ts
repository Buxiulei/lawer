/**
 * F-208：首诊向导里按浏览器返回键，应该退回上一步，而不是弹出整个向导。
 *
 * 报的现象：/intake 选完阶段点「下一步」进第 2 步，按返回 → 直接跳出 /intake
 * 回到上一个页面，没有任何提示。草稿不丢，但那一下很吓人。
 * 根因：6 步全在同一个 URL 上，步数只活在 React state 里，一个 history 条目都没压。
 *
 * 这一组拿一个假历史栈把三件事逐条量出来（测试环境里没有浏览器）：
 *   ① 每前进一步压一个条目 → 返回键逐级退回；
 *   ② 第 1 步再往回，弹出来的是**向导压之前**那个条目 → 读不出步数 → 该离开；
 *   ③ 草稿恢复到第 N 步时也要把 N 个条目铺上，否则返回键第一下照样直接出去。
 * 外加一条接线守卫：IntakeFlow 真的用了这几个函数——纯函数全绿而组件没调，
 * 和没修一模一样。
 *
 * 变异臂：
 *   · pushStepHistory 改成 replaceState（不 pushState）→ ①③红
 *   · IntakeFlow 里删掉 pushStepHistory 那一行 → 接线守卫红
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  STEP_STATE_KEY,
  pushStepHistory,
  seedStepHistory,
  stepFromHistoryState,
  type HistoryLike,
} from '../_components/stepHistory';

/** 进 /intake 之前那一页留下的条目：它的 state 里没有向导的键。 */
const FOREIGN = { key: 'prev-page' };

class FakeHistory implements HistoryLike {
  entries: unknown[] = [FOREIGN, null];
  i = 1; // 当前停在 /intake 这一条

  get state(): unknown {
    return this.entries[this.i];
  }
  get length(): number {
    return this.entries.length;
  }
  pushState(state: unknown): void {
    this.entries = this.entries.slice(0, this.i + 1);
    this.entries.push(state);
    this.i += 1;
  }
  replaceState(state: unknown): void {
    this.entries[this.i] = state;
  }
  /** 模拟返回键：退一格，返回那一格的 state（就是 popstate 事件里的 e.state）。 */
  back(): unknown {
    if (this.i > 0) this.i -= 1;
    return this.state;
  }
}

describe('F-208 向导的历史栈：一步一个条目', () => {
  it('走到第 3 步压了 2 个条目，返回键逐级退回 1 → 0', () => {
    const h = new FakeHistory();
    const before = h.length;
    seedStepHistory(h, 0);
    expect(h.length, 'seed 第 1 步只改写当前条目，不该凭空多出一格').toBe(before);
    expect(stepFromHistoryState(h.state)).toBe(0);

    pushStepHistory(h, 1);
    pushStepHistory(h, 2);
    expect(
      h.length - before,
      '缺什么：从第 1 步走到第 3 步，history 里一个条目都没多。\n' +
        '为什么缺：向导 6 步共用一个 URL，不压条目，返回键第一下弹掉的就是整个 /intake——' +
        '用户以为回上一步，实际跳出向导（F-208）。\n' +
        '怎么办：前进一步调一次 pushStepHistory（别改成 replaceState，那是原地改写）。',
    ).toBe(2);

    expect(stepFromHistoryState(h.back()), '返回一下该回到第 2 步').toBe(1);
    expect(stepFromHistoryState(h.back()), '再返回一下该回到第 1 步').toBe(0);
  });

  it('第 1 步再按返回，弹出来的是向导之外那一条 → 读不出步数 → 该离开', () => {
    const h = new FakeHistory();
    seedStepHistory(h, 0);
    pushStepHistory(h, 1);
    h.back(); // 回到第 1 步
    expect(
      stepFromHistoryState(h.back()),
      '缺什么：第 1 步再往回，仍然被当成向导内部的一步。\n' +
        '为什么缺：那样用户就出不去了——返回键在向导里成了死循环。\n' +
        '怎么办：读不出步数就返回 null，组件据此什么都不做，让浏览器照常离开。',
    ).toBe(null);
  });

  it('草稿恢复到第 3 步时，也要把 2 个条目铺上', () => {
    const h = new FakeHistory();
    const before = h.length;
    seedStepHistory(h, 2);
    expect(
      h.length - before,
      '缺什么：草稿恢复到第 3 步，历史栈里却一个条目都没有。\n' +
        '为什么缺：那种情况下返回键第一下还是直接离开向导，跟没修一样，' +
        '而它恰恰是最常见的一种进入方式（关掉页面回来接着填）。\n' +
        '怎么办：hydrate 之后按当前步数调 seedStepHistory。',
    ).toBe(2);
    expect(stepFromHistoryState(h.state)).toBe(2);
    expect(stepFromHistoryState(h.back())).toBe(1);
  });

  it('反向对照：非本向导压的 state 一律读成 null，不瞎猜', () => {
    for (const junk of [null, undefined, {}, { [STEP_STATE_KEY]: '2' }, { [STEP_STATE_KEY]: -1 }, 42]) {
      expect(stepFromHistoryState(junk)).toBe(null);
    }
  });
});

describe('F-208 接线守卫：组件真的用上了这几个函数', () => {
  const src = readFileSync(
    join(__dirname, '..', '_components', 'IntakeFlow.tsx'),
    'utf8',
  );

  for (const [name, why] of [
    ['seedStepHistory(', '草稿恢复到第 N 步时不铺条目，返回键第一下照样直接出去'],
    ['pushStepHistory(', '前进不压条目，返回键弹掉的就是整个向导——F-208 的原样复现'],
    ['stepFromHistoryState(', '不读 popstate 里的步数，返回键退回来了页面却还停在原处'],
    ["addEventListener('popstate'", '不听 popstate，浏览器退了一格，React 里的步数纹丝不动'],
  ] as const) {
    // 认**调用形态**不认名字：只 import 不调用的那一版，import 行里照样有这个名字。
  it(`IntakeFlow 里真的调了 ${name}`, () => {
      expect(
        src.includes(name),
        `缺什么：IntakeFlow.tsx 里找不到 ${name}。\n` +
          `为什么缺：${why}。这条守卫存在是因为纯函数那几条可以全绿而组件根本没调——` +
          '两种情况在测试报告上长得一模一样。\n' +
          '怎么办：见 _components/stepHistory.ts 的文件头。',
      ).toBe(true);
    });
  }
});
