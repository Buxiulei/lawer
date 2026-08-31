/**
 * 圈层文案的低调模式判据。
 *
 * 【这块此前是怎么漏的】低调模式的两道遮蔽——正文糊层（data-veil）与打码块（Sensitive）——
 * 都没盖到节点抽屉里的圈层徽标，而那三句原文是「圈1·每日监控 / 圈2·每周监控 /
 * 圈3·仅快照存档不监控」。于是整页正文糊着的时候，**唯一还清晰可读的那行字里写着「监控」**。
 * 口径同 WatchEntry 与 lib/notify/copy 的守望计费通知：整块不出现「监控 / 守望 / 公司」。
 *
 * 【为什么判据落在这两处而不是整棵抽屉】抽屉整棵树在 Radix 的 Portal 后面、
 * SSR 渲染出空串（order-honesty 那份 393 判据也为此把 NodeSheet 排除在外），
 * 所以徽标单独导出来受判。抽屉正文里剩下的那些字另有归属：公司名在 Sensitive 里
 * （低调模式下打码，点按才看得见，本来就允许含「公司」二字），其余段落在 data-veil 里。
 *
 * 变异臂：把 GRAPH_TIER_LABELS 改回带「监控」的那三句（demo mock 同步改，否则
 * build.test 的双向咬合先红），本组第一条会红。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ discreet: false }));

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: state.discreet, setDiscreet: () => {}, toggle: () => {} }),
}));

import { mockCompanyGraph } from '@/app/_mock/company-graph';
import { GRAPH_TIER_LABELS, type GraphTier } from '@/lib/graph/contract';
import { TierBadge } from '../NodeSheet';

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const visibleText = (html: string) => html.replace(/<[^>]+>/g, '');

const NEVER = ['监控', '守望', '公司'];
const TIERS: GraphTier[] = [1, 2, 3];

describe('圈层文案：两处事实源都不含「监控 / 守望 / 公司」', () => {
  it('唯一事实源与 demo mock 的三句都干净', () => {
    for (const [where, dict] of [
      ['contract', GRAPH_TIER_LABELS],
      ['mock', mockCompanyGraph.meta.tiers],
    ] as const) {
      for (const tier of TIERS) {
        for (const word of NEVER) {
          expect(`${where}/${tier}:${dict[tier].includes(word)}`).toBe(`${where}/${tier}:false`);
        }
      }
    }
  });

  /** 圈层说的是「我们多久看一次」，换掉「监控」之后这层意思一个字都没丢。 */
  it('三句仍各自说得出节奏，不是被删成空话', () => {
    expect(GRAPH_TIER_LABELS[1]).toContain('每天');
    expect(GRAPH_TIER_LABELS[2]).toContain('每周');
    expect(GRAPH_TIER_LABELS[3]).toContain('快照');
  });
});

describe('抽屉里的圈层徽标', () => {
  /**
   * 变异臂：给 TierBadge 加一条 `discreet ? … : …` 的分支（低调模式另写一版文案），
   * 这条会红——一句话两个版本，漂了没有任何一处会报错。
   */
  it('低调模式与明文模式渲染逐字相同的一句，且都不含那三个词', () => {
    for (const tier of TIERS) {
      const plain = ssr(<TierBadge tier={tier} labels={GRAPH_TIER_LABELS} />);
      state.discreet = true;
      let discreet: string;
      try {
        discreet = ssr(<TierBadge tier={tier} labels={GRAPH_TIER_LABELS} />);
      } finally {
        state.discreet = false;
      }
      expect(discreet).toBe(plain);
      const text = visibleText(discreet);
      expect(text).toContain(GRAPH_TIER_LABELS[tier]);
      for (const word of NEVER) {
        expect(`${tier}:${text.includes(word)}`).toBe(`${tier}:false`);
      }
    }
  });

  /**
   * 变异臂：把徽标里的 `{labels[tier]}` 换成写死的字面量，这条会红。
   * 界面另挑一套文案的那天，唯一事实源就管不住屏幕上写的是什么了。
   */
  it('徽标的字来自传进来的字典，不是组件自己挑的', () => {
    const custom: Record<GraphTier, string> = { 1: '甲', 2: '乙', 3: '丙' };
    expect(visibleText(ssr(<TierBadge tier={2} labels={custom} />))).toContain('乙');
  });
});
