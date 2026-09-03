/**
 * 在飞占位（同一个人一次只答一轮）的本地判据。
 *
 * 「拦不拦」由路由用例按行为钉（chat/__tests__/route.test.ts 那一组并发判据）；
 * 这里只钉两样它们看不见的东西：占位的释放语义，和**对外那句话说了什么**。
 *
 * 【变异臂】
 *  · M-C5 文案里放回「（或者点停止）」 ⇒ 「不提点停止」那条红
 *  · 释放函数改成非幂等（去掉 released 判断）⇒ 「叫两次不误伤后一轮」红
 */
import { afterEach, describe, expect, it } from 'vitest';

import { beginTurn, isTurnInFlight, turnInFlightMessage } from '../in-flight';

/** 进程内的一格是模块级状态，用例之间必须还干净 */
const held: Array<() => void> = [];
const hold = (userId: number) => {
  const release = beginTurn(userId);
  held.push(release);
  return release;
};
afterEach(() => {
  while (held.length) held.pop()!();
});

describe('对外那句话', () => {
  /**
   * 【为什么「点停止」不能留在这句话里】停止只是客户端 abort：连接断了，
   * 服务端那一轮照跑到完，占位也要等它跑完才还回来。所以他点了停止、立刻再问，
   * 撞到的还是同一句 409——而这次他会以为是产品坏了。
   * 教一个不管用的动作，比什么都不教更伤。
   */
  it('★不提「点停止」：停止只是客户端 abort，服务端那一轮照跑到完', () => {
    expect(turnInFlightMessage(), '把「停止」写成出路 = 教他做一件不管用的事').not.toContain(
      '停止',
    );
  });

  it('自述三段式：怎么了 / 为什么 / 怎么办', () => {
    const msg = turnInFlightMessage();
    expect(msg, '怎么了').toContain('上一轮还在答');
    expect(msg, '为什么').toContain('答完才结算');
    expect(msg, '怎么办').toContain('答完');
  });
});

describe('占位与释放', () => {
  it('占上之后就在飞，还回去之后就不在了', () => {
    expect(isTurnInFlight(7), '开局就占着 ⇒ 下面全是空过').toBe(false);
    const release = hold(7);
    expect(isTurnInFlight(7)).toBe(true);
    release();
    expect(isTurnInFlight(7)).toBe(false);
  });

  /**
   * 释放函数只还**自己那一次**：路由里 finally 可能与别处重复叫到它，
   * 而那时后一轮往往已经占上了——不幂等就会把后一轮的格子顺手删掉，
   * 于是这个人真的能同时跑两轮，且并发判据在慢的机器上仍可能碰巧全绿。
   */
  it('★叫两次不会把后一轮刚占上的格子顺手删掉', () => {
    const first = hold(9);
    first();
    hold(9); // 后一轮占上
    first(); // 前一轮的释放又被叫了一次
    expect(isTurnInFlight(9), '幂等丢了 ⇒ 这个人同时跑得了两轮').toBe(true);
  });
});
