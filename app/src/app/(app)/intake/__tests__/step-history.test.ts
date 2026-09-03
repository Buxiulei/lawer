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
 *   ③ 草稿恢复到第 N 步时也要把 N 个条目铺上，否则返回键第一下照样直接出去；
 *   ④ 清空重填之后，栈也退回第一格——只改栈顶的话，返回一下弹回的是
 *      「第 2 / 6 步」的一张空表单，②那一条当场失效（复核 MF-1）。
 *   ⑦ 同一副栈上再铺一次不多出条目——F5 / 跳走再返回 / 二进 /intake 都会让组件
 *      重新挂载而栈还是上一轮那副，再铺一遍就叠成 [1,0,1,0]：第 1 步返回弹回第 2 步，
 *      退出要按 4 下（复核 MF-3，修 F-208 引入的新缺陷）。
 *   ⑧ 条目比草稿浅时补齐差的那几格——「铺过就整个不管」会让屏幕上第 3 步而栈里 2 格，
 *      清空重填按屏幕步数退栈就把人退出了向导（实测 afterReset 落到 /account）。
 *   ⑨ 条目比草稿**深**时退掉多的那几格——完成向导（清草稿 + 跳驾驶舱）后按返回回来，
 *      或另一处清了草稿本页再 F5：屏幕第 1 步而条目还写着第 5 步。补格那条路在这里是
 *      空转，不退栈的话返回键要逐级弹回第 5→4→3→2→1 步的空表单，按满 6 下才离开
 *      （复核 MF-4，真机 I6 backs=6 / I7 backs=3）。
 * 外加一条接线守卫：IntakeFlow 真的用了这几个函数——纯函数全绿而组件没调，
 * 和没修一模一样。
 *
 * 变异臂：
 *   · pushStepHistory 改成 replaceState（不 pushState）→ ①③红
 *   · resetStepHistory 改回「只改写栈顶」（replaceState 第 0 步）→ ④红
 *   · seedStepHistory 从头铺（不看当前条目铺到第几步）→ ⑦红
 *   · seedStepHistory 铺过就整个 return（不补差的那几格）→ ⑧红
 *   · seedStepHistory 去掉「条目比草稿深就退栈」那一支 → ⑨红
 *   · IntakeFlow 里删掉 pushStepHistory 那一行 → 接线守卫红
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  STEP_STATE_KEY,
  pushStepHistory,
  resetStepHistory,
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
  /** 退了几格：go(0) 在真浏览器里是刷新当前页，所以「调没调、调的几」都要看得见。 */
  goCalls: number[] = [];
  go(delta: number): void {
    this.goCalls.push(delta);
    this.i = Math.max(0, Math.min(this.entries.length - 1, this.i + delta));
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

  it('清空重填之后再按返回，是离开向导，不是弹回一张空表单', () => {
    const h = new FakeHistory();
    seedStepHistory(h, 0);
    pushStepHistory(h, 1);
    pushStepHistory(h, 2); // 用户填到第 3 步
    resetStepHistory(h, 2); // 点「清空重填」

    expect(stepFromHistoryState(h.state), '清空后当前条目该是第 1 步').toBe(0);
    expect(
      stepFromHistoryState(h.back()),
      '缺什么：清空重填之后按一下返回，弹出来的还是向导内部的某一步。\n' +
        '为什么缺：只把栈顶改写成第 1 步的话，栈里下面那几格还写着第 1、2 步——' +
        '返回一下就回到「第 2 / 6 步」的一张空表单，四个输入框全空。' +
        '用户刚说了「清空重填」，屏幕上却退到了半截；' +
        '而且「第 1 步返回才离开」这条当场失效（复核 MF-1 实测到的正是这一幕）。\n' +
        '怎么办：清空时调 resetStepHistory 退回第一格，别只 replaceState 栈顶。',
    ).toBe(null);
  });

  it('第 1 步上清空重填，一格都不退（go(0) 在浏览器里是刷新当前页）', () => {
    const h = new FakeHistory();
    seedStepHistory(h, 0);
    resetStepHistory(h, 0);
    expect(
      h.goCalls,
      '缺什么：第 1 步点清空重填也调了 history.go。\n' +
        '为什么缺：这时栈里本来就只有第 1 步那一格，没有要退的；' +
        '而 go(0) 不是「不动」，是**刷新当前页**——用户会看见整页白闪一下。\n' +
        '怎么办：resetStepHistory 里 step > 0 才退。',
    ).toEqual([]);
    expect(stepFromHistoryState(h.state), '当前条目照旧是第 1 步').toBe(0);
    expect(stepFromHistoryState(h.back()), '再返回一下照旧该离开').toBe(null);
  });

  it('重新挂载后再铺一次：不多出条目，返回序列照旧 1 → 0 → 离开', () => {
    const h = new FakeHistory();
    seedStepHistory(h, 0);
    pushStepHistory(h, 1);
    pushStepHistory(h, 2); // 用户走到第 3 步
    const len = h.length;

    // F5 / 点站内链接跳走再返回 / 同标签页第二次进 /intake：组件重新挂载，
    // 又按当前步数铺了一次，而栈还是上面那副（当前条目自己写着第 3 步）。
    seedStepHistory(h, 2);

    expect(
      h.length - len,
      '缺什么：在已经铺过的那副栈上又铺了一遍，栈里多出 ' + (h.length - len) + ' 格。\n' +
        '为什么缺：history state 跨刷新、跨前进后退都留着，而组件会重新挂载好几次' +
        '（F5、跳走再返回、同标签页二进 /intake）。再铺一遍是在原来那段上面叠出第二段' +
        '[0,1,…]，栈成了 [1,0,1,0]：第 1 步按返回不但没离开，还弹回上一段的第 2 步，' +
        '要按 4 下才出得去（复核 MF-3；这是修 F-208 引入的新缺陷，基线一按返回即离开）。\n' +
        '怎么办：seedStepHistory 开头先 stepFromHistoryState(h.state)，读得出步数' +
        '就说明这副栈已经铺过，一格都不再压。',
    ).toBe(0);

    expect(stepFromHistoryState(h.state), '重挂载不该改动当前条目的步数').toBe(2);
    expect(stepFromHistoryState(h.back()), '返回一下该回到第 2 步').toBe(1);
    expect(stepFromHistoryState(h.back()), '再返回一下该回到第 1 步').toBe(0);
    expect(
      stepFromHistoryState(h.back()),
      '缺什么：第 1 步之后还有第四格向导条目，用户按第 4 下才出得去。\n' +
        '为什么缺：那正是重复铺栈叠出来的第二段——退出向导的按键数跟着挂载次数涨。\n' +
        '怎么办：同上，已铺过的栈不再铺。',
    ).toBe(null);
  });

  it('条目比草稿浅一格：补上差的那一格，栈深仍等于步数', () => {
    const h = new FakeHistory();
    seedStepHistory(h, 0);
    pushStepHistory(h, 1); // 栈铺到第 2 步（条目写着 1）
    const len = h.length;

    // 同一个标签页再打开一次 /intake：浏览器按「重载当前 URL」处理，条目连同
    // 它的步数原样留着，而草稿恢复出来的是第 3 步——两边差一格。
    seedStepHistory(h, 2);

    expect(
      h.length - len,
      '缺什么：条目写着第 2 步、草稿恢复到第 3 步，差的那一格没补。\n' +
        '为什么缺：屏幕上是第 3 步而栈里只有 2 格，「栈深＝步数」这条不变量断了。' +
        '这时点「清空重填」，resetStepHistory 按屏幕上的步数退 2 格，' +
        '退过了头——用户直接被弹出向导（实测 afterReset 落到 /account）。\n' +
        '怎么办：铺过的栈只补差的那几格（从条目里那个数 +1 铺到 step），一格不重复。',
    ).toBe(1);
    expect(stepFromHistoryState(h.state), '补完当前条目该写着第 3 步').toBe(2);

    resetStepHistory(h, 2); // 点「清空重填」
    expect(stepFromHistoryState(h.state), '清空后该退回第一格').toBe(0);
    expect(stepFromHistoryState(h.back()), '再返回一下才离开向导').toBe(null);
  });

  it('条目比草稿深：退掉多出来的那几格，之后返回一下就离开向导', () => {
    const h = new FakeHistory();
    seedStepHistory(h, 0);
    pushStepHistory(h, 1);
    pushStepHistory(h, 2); // 用户填到第 3 步
    const len = h.length;

    // 完成向导（清草稿 + 跳驾驶舱）之后按返回回到 /intake，或另一个标签页把草稿
    // 清了本页再 F5：草稿没了、屏幕回到第 1 步，而条目还写着第 3 步。
    seedStepHistory(h, 0);

    expect(
      h.goCalls,
      '缺什么：条目写着第 3 步、屏幕上是第 1 步，多出来的 2 格一格都没退。\n' +
        '为什么缺：补格那条路在这里是空转（要补的那几格全在身后），' +
        '于是这一支什么都没做——屏幕第 1 步，栈里却还压着第 2、3 步。' +
        '按返回不是离开向导，而是逐级弹回第 3、第 2 步的**空表单**' +
        '（草稿已经清了，弹回去的每一格都是空的），要按满 4 下才出得去；' +
        '真机上第 6 步完成向导那一路是 6 下（复核 MF-4，I6 backs=6 / I7 backs=3）。\n' +
        '怎么办：seedStepHistory 里 seeded > step 时 h.go(step - seeded)，' +
        '把栈退到与屏幕同步的那一格；多出来的几格留在前进方向上，下次 push 自会截断。',
    ).toEqual([-2]);
    expect(h.length - len, '退栈不是压条目，一格都不该多').toBe(0);
    expect(stepFromHistoryState(h.state), '退完当前条目该是第 1 步，与屏幕一致').toBe(0);
    expect(
      stepFromHistoryState(h.back()),
      '缺什么：退栈之后再按返回，弹出来的还是向导内部的某一步。\n' +
        '为什么缺：那说明只退了一部分，「第 1 步返回才离开」照旧失效。\n' +
        '怎么办：退的格数正好是 seeded - step，不多不少。',
    ).toBe(null);
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
    [
      'resetStepHistory(',
      '清空重填只改栈顶，栈里下面几格还写着第 2、3 步，返回一下弹回一张空表单',
    ],
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
