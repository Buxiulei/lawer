/**
 * F-206：两种揭开手势必须在屏幕上分得开。
 *
 * 低调模式下站内有两套打码块，外观都是一层糊、手势却相反：
 *   `<Sensitive>` 点一下显示 3 秒；`[data-veil]` 按住 ≥150ms 才揭开。
 * 快速点一下糊层是「什么都不发生」，这一下和「页面坏了」在屏幕上长得一模一样。
 *
 * 这一组钉三件事：
 *   1. 两种块在低调模式下各自写着**自己那一种**手势（互换就红）；
 *   2. 常规模式下一个提示都不出（反向对照：提示是低调模式的东西，不是常驻装饰）；
 *   3. 这些提示字样里没有一个案情词——它们是低调模式下清晰可读的字，
 *      词表从 _ui/neutral import，不手抄。
 *
 * 【为什么两处提示的挂法不一样】糊层是 filter 打在块自己身上，filter 对整棵子树
 * （含伪元素）一视同仁——贴在糊块上的角标会跟着糊掉，糊掉的角标等于没有。
 * 所以糊层那句由手势层 DiscreetVeil 出，落在糊块外面。详见 _ui/revealHint。
 *
 * 【为什么还要一条源码守卫】上面四条走的是 renderToStaticMarkup：那条路上任何
 * 「读 localStorage 决定收不收起来」的闸都读不到值，于是**加了闸也照样全绿**。
 * 复核实测过这一幕——给糊层提示加一道「真按住揭开过一次就永久退场」，
 * 单测五条不动声色，真机上老用户的 [data-veil] 块又回到零视觉区分（F-206 原样）。
 * 所以下面单独钉一条：这一句的闸**只有低调模式一道**，不许再挂第二道。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CASE_WORDS } from '@/app/_ui/neutral';
import { DISCREET_ON_HINT, HOLD_HINT, TAP_HINT } from '@/app/_ui/revealHint';
import { allText } from '@/app/_ui/__tests__/unveiled';

const ui = { discreet: false };
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: ui.discreet, setDiscreet: () => {}, toggle: () => {} }),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => () => {} }));

const { Sensitive } = await import('@/components/Sensitive');
const { DiscreetVeil } = await import('@/app/_ui/veil');

const sensitiveHtml = () => renderToStaticMarkup(<Sensitive>12,345 元</Sensitive>);
const veilLayerHtml = () => renderToStaticMarkup(<DiscreetVeil />);

beforeEach(() => {
  ui.discreet = false;
});

describe('低调模式：点一下的块和按住的块，屏幕上写的不是同一句', () => {
  it('单字段打码块写着「点一下看清」，不写按住那一句', () => {
    ui.discreet = true;
    const t = allText(sensitiveHtml());
    expect(
      t.includes('点一下看清'),
      '缺什么：低调模式下 <Sensitive>（金额、公司名那种单字段打码）没有写出它的手势。\n' +
        '为什么缺：站内另有一套整块糊层，外观一样但要按住才揭开。两种块都不写字，' +
        '用户只能靠试——点糊层什么都不发生，那一下和「页面坏了」长得一模一样。\n' +
        '怎么办：角标字样收在 _ui/revealHint 的 TAP_HINT，Sensitive 在低调模式下渲染它；' +
        '注意糊要打在内层 span，角标落在被糊的元素里会跟着糊掉。',
    ).toBe(true);
    expect(
      t.includes('按住看清'),
      '缺什么：单字段打码块上写着「按住看清」——那是另一种块的手势。\n' +
        '为什么缺：这种块 onClick 一下就显示 3 秒，按住反而什么都不发生；' +
        '写错手势比不写更糟，用户会照着做然后判定坏了。\n' +
        '怎么办：TAP_HINT 与 HOLD_HINT 别写反（_ui/revealHint）。',
    ).toBe(false);
  });

  it('整块糊层的手势提示写着「按住看清」，不写点一下那一句', () => {
    ui.discreet = true;
    const t = allText(veilLayerHtml());
    expect(
      t.includes('按住看清'),
      '缺什么：低调模式下没有任何地方写出糊层的手势（按住 ≥150ms 才揭开）。\n' +
        '为什么缺：糊层占了正文的绝大部分，而快速点一下它毫无反应；' +
        '不写字，用户没有办法知道该换个手势再试一次。\n' +
        '怎么办：手势层 DiscreetVeil 在低调模式下渲染 HOLD_HINT（_ui/revealHint）。' +
        '这句必须落在糊块**外面**——filter 会把贴在糊块上的角标一起糊掉。',
    ).toBe(true);
    expect(
      t.includes('点一下看清'),
      '缺什么：糊层的提示写成了「点一下看清」——点一下正是这种块唯一不生效的手势。\n' +
        '为什么缺：150ms 以下的按压被当成滚动划过，一律不揭。\n' +
        '怎么办：TAP_HINT 与 HOLD_HINT 别写反（_ui/revealHint）。',
    ).toBe(false);
  });

  it('开启低调模式那一句 toast 把两种手势都说到', () => {
    for (const word of ['按住看清', '点一下看清']) {
      expect(
        DISCREET_ON_HINT.includes(word),
        `缺什么：开启低调模式的提示里没有「${word}」。\n` +
          '为什么缺：这句话是用户唯一一次被主动告知怎么揭开。只说一种手势，' +
          '他会拿这一种去试另一种块，试不动就以为坏了——F-206 报的正是这个。\n' +
          '怎么办：DISCREET_ON_HINT 由 TAP_HINT 与 HOLD_HINT 拼出来（_ui/revealHint），别拆开各写各的。',
      ).toBe(true);
    }
  });

  it('反向对照：常规模式下两种块都不出提示，内容照常渲染', () => {
    ui.discreet = false;
    const s = allText(sensitiveHtml());
    const v = allText(veilLayerHtml());
    expect(s).toContain('12,345元'); // allText 会把空白压掉 // 提示没了，内容不能跟着没
    for (const hint of [TAP_HINT, HOLD_HINT]) {
      expect(
        s.includes(hint) || v.includes(hint),
        `缺什么：常规模式下屏幕上还挂着「${hint}」。\n` +
          '为什么缺：没打码的东西不需要教人怎么揭开，常驻一句提示是纯噪音，' +
          '还会让人以为自己开着低调模式。\n' +
          '怎么办：两处提示都以 discreet 为闸，关掉就不渲染。',
      ).toBe(false);
    }
  });

  it('两句提示里没有一个案情词——它们在低调模式下是清晰可读的', () => {
    for (const word of CASE_WORDS) {
      for (const [name, text] of [
        ['TAP_HINT', TAP_HINT],
        ['HOLD_HINT', HOLD_HINT],
        ['DISCREET_ON_HINT', DISCREET_ON_HINT],
      ] as const) {
        expect(
          text.includes(word),
          `缺什么：${name} 里写着「${word}」。\n` +
            '为什么缺：这三句都是低调模式下不糊、清晰可读的字（角标要能读才有用），' +
            '写进案情词等于把低调模式自己泄了。\n' +
            '怎么办：换成中性说法；词表见 _ui/neutral 的 CASE_WORDS。',
        ).toBe(false);
      }
    }
  });
});

describe('F-206 守卫：糊层那句提示的闸只有低调模式一道', () => {
  const src = readFileSync(join(__dirname, '..', 'veil.tsx'), 'utf8');

  it('DiscreetVeil 的渲染闸就是 !discreet，没有第二个条件', () => {
    const gates = [...src.matchAll(/if \(([^)]*)\) return null;/g)].map((m) => m[1]);
    expect(
      gates,
      '缺什么：DiscreetVeil 的「不渲染」条件不再是单一的 !discreet。\n' +
        '为什么缺：这一句是「两种块各自写明手势」的糊层那一半。给它加任何第二道闸' +
        '（用过一次就退场、看够 N 次就收起…），对被这道闸挡住的人来说，同屏两种糊块' +
        '就又回到零视觉区分——F-206 报的正是那一幕，而这类「用过即退场」的产品裁决' +
        '台账上没有记过。上面几条走 SSR，读不到 localStorage，加了闸也全绿，抓不住。\n' +
        '怎么办：闸写成 if (!discreet) return null;；真要收起来，先把裁决写进台账。',
    ).toEqual(['!discreet']);
  });

  it('veil.tsx 只持久化「开启时提示说过没有」这一个键', () => {
    const keys = [...src.matchAll(/'(lawer\.[\w.]+)'/g)].map((m) => m[1]).sort();
    expect(
      keys,
      '缺什么：veil.tsx 里多出了一个本地存储键。\n' +
        '为什么缺：这个文件里唯一该记住的是「开启低调模式那句 toast 说过没有」' +
        '（lawer.veilHint）。再记一个「手势用过没有」，就等于把上一条守卫绕开——' +
        '闸不写在 return 那一行，改写成读盘算出来的一个变量。\n' +
        '怎么办：手势提示不按用户用没用过收起来；要改先过台账。',
    ).toEqual(['lawer.veilHint']);
  });
});
